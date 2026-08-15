from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import (
    ScheduledActionStatus,
    ScheduledActionType,
    WorkflowExecutionStatus,
    WorkflowType,
)
from app.core.errors import ValidationError
from app.models import Conversation, ScheduledAction, WorkflowExecution
from app.schemas.calls import StartCallRequest
from app.services.workflow_service import start_call


async def create_scheduled_action(
    session: AsyncSession,
    *,
    workflow_execution_id: UUID,
    action_type: ScheduledActionType,
    due_at: datetime,
    payload: dict[str, object],
) -> ScheduledAction:
    action = ScheduledAction(
        workflow_execution_id=workflow_execution_id,
        action_type=action_type,
        due_at=due_at,
        status=ScheduledActionStatus.PENDING,
        payload=payload,
    )
    session.add(action)
    await session.flush()
    return action


async def cancel_pending_scheduled_actions(
    session: AsyncSession,
    *,
    workflow_execution_id: UUID,
    reason: str,
    action_types: set[ScheduledActionType] | None = None,
) -> int:
    statement = select(ScheduledAction).where(
        ScheduledAction.workflow_execution_id == workflow_execution_id,
        ScheduledAction.status == ScheduledActionStatus.PENDING,
    )
    actions = list((await session.scalars(statement)).all())
    canceled = 0
    for action in actions:
        if action_types is not None and action.action_type not in action_types:
            continue
        action.status = ScheduledActionStatus.CANCELED
        action.payload = {**action.payload, "canceled_reason": reason}
        canceled += 1
    await session.flush()
    return canceled


async def create_retry_action(
    session: AsyncSession,
    conversation: Conversation,
    *,
    reason: str,
    retry_after: timedelta | None = None,
) -> ScheduledAction:
    retry_after = retry_after or timedelta(hours=4)
    return await create_scheduled_action(
        session,
        workflow_execution_id=conversation.call_attempt.workflow_execution_id,
        action_type=ScheduledActionType.RETRY_CALL,
        due_at=datetime.now(timezone.utc) + retry_after,
        payload={
            "borrower_id": str(conversation.borrower_id),
            "contact_point_id": str(conversation.call_attempt.contact_point_id),
            "channel": conversation.channel,
            "reason": reason,
        },
    )


async def create_human_followup_action(
    session: AsyncSession,
    conversation: Conversation,
    *,
    queue: str,
    reason: str,
) -> ScheduledAction:
    return await create_scheduled_action(
        session,
        workflow_execution_id=conversation.call_attempt.workflow_execution_id,
        action_type=ScheduledActionType.HUMAN_FOLLOWUP,
        due_at=datetime.now(timezone.utc),
        payload={
            "borrower_id": str(conversation.borrower_id),
            "contact_point_id": str(conversation.call_attempt.contact_point_id),
            "queue": queue,
            "reason": reason,
            "conversation_id": str(conversation.id),
        },
    )


async def claim_due_scheduled_actions(
    session: AsyncSession,
    *,
    limit: int = 20,
) -> list[ScheduledAction]:
    statement = (
        select(ScheduledAction)
        .options(selectinload(ScheduledAction.workflow_execution))
        .where(
            ScheduledAction.status == ScheduledActionStatus.PENDING,
            ScheduledAction.due_at <= datetime.now(timezone.utc),
        )
        .order_by(ScheduledAction.due_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    actions = list((await session.scalars(statement)).all())
    for action in actions:
        action.status = ScheduledActionStatus.CLAIMED
    await session.flush()
    return actions


async def process_scheduled_action(
    session: AsyncSession,
    action: ScheduledAction,
) -> dict[str, object]:
    workflow = await session.get(WorkflowExecution, action.workflow_execution_id)
    if workflow is None:
        raise ValidationError("Scheduled action workflow not found")

    if action.action_type == ScheduledActionType.HUMAN_FOLLOWUP:
        workflow.status = WorkflowExecutionStatus.RUNNING
        action.status = ScheduledActionStatus.DONE
        await session.flush()
        return {
            "action_type": action.action_type.value,
            "status": "queued_for_human",
            "queue": action.payload.get("queue"),
        }

    borrower_id = action.payload.get("borrower_id")
    contact_point_id = action.payload.get("contact_point_id")
    if not borrower_id or not contact_point_id:
        raise ValidationError("Scheduled action payload is missing routing identifiers")

    workflow_type = WorkflowType.CALLBACK_FOLLOWUP
    if action.action_type == ScheduledActionType.RETRY_CALL:
        workflow_type = WorkflowType.PAYMENT_REMINDER

    response = await start_call(
        session,
        StartCallRequest(
            borrower_id=UUID(str(borrower_id)),
            contact_point_id=UUID(str(contact_point_id)),
            channel=str(action.payload.get("channel", "simulated")),
        ),
        commit=False,
        workflow_execution_id=workflow.id,
        workflow_type=workflow_type,
    )
    action.status = ScheduledActionStatus.DONE
    await session.flush()
    return {
        "action_type": action.action_type.value,
        "conversation_id": response.conversation_id,
        "workflow_execution_id": response.workflow_execution_id,
        "call_attempt_id": response.call_attempt_id,
    }

