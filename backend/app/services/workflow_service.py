from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    AgentVersionStatus,
    BorrowerStatus,
    CallAttemptStatus,
    CallDirection,
    ConsentStatus,
    ConversationState,
    EventType,
    ScheduledActionType,
    ScheduledActionStatus,
    WorkflowExecutionStatus,
    WorkflowType,
)
from app.core.errors import NotFoundError, ValidationError
from app.models import (
    AgentVersion,
    Borrower,
    BorrowerContactPoint,
    CallAttempt,
    ContactPoint,
    Conversation,
    Loan,
    ScheduledAction,
    WorkflowExecution,
)
from app.schemas.calls import StartCallRequest, StartCallResponse
from app.services.conversation_store import append_event
from app.services.observability import metrics

logger = logging.getLogger("feather_lite.workflow")

INITIAL_GREETING = (
    "This is Feather-Lite Collections. This is an attempt to collect a debt, "
    "and any information obtained will be used for that purpose. "
    "This call may be recorded. May I speak with the borrower on the account?"
)


async def ensure_active_agent_version(session: AsyncSession) -> AgentVersion:
    agent_version = await session.scalar(
        select(AgentVersion).where(AgentVersion.status == AgentVersionStatus.ACTIVE)
    )
    if agent_version is not None:
        return agent_version

    agent_version = AgentVersion(
        name="collections-v1",
        prompt_hash="bootstrap",
        status=AgentVersionStatus.ACTIVE,
    )
    session.add(agent_version)
    await session.flush()
    return agent_version


async def start_call(
    session: AsyncSession,
    request: StartCallRequest,
    *,
    commit: bool = True,
    workflow_execution_id: UUID | None = None,
    workflow_type: WorkflowType = WorkflowType.PAYMENT_REMINDER,
    now: datetime | None = None,
) -> StartCallResponse:
    effective_now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    borrower = await session.scalar(
        select(Borrower).where(Borrower.id == request.borrower_id).with_for_update()
    )
    if borrower is None:
        raise NotFoundError("Borrower not found")

    contact_point = await session.get(ContactPoint, request.contact_point_id)
    if contact_point is None:
        raise NotFoundError("Contact point not found")

    borrower_contact_link = await session.scalar(
        select(BorrowerContactPoint).where(
            BorrowerContactPoint.borrower_id == borrower.id,
            BorrowerContactPoint.contact_point_id == contact_point.id,
        )
    )
    if borrower_contact_link is None:
        raise ValidationError("CONTACT_POINT_NOT_ASSOCIATED")

    loan = await session.scalar(
        select(Loan)
        .where(Loan.borrower_id == borrower.id)
        .order_by(Loan.delinquency_days.desc(), Loan.due_date.asc(), Loan.id.asc())
    )
    if loan is None:
        raise ValidationError("Borrower has no loan")

    validation_failures = await _validate_pre_call(
        session,
        borrower,
        contact_point,
        now=effective_now,
    )
    if validation_failures:
        raise ValidationError(",".join(validation_failures))

    agent_version = await ensure_active_agent_version(session)

    workflow = await _resolve_workflow_execution(
        session,
        borrower_id=borrower.id,
        loan_id=loan.id,
        workflow_execution_id=workflow_execution_id,
        workflow_type=workflow_type,
    )
    workflow.status = WorkflowExecutionStatus.RUNNING
    workflow.scheduled_for = None
    attempt_no = await _increment_workflow_attempt_no(session, workflow.id)

    attempt = CallAttempt(
        workflow_execution_id=workflow.id,
        contact_point_id=contact_point.id,
        direction=CallDirection.OUTBOUND,
        attempt_status=CallAttemptStatus.INITIATED,
        started_at=effective_now,
    )
    session.add(attempt)
    await session.flush()

    conversation = Conversation(
        call_attempt_id=attempt.id,
        borrower_id=borrower.id,
        agent_version_id=agent_version.id,
        started_at=effective_now,
        channel=request.channel,
        final_outcome_metadata={},
        protected_context_unlocked=False,
    )
    session.add(conversation)
    await session.flush()

    await append_event(
        session,
        conversation.id,
        EventType.CALL_STARTED,
        {
            "workflow_execution_id": str(workflow.id),
            "call_attempt_id": str(attempt.id),
            "contact_point_id": str(contact_point.id),
            "channel": conversation.channel,
            "attempt_no": attempt_no,
        },
        created_at=effective_now,
    )
    await append_event(
        session,
        conversation.id,
        EventType.STATE_TRANSITION,
        {"from": None, "to": ConversationState.GREETING.value, "triggered_by": "SYSTEM_START"},
        created_at=effective_now,
    )
    await append_event(
        session,
        conversation.id,
        EventType.AGENT_TURN,
        {
            "text": INITIAL_GREETING,
            "state": ConversationState.GREETING.value,
        },
        created_at=effective_now,
    )
    if commit:
        await session.commit()
    metrics.increment("calls_started", labels={"channel": request.channel})
    logger.info(
        "call_started",
        extra={
            "conversation_id": str(conversation.id),
            "workflow_execution_id": str(workflow.id),
            "call_attempt_id": str(attempt.id),
            "event_type": EventType.CALL_STARTED.value,
        },
    )

    return StartCallResponse(
        conversation_id=str(conversation.id),
        workflow_execution_id=str(workflow.id),
        call_attempt_id=str(attempt.id),
    )


async def _validate_pre_call(
    session: AsyncSession,
    borrower: Borrower,
    contact_point: ContactPoint,
    *,
    now: datetime | None = None,
) -> list[str]:
    failures: list[str] = []

    if borrower.status == BorrowerStatus.OPT_OUT:
        failures.append("BORROWER_OPT_OUT")

    if contact_point.consent_status == ConsentStatus.OPTED_OUT or not contact_point.is_valid:
        failures.append("CONTACT_POINT_INVALID_OR_OPTED_OUT")

    tz_name = contact_point.timezone_override or borrower.timezone
    utc_now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    try:
        local_now = utc_now.astimezone(ZoneInfo(tz_name))
    except ZoneInfoNotFoundError:
        logger.warning("invalid_timezone_fallback timezone=%s borrower_id=%s", tz_name, borrower.id)
        local_now = utc_now
    if local_now.hour < 8 or local_now.hour >= 21:
        failures.append("TCPA_TIME_WINDOW")

    recent_attempts = await session.scalar(
        select(func.count(CallAttempt.id))
        .join(WorkflowExecution, WorkflowExecution.id == CallAttempt.workflow_execution_id)
        .where(
            WorkflowExecution.borrower_id == borrower.id,
            CallAttempt.contact_point_id == contact_point.id,
            CallAttempt.started_at >= utc_now - timedelta(days=7),
        )
    )
    if recent_attempts and recent_attempts >= 7:
        failures.append("FREQUENCY_CAP")

    active_conversation = await session.scalar(
        select(Conversation.id).where(
            Conversation.borrower_id == borrower.id,
            Conversation.ended_at.is_(None),
            Conversation.final_outcome.is_(None),
        )
    )
    if active_conversation is not None:
        failures.append("ACTIVE_CONVERSATION")

    conflicting_actions = await session.scalar(
        select(func.count(ScheduledAction.id))
        .join(
            WorkflowExecution,
            WorkflowExecution.id == ScheduledAction.workflow_execution_id,
        )
        .where(
            WorkflowExecution.borrower_id == borrower.id,
            ScheduledAction.status == ScheduledActionStatus.PENDING,
            ScheduledAction.action_type != ScheduledActionType.HUMAN_FOLLOWUP,
        )
    )
    if conflicting_actions and conflicting_actions > 0:
        failures.append("SCHEDULED_ACTION_CONFLICT")

    return failures


async def _resolve_workflow_execution(
    session: AsyncSession,
    *,
    borrower_id: UUID,
    loan_id: UUID,
    workflow_execution_id: UUID | None,
    workflow_type: WorkflowType,
) -> WorkflowExecution:
    workflow = None
    if workflow_execution_id is not None:
        workflow = await session.scalar(
            select(WorkflowExecution)
            .where(WorkflowExecution.id == workflow_execution_id)
            .with_for_update()
        )
        if workflow is None:
            raise NotFoundError("Workflow execution not found")
        return workflow

    workflow = await session.scalar(
        select(WorkflowExecution)
        .where(
            WorkflowExecution.borrower_id == borrower_id,
            WorkflowExecution.loan_id == loan_id,
            WorkflowExecution.workflow_type == workflow_type,
            WorkflowExecution.status.in_(
                [WorkflowExecutionStatus.PENDING, WorkflowExecutionStatus.RUNNING]
            ),
        )
        .order_by(WorkflowExecution.created_at.desc())
        .with_for_update()
    )
    if workflow is not None:
        return workflow

    workflow = WorkflowExecution(
        borrower_id=borrower_id,
        loan_id=loan_id,
        workflow_type=workflow_type,
        status=WorkflowExecutionStatus.PENDING,
        current_attempt_no=0,
    )
    session.add(workflow)
    await session.flush()
    return workflow


async def _increment_workflow_attempt_no(
    session: AsyncSession,
    workflow_execution_id: UUID,
) -> int:
    attempt_no = await session.scalar(
        update(WorkflowExecution)
        .where(WorkflowExecution.id == workflow_execution_id)
        .values(current_attempt_no=WorkflowExecution.current_attempt_no + 1)
        .returning(WorkflowExecution.current_attempt_no)
    )
    if attempt_no is None:
        raise NotFoundError("Workflow execution not found")
    return int(attempt_no)
