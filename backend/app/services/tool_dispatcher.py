from __future__ import annotations

from datetime import datetime
import hashlib
import json
import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    BorrowerStatus,
    ConsentStatus,
    EventType,
    Outcome,
    ScheduledActionStatus,
    ScheduledActionType,
)
from app.core.errors import ToolExecutionError
from app.models import (
    Borrower,
    ContactPoint,
    Conversation,
    ConversationEvent,
    Loan,
    ScheduledAction,
    WorkflowExecution,
)
from app.schemas.runtime import ToolCall
from app.services.conversation_store import append_event
from app.services.scheduled_action_service import cancel_pending_scheduled_actions
from app.services.state_machine import tool_allowed

logger = logging.getLogger("feather_lite.tools")


async def _existing_tool_result(
    session: AsyncSession,
    conversation: Conversation,
    tool_call_id: str,
) -> dict[str, object] | None:
    events = list(
        (
            await session.scalars(
                select(ConversationEvent)
                .where(
                    ConversationEvent.conversation_id == conversation.id,
                    ConversationEvent.type == EventType.TOOL_RESULT,
                )
                .order_by(ConversationEvent.sequence_no.asc())
            )
        ).all()
    )
    for event in events:
        if event.payload.get("tool_call_id") == tool_call_id:
            result = event.payload.get("result")
            if isinstance(result, dict):
                return result
            return {"result": result}
    return None


def _derive_fallback_tool_call_id(
    conversation: Conversation,
    current_state,
    tool_call: ToolCall,
) -> str:
    payload = json.dumps(tool_call.args, sort_keys=True, default=str)
    raw = "|".join(
        [
            str(conversation.id),
            current_state.value,
            tool_call.name,
            payload,
        ]
    )
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    return f"derived-{digest}"


def _public_result(payload: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in payload.items() if not key.startswith("_")}


async def execute_tool(
    session: AsyncSession,
    conversation: Conversation,
    current_state,
    tool_call: ToolCall,
) -> dict[str, object]:
    if not tool_allowed(tool_call.name, current_state):
        raise ToolExecutionError(
            f"Tool {tool_call.name} is not allowed in state {current_state.value}"
        )

    if tool_call.tool_call_id is None:
        logger.warning(
            "tool_call_id missing; deriving deterministic fallback for %s",
            tool_call.name,
        )
    tool_call_id = tool_call.tool_call_id or _derive_fallback_tool_call_id(
        conversation,
        current_state,
        tool_call,
    )
    existing_result = await _existing_tool_result(session, conversation, tool_call_id)
    if existing_result is not None:
        return existing_result

    await append_event(
        session,
        conversation.id,
        EventType.TOOL_CALLED,
        {"name": tool_call.name, "tool_call_id": tool_call_id, "args": tool_call.args},
    )

    result = await _execute_tool_impl(session, conversation, tool_call.name, tool_call.args)

    await append_event(
        session,
        conversation.id,
        EventType.TOOL_RESULT,
        {"name": tool_call.name, "tool_call_id": tool_call_id, "result": result},
    )
    return result


async def _execute_tool_impl(
    session: AsyncSession,
    conversation: Conversation,
    tool_name: str,
    args: dict[str, object],
) -> dict[str, object]:
    if tool_name == "lookup_contact_profile":
        contact_point = await session.get(ContactPoint, UUID(str(args["contact_point_id"])))
        if contact_point is None:
            raise ToolExecutionError("Contact point not found")
        return {
            "contact_point_id": str(contact_point.id),
            "value": contact_point.value,
            "is_valid": contact_point.is_valid,
            "consent_status": contact_point.consent_status.value,
        }

    if tool_name == "get_account_context":
        loan = await session.scalar(select(Loan).where(Loan.borrower_id == conversation.borrower_id))
        if loan is None:
            raise ToolExecutionError("Loan not found")
        return {
            "balance_due": str(loan.balance_due),
            "due_date": loan.due_date.isoformat(),
            "status": loan.status.value,
            "delinquency_days": loan.delinquency_days,
        }

    if tool_name == "record_promise_to_pay":
        promised_date = str(args["date"])
        amount = str(args["amount"])
        loan = await session.scalar(select(Loan).where(Loan.borrower_id == conversation.borrower_id))
        if loan is None:
            raise ToolExecutionError("Loan not found")
        conversation.final_outcome = Outcome.PROMISE_TO_PAY
        conversation.final_outcome_metadata = {
            **conversation.final_outcome_metadata,
            "promised_date": promised_date,
            "promised_amount": amount,
            "notes": args.get("notes"),
        }
        loan.last_promise_date = datetime.fromisoformat(promised_date).date()
        await session.flush()
        return _public_result(conversation.final_outcome_metadata)

    if tool_name == "schedule_callback":
        workflow = await session.scalar(
            select(WorkflowExecution).where(
                WorkflowExecution.id == conversation.call_attempt.workflow_execution_id
            )
        )
        if workflow is None:
            raise ToolExecutionError("Workflow execution not found")
        callback_at = datetime.fromisoformat(str(args["datetime"]))
        callback_payload = {
            "reason": args.get("reason", "borrower_requested"),
            "borrower_id": str(conversation.borrower_id),
            "contact_point_id": str(conversation.call_attempt.contact_point_id),
            "channel": conversation.channel,
        }
        await cancel_pending_scheduled_actions(
            session,
            workflow_execution_id=workflow.id,
            reason="callback_scheduled",
            action_types={ScheduledActionType.RETRY_CALL},
        )
        scheduled_action = await session.scalar(
            select(ScheduledAction).where(
                ScheduledAction.workflow_execution_id == workflow.id,
                ScheduledAction.action_type == ScheduledActionType.CALLBACK,
                ScheduledAction.status == ScheduledActionStatus.PENDING,
            )
        )
        if scheduled_action is None:
            scheduled_action = ScheduledAction(
                workflow_execution=workflow,
                action_type=ScheduledActionType.CALLBACK,
                due_at=callback_at,
                status=ScheduledActionStatus.PENDING,
                payload=callback_payload,
            )
            session.add(scheduled_action)
        else:
            scheduled_action.due_at = callback_at
            scheduled_action.payload = {**scheduled_action.payload, **callback_payload}
        conversation.final_outcome = Outcome.CALLBACK_SCHEDULED
        conversation.final_outcome_metadata = {
            **conversation.final_outcome_metadata,
            "callback_at": str(args["datetime"]),
        }
        await session.flush()
        return {"callback_at": str(args["datetime"])}

    if tool_name == "record_opt_out":
        scope = str(args.get("scope", "borrower"))
        reason = str(args.get("reason", "borrower_request"))
        if scope == "borrower":
            borrower = await session.get(Borrower, conversation.borrower_id)
            if borrower is None:
                raise ToolExecutionError("Borrower not found")
            borrower.status = BorrowerStatus.OPT_OUT
        else:
            contact_point = await session.get(ContactPoint, conversation.call_attempt.contact_point_id)
            if contact_point is None:
                raise ToolExecutionError("Contact point not found")
            contact_point.consent_status = ConsentStatus.OPTED_OUT
        await cancel_pending_scheduled_actions(
            session,
            workflow_execution_id=conversation.call_attempt.workflow_execution_id,
            reason="opt_out",
        )
        conversation.final_outcome = Outcome.OPT_OUT
        conversation.final_outcome_metadata = {
            **conversation.final_outcome_metadata,
            "scope": scope,
            "reason": reason,
        }
        await session.flush()
        return _public_result(conversation.final_outcome_metadata)

    if tool_name == "record_wrong_party_contact":
        contact_point = await session.get(ContactPoint, conversation.call_attempt.contact_point_id)
        if contact_point is None:
            raise ToolExecutionError("Contact point not found")
        notes = str(args.get("notes", ""))
        outcome_type = str(args.get("outcome_type", Outcome.THIRD_PARTY_CONTACT.value))
        if outcome_type == Outcome.WRONG_NUMBER.value:
            contact_point.is_valid = False
            outcome = Outcome.WRONG_NUMBER
            await cancel_pending_scheduled_actions(
                session,
                workflow_execution_id=conversation.call_attempt.workflow_execution_id,
                reason="wrong_number",
                action_types={ScheduledActionType.CALLBACK, ScheduledActionType.RETRY_CALL},
            )
        elif outcome_type == Outcome.THIRD_PARTY_CONTACT.value:
            outcome = Outcome.THIRD_PARTY_CONTACT
        else:
            raise ToolExecutionError(f"Unsupported wrong-party outcome_type: {outcome_type}")
        conversation.final_outcome = outcome
        conversation.final_outcome_metadata = {
            **conversation.final_outcome_metadata,
            "notes": notes,
        }
        await session.flush()
        return {"outcome": outcome.value, "notes": notes}

    raise ToolExecutionError(f"Unsupported tool: {tool_name}")
