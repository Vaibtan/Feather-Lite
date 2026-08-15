from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import logging
import re
from time import perf_counter
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import (
    CallAttemptStatus,
    ConversationState,
    EventType,
    Outcome,
    WorkflowExecutionStatus,
)
from app.core.errors import ValidationError
from app.models import Conversation, Loan
from app.schemas.conversations import ConversationDetailResponse, ConversationListItem
from app.schemas.runtime import SimulationTurnRequest, SimulationTurnResponse, ToolCall, TurnDecision
from app.services.call_control import append_amd_result, log_call_control_action, log_transfer_events
from app.services.conversation_store import append_event, derive_current_state, get_conversation_with_related
from app.services.observability import metrics
from app.services.outbox_service import enqueue_post_call_jobs
from app.services.scheduled_action_service import create_human_followup_action, create_retry_action
from app.services.state_machine import match_override, tool_allowed, validate_transition
from app.services.tool_dispatcher import execute_tool
from app.services.transcript_service import build_event_timeline, build_transcript
from app.voice.session_state import SessionState

logger = logging.getLogger("feather_lite.conversation")


@dataclass(slots=True)
class TurnProcessingResult:
    agent_text: str
    new_state: ConversationState
    tool_called: ToolCall | None = None
    call_control_action: dict[str, object] | None = None
    outcome: Outcome | None = None
    intent_satisfied: bool = True


async def list_conversations(session: AsyncSession) -> list[ConversationListItem]:
    statement = (
        select(Conversation)
        .options(selectinload(Conversation.borrower))
        .order_by(Conversation.started_at.desc())
        .limit(50)
    )
    conversations = list((await session.scalars(statement)).all())
    items: list[ConversationListItem] = []
    for conversation in conversations:
        duration_seconds = None
        if conversation.ended_at is not None:
            duration_seconds = int(
                (conversation.ended_at - conversation.started_at).total_seconds()
            )
        items.append(
            ConversationListItem(
                conversation_id=str(conversation.id),
                borrower_name=conversation.borrower.name,
                started_at=conversation.started_at.isoformat(),
                ended_at=conversation.ended_at.isoformat() if conversation.ended_at else None,
                final_outcome=conversation.final_outcome.value if conversation.final_outcome else None,
                duration_seconds=duration_seconds,
                channel=conversation.channel,
            )
        )
    return items


async def get_conversation_detail(
    session: AsyncSession,
    conversation_id: UUID,
) -> ConversationDetailResponse:
    conversation = await get_conversation_with_related(session, conversation_id)
    events = sorted(conversation.events, key=lambda event: event.sequence_no)
    return ConversationDetailResponse(
        conversation={
            "id": str(conversation.id),
            "borrower_id": str(conversation.borrower_id),
            "started_at": conversation.started_at.isoformat(),
            "ended_at": conversation.ended_at.isoformat() if conversation.ended_at else None,
            "final_outcome": conversation.final_outcome.value if conversation.final_outcome else None,
            "channel": conversation.channel,
            "protected_context_unlocked": conversation.protected_context_unlocked,
            "workflow_execution_id": str(conversation.call_attempt.workflow_execution_id),
            "call_attempt_id": str(conversation.call_attempt_id),
        },
        transcript=build_transcript(events),
        event_timeline=build_event_timeline(events),
    )


async def simulate_turn(
    session: AsyncSession,
    conversation_id: UUID,
    request: SimulationTurnRequest,
) -> SimulationTurnResponse:
    result = await process_user_turn(session, conversation_id, request.user_text)
    return SimulationTurnResponse(
        agent_text=result.agent_text,
        new_state=result.new_state,
        tool_called=result.tool_called,
        call_control_action=result.call_control_action,
        outcome=result.outcome,
    )


async def process_user_turn(
    session: AsyncSession,
    conversation_id: UUID,
    user_text: str,
) -> TurnProcessingResult:
    started = perf_counter()
    conversation = await get_conversation_with_related(session, conversation_id, lock=True)
    if conversation.final_outcome is not None:
        raise ValidationError("Conversation is already completed")

    current_state = derive_current_state(conversation)
    session_state = await _build_session_state(session, conversation, current_state)

    await append_event(
        session,
        conversation.id,
        EventType.USER_TURN_FINAL,
        {"text": user_text},
    )

    override = match_override(user_text)
    call_control_action = None
    tool_call = None
    final_outcome = None
    agent_message = ""
    new_state = current_state

    if override is not None:
        agent_message, tool_call, new_state, final_outcome, call_control_action = await _handle_override(
            session,
            conversation,
            user_text,
            override.reason,
            override.target_state,
        )
    else:
        decision = _generate_turn_decision(session_state, user_text)
        tool_call = decision.tool_call
        new_state = validate_transition(current_state, decision.suggested_next_state) or current_state
        agent_message = decision.message

        if (
            current_state == ConversationState.VERIFYING_IDENTITY
            and new_state == ConversationState.DISCUSSING_PAYMENT
        ):
            conversation.protected_context_unlocked = True
            session_state.protected_context_unlocked = True

        if (
            current_state == ConversationState.DISCUSSING_PAYMENT
            and new_state == ConversationState.CONFIRMING_OUTCOME
            and tool_call is None
        ):
            conversation.final_outcome_metadata = {
                **conversation.final_outcome_metadata,
                "promised_date": _extract_payment_date(user_text),
                "promised_amount": _extract_amount(user_text)
                or session_state.protected_context.get("balance_due", "0.00"),
            }

        if tool_call is not None:
            # Tool-specific state semantics: tools that record outcomes
            # (promise-to-pay, callback, opt-out) must execute in the
            # pre-transition state where they are allowed. Tools that
            # record contact-point facts (wrong-party) execute in the
            # post-transition state. The TOOL_STATE_MATRIX is authoritative.
            if tool_allowed(tool_call.name, current_state):
                tool_state = current_state
            elif tool_allowed(tool_call.name, new_state):
                tool_state = new_state
            else:
                tool_state = current_state  # will fail in execute_tool with clear error
            result = await execute_tool(session, conversation, tool_state, tool_call)
            final_outcome = conversation.final_outcome
            if tool_call.name == "schedule_callback":
                agent_message = f"Understood. I have scheduled a callback for {result['callback_at']}."
            elif tool_call.name == "record_promise_to_pay":
                agent_message = (
                    f"Thanks. I have recorded your promise to pay {result['promised_amount']} by {result['promised_date']}."
                )
            elif tool_call.name == "record_wrong_party_contact":
                agent_message = "Understood. I will update our records and end the call now."
            elif tool_call.name == "record_opt_out":
                agent_message = "Understood. We will stop contacting you. Goodbye."

        if (
            current_state == ConversationState.DISCUSSING_PAYMENT
            and not conversation.final_outcome_metadata.get("_payment_intro_done")
        ):
            conversation.final_outcome_metadata = {
                **conversation.final_outcome_metadata,
                "_payment_intro_done": True,
            }

    if new_state != current_state:
        await append_event(
            session,
            conversation.id,
            EventType.STATE_TRANSITION,
            {
                "from": current_state.value,
                "to": new_state.value,
                "triggered_by": "LLM_INTENT" if override is None else "OVERRIDE_RULE",
            },
        )

    await append_event(
        session,
        conversation.id,
        EventType.AGENT_TURN,
        {"text": agent_message, "state": new_state.value},
    )

    if final_outcome is not None:
        await finalize_conversation(session, conversation, new_state, final_outcome)
        new_state = ConversationState.COMPLETED

    await session.commit()
    latency_ms = (perf_counter() - started) * 1000
    metrics.increment("user_turns_processed")
    metrics.observe("turn_processing_latency_ms", latency_ms)
    metrics.record_trace(
        "process_user_turn",
        latency_ms=latency_ms,
        metadata={
            "conversation_id": str(conversation.id),
            "new_state": new_state.value,
            "final_outcome": final_outcome.value if final_outcome else None,
        },
    )
    logger.info(
        "turn_processed",
        extra={
            "conversation_id": str(conversation.id),
            "event_type": EventType.USER_TURN_FINAL.value,
        },
    )
    return TurnProcessingResult(
        agent_text=agent_message,
        new_state=new_state,
        tool_called=tool_call,
        call_control_action=call_control_action,
        outcome=final_outcome,
        intent_satisfied=decision.intent_satisfied if override is None else True,
    )


async def process_no_input(
    session: AsyncSession,
    conversation_id: UUID,
) -> TurnProcessingResult:
    conversation = await get_conversation_with_related(session, conversation_id, lock=True)
    if conversation.final_outcome is not None:
        raise ValidationError("Conversation is already completed")

    current_state = derive_current_state(conversation)
    no_input_count = sum(1 for event in conversation.events if event.type == EventType.NO_INPUT) + 1
    agent_message = _build_no_input_prompt(current_state, no_input_count)

    await append_event(
        session,
        conversation.id,
        EventType.NO_INPUT,
        {"state": current_state.value, "count": no_input_count},
    )

    if no_input_count >= 2:
        await create_retry_action(session, conversation, reason="no_input_timeout")
        action = await log_call_control_action(
            session,
            conversation,
            "NO_INPUT_CLOSE",
            {"count": no_input_count},
        )
        await append_event(
            session,
            conversation.id,
            EventType.AGENT_TURN,
            {"text": agent_message, "state": current_state.value},
        )
        await finalize_conversation(session, conversation, current_state, Outcome.NO_ANSWER)
        await session.commit()
        return TurnProcessingResult(
            agent_text=agent_message,
            new_state=ConversationState.COMPLETED,
            call_control_action=action,
            outcome=Outcome.NO_ANSWER,
            intent_satisfied=True,
        )

    await append_event(
        session,
        conversation.id,
        EventType.AGENT_TURN,
        {"text": agent_message, "state": current_state.value},
    )
    await session.commit()

    return TurnProcessingResult(
        agent_text=agent_message,
        new_state=current_state,
        intent_satisfied=False,
    )


async def process_call_control_signal(
    session: AsyncSession,
    conversation_id: UUID,
    signal: str,
    payload: dict[str, object] | None = None,
) -> TurnProcessingResult:
    conversation = await get_conversation_with_related(session, conversation_id, lock=True)
    if conversation.final_outcome is not None:
        raise ValidationError("Conversation is already completed")

    payload = payload or {}
    current_state = derive_current_state(conversation)

    if signal == "voicemail_drop":
        await append_amd_result(
            session,
            conversation,
            machine_detected=True,
            classification="voicemail",
            confidence=float(payload.get("confidence", 0.99)),
        )
        await append_event(
            session,
            conversation.id,
            EventType.STATE_TRANSITION,
            {
                "from": current_state.value,
                "to": ConversationState.VOICEMAIL.value,
                "triggered_by": "AMD",
            },
        )
        action = await log_call_control_action(
            session,
            conversation,
            "VOICEMAIL_DROP",
            {"confidence": float(payload.get("confidence", 0.99))},
            action_id=str(payload.get("action_id")) if payload.get("action_id") else None,
        )
        agent_message = str(
            payload.get(
                "message",
                "This is Feather-Lite Collections calling about an important account matter. Please call us back.",
            )
        )
        await append_event(
            session,
            conversation.id,
            EventType.AGENT_TURN,
            {"text": agent_message, "state": ConversationState.VOICEMAIL.value},
        )
        await finalize_conversation(
            session,
            conversation,
            ConversationState.VOICEMAIL,
            Outcome.VOICEMAIL_LEFT,
        )
        await session.commit()
        logger.info(
            "voicemail_drop_completed",
            extra={"conversation_id": str(conversation.id), "action": "VOICEMAIL_DROP"},
        )
        return TurnProcessingResult(
            agent_text=agent_message,
            new_state=ConversationState.COMPLETED,
            call_control_action=action,
            outcome=Outcome.VOICEMAIL_LEFT,
            intent_satisfied=True,
        )

    if signal == "no_answer":
        action = await log_call_control_action(
            session,
            conversation,
            "NO_ANSWER",
            payload,
            action_id=str(payload.get("action_id")) if payload.get("action_id") else None,
        )
        await create_retry_action(session, conversation, reason="no_answer")
        await finalize_conversation(session, conversation, current_state, Outcome.NO_ANSWER)
        await session.commit()
        logger.info(
            "no_answer_completed",
            extra={"conversation_id": str(conversation.id), "action": "NO_ANSWER"},
        )
        return TurnProcessingResult(
            agent_text="No answer received. Ending this attempt and scheduling a retry.",
            new_state=ConversationState.COMPLETED,
            call_control_action=action,
            outcome=Outcome.NO_ANSWER,
            intent_satisfied=True,
        )

    if signal == "barge_in":
        action = await log_call_control_action(
            session,
            conversation,
            "BARGE_IN_DETECTED",
            {
                "partial_agent_text": payload.get("partial_agent_text"),
                "resume_allowed": True,
            },
            action_id=str(payload.get("action_id")) if payload.get("action_id") else None,
        )
        await session.commit()
        return TurnProcessingResult(
            agent_text="",
            new_state=current_state,
            call_control_action=action,
            intent_satisfied=True,
        )

    raise ValidationError(f"Unsupported call-control signal: {signal}")


async def _build_session_state(
    session: AsyncSession,
    conversation: Conversation,
    current_state: ConversationState,
) -> SessionState:
    loan = await session.scalar(select(Loan).where(Loan.borrower_id == conversation.borrower_id))
    public_context = {
        "agent_name": "Feather-Lite",
        "company": "Feather-Lite Collections",
        "workflow_type": conversation.call_attempt.workflow_execution.workflow_type.value,
        "attempt_count": conversation.call_attempt.workflow_execution.current_attempt_no,
    }
    protected_context = {}
    if loan is not None:
        protected_context = {
            "balance_due": str(loan.balance_due),
            "due_date": loan.due_date.isoformat(),
            "loan_status": loan.status.value,
            "delinquency_days": loan.delinquency_days,
        }
    memory_context = {
        key: value
        for key, value in conversation.final_outcome_metadata.items()
        if key in {"promised_date", "promised_amount", "callback_at", "_payment_intro_done"}
    }
    return SessionState(
        workflow_execution_id=conversation.call_attempt.workflow_execution_id,
        call_attempt_id=conversation.call_attempt_id,
        conversation_id=conversation.id,
        contact_point_id=conversation.call_attempt.contact_point_id,
        borrower_id=conversation.borrower_id,
        current_state=current_state,
        protected_context_unlocked=conversation.protected_context_unlocked,
        public_context=public_context,
        protected_context=protected_context,
        memory_context=memory_context,
    )


def _generate_turn_decision(
    session_state: SessionState,
    user_text: str,
) -> TurnDecision:
    text = user_text.strip().lower()

    if session_state.current_state == ConversationState.GREETING:
        if any(phrase in text for phrase in ("yes", "speaking", "this is", "i am")):
            return TurnDecision(
                message=(
                    "Thank you. Before I continue, I need to confirm I am speaking "
                    "with the borrower on the account. Is that correct?"
                ),
                intent_satisfied=True,
                suggested_next_state=ConversationState.VERIFYING_IDENTITY,
            )
        if any(phrase in text for phrase in ("not available", "not here", "call back later")):
            return TurnDecision(
                message="Understood. I will note that I reached a third party and end the call now.",
                tool_call=ToolCall(
                    name="record_wrong_party_contact",
                    args={
                        "notes": "Third-party contact; borrower unavailable",
                        "outcome_type": Outcome.THIRD_PARTY_CONTACT.value,
                    },
                ),
                intent_satisfied=True,
                suggested_next_state=ConversationState.THIRD_PARTY_OR_WRONG_PARTY,
            )
        return TurnDecision(
            message="Hello, may I speak with the borrower listed on this account?",
            intent_satisfied=True,
            suggested_next_state=ConversationState.VERIFYING_IDENTITY,
        )

    if session_state.current_state == ConversationState.VERIFYING_IDENTITY:
        if any(phrase in text for phrase in ("yes", "speaking", "this is", "i am")):
            return TurnDecision(
                message=(
                    "Thank you for confirming. Let me pull up the details on your account."
                ),
                intent_satisfied=True,
                suggested_next_state=ConversationState.DISCUSSING_PAYMENT,
            )
        if any(phrase in text for phrase in ("not available", "not here", "call back later")):
            return TurnDecision(
                message="Understood. I will note that I reached a third party and end the call now.",
                tool_call=ToolCall(
                    name="record_wrong_party_contact",
                    args={
                        "notes": "Third-party contact; borrower unavailable",
                        "outcome_type": Outcome.THIRD_PARTY_CONTACT.value,
                    },
                ),
                intent_satisfied=True,
                suggested_next_state=ConversationState.THIRD_PARTY_OR_WRONG_PARTY,
            )
        return TurnDecision(
            message="I need to confirm I am speaking with the right person before I continue. Are you the borrower on the account?",
            intent_satisfied=False,
            suggested_next_state=ConversationState.VERIFYING_IDENTITY,
        )

    if session_state.current_state == ConversationState.DISCUSSING_PAYMENT:
        if not session_state.memory_context.get("_payment_intro_done"):
            balance = session_state.protected_context.get("balance_due", "your current balance")
            due_date = session_state.protected_context.get("due_date", "the due date on file")
            if "callback" in text or "call me back" in text or "later" in text:
                callback_at = (datetime.now(timezone.utc) + timedelta(days=1)).replace(microsecond=0)
                return TurnDecision(
                    message=f"Your current balance due is {balance} with a due date of {due_date}. I can schedule a callback for you.",
                    tool_call=ToolCall(
                        name="schedule_callback",
                        args={"datetime": callback_at.isoformat(), "reason": "borrower_requested"},
                    ),
                    intent_satisfied=True,
                    suggested_next_state=ConversationState.CONFIRMING_OUTCOME,
                )
            if "pay" in text or "friday" in text or "tomorrow" in text:
                promised_date = _extract_payment_date(text)
                amount = _extract_amount(text) or str(balance)
                return TurnDecision(
                    message=f"Your current balance due is {balance} with a due date of {due_date}. To confirm, you are promising to pay {amount} by {promised_date}. Please say yes to confirm.",
                    intent_satisfied=True,
                    suggested_next_state=ConversationState.CONFIRMING_OUTCOME,
                )
            return TurnDecision(
                message=f"Your current balance due is {balance} with a due date of {due_date}. Are you able to make a payment now or would you prefer a callback?",
                intent_satisfied=False,
                suggested_next_state=ConversationState.DISCUSSING_PAYMENT,
            )
        if "callback" in text or "call me back" in text or "later" in text:
            callback_at = (datetime.now(timezone.utc) + timedelta(days=1)).replace(microsecond=0)
            return TurnDecision(
                message="I can schedule a callback for you.",
                tool_call=ToolCall(
                    name="schedule_callback",
                    args={"datetime": callback_at.isoformat(), "reason": "borrower_requested"},
                ),
                intent_satisfied=True,
                suggested_next_state=ConversationState.CONFIRMING_OUTCOME,
            )
        if "pay" in text or "friday" in text or "tomorrow" in text:
            promised_date = _extract_payment_date(text)
            amount = _extract_amount(text) or session_state.protected_context.get("balance_due", "0.00")
            return TurnDecision(
                message=f"To confirm, you are promising to pay {amount} by {promised_date}. Please say yes to confirm.",
                intent_satisfied=True,
                suggested_next_state=ConversationState.CONFIRMING_OUTCOME,
            )
        return TurnDecision(
            message="Can you tell me whether you can make a payment now, need more time, or want a callback?",
            intent_satisfied=False,
            suggested_next_state=ConversationState.DISCUSSING_PAYMENT,
        )

    if session_state.current_state == ConversationState.CONFIRMING_OUTCOME:
        if "callback" in text or "call me back" in text or "later" in text:
            callback_at = (datetime.now(timezone.utc) + timedelta(days=1)).replace(microsecond=0)
            return TurnDecision(
                message="Understood. I can schedule a callback for you instead.",
                tool_call=ToolCall(
                    name="schedule_callback",
                    args={"datetime": callback_at.isoformat(), "reason": "borrower_changed_mind"},
                ),
                intent_satisfied=True,
                suggested_next_state=ConversationState.CONFIRMING_OUTCOME,
            )
        if "yes" in text or "confirm" in text:
            metadata = session_state.memory_context
            if "callback_at" in metadata:
                return TurnDecision(
                    message="Your callback has been confirmed.",
                    intent_satisfied=True,
                    suggested_next_state=ConversationState.ENDING,
                )
            return TurnDecision(
                message="Thank you. I am recording that commitment now.",
                tool_call=ToolCall(
                    name="record_promise_to_pay",
                    args={
                        "date": metadata.get("promised_date", _extract_payment_date(text)),
                        "amount": metadata.get("promised_amount", _extract_amount(text) or "0.00"),
                        "notes": "confirmed by borrower",
                    },
                ),
                intent_satisfied=True,
                suggested_next_state=ConversationState.ENDING,
            )
        return TurnDecision(
            message="Please confirm the commitment by saying yes, or ask for a callback instead.",
            intent_satisfied=False,
            suggested_next_state=ConversationState.CONFIRMING_OUTCOME,
        )

    return TurnDecision(
        message="Thank you. Goodbye.",
        intent_satisfied=True,
        suggested_next_state=ConversationState.ENDING,
    )


async def _handle_override(
    session: AsyncSession,
    conversation: Conversation,
    user_text: str,
    reason: str,
    target_state: ConversationState,
) -> tuple[str, ToolCall | None, ConversationState, Outcome | None, dict[str, object] | None]:
    if reason == "OPT_OUT":
        tool_call = ToolCall(
            name="record_opt_out",
            args={"scope": "borrower", "reason": "borrower_request"},
        )
        await execute_tool(session, conversation, ConversationState.OPT_OUT, tool_call)
        return (
            "Understood. We will stop contacting you. Goodbye.",
            tool_call,
            ConversationState.OPT_OUT,
            Outcome.OPT_OUT,
            None,
        )

    if reason == "WRONG_NUMBER":
        tool_call = ToolCall(
            name="record_wrong_party_contact",
            args={"notes": "Wrong number", "outcome_type": Outcome.WRONG_NUMBER.value},
        )
        await execute_tool(session, conversation, ConversationState.WRONG_NUMBER, tool_call)
        return (
            "Thank you for letting us know. We will update our records and end the call now.",
            tool_call,
            ConversationState.WRONG_NUMBER,
            Outcome.WRONG_NUMBER,
            None,
        )

    if reason == "DISPUTE":
        payload = await log_transfer_events(
            session,
            conversation,
            target="disputes_queue",
            reason="debt_dispute",
        )
        await create_human_followup_action(
            session,
            conversation,
            queue="disputes_queue",
            reason="debt_dispute",
        )
        conversation.transfer_target = "disputes_queue"
        conversation.final_outcome = Outcome.DISPUTED
        conversation.final_outcome_metadata = {
            **conversation.final_outcome_metadata,
            "reason": "debt_dispute",
            "transcript_excerpt": user_text,
        }
        return (
            "I understand that you are disputing this debt. I will route this for human follow-up and end the call.",
            None,
            ConversationState.ESCALATED,
            Outcome.DISPUTED,
            payload,
        )

    if reason == "HARDSHIP":
        payload = await log_transfer_events(
            session,
            conversation,
            target="hardship_queue",
            reason="hardship_or_distress",
        )
        await create_human_followup_action(
            session,
            conversation,
            queue="hardship_queue",
            reason="hardship_or_distress",
        )
        conversation.transfer_target = "hardship_queue"
        conversation.final_outcome = Outcome.ESCALATED
        conversation.final_outcome_metadata = {
            **conversation.final_outcome_metadata,
            "reason": "hardship_or_distress",
            "transcript_excerpt": user_text,
        }
        return (
            "I understand. I will route this for human follow-up and end the call now.",
            None,
            ConversationState.ESCALATED,
            Outcome.ESCALATED,
            payload,
        )

    raise ValidationError(f"Unrecognized override reason: {reason}")


async def finalize_conversation(
    session: AsyncSession,
    conversation: Conversation,
    current_state: ConversationState,
    final_outcome: Outcome,
) -> None:
    if current_state != ConversationState.ENDING:
        await append_event(
            session,
            conversation.id,
            EventType.STATE_TRANSITION,
            {
                "from": current_state.value,
                "to": ConversationState.ENDING.value,
                "triggered_by": "OUTCOME_COMMITTED",
            },
        )
    await append_event(
        session,
        conversation.id,
        EventType.STATE_TRANSITION,
        {
            "from": ConversationState.ENDING.value,
            "to": ConversationState.COMPLETED.value,
            "triggered_by": "CALL_ENDED",
        },
    )
    conversation.final_outcome = final_outcome
    conversation.ended_at = datetime.now(timezone.utc)
    conversation.call_attempt.ended_at = conversation.ended_at
    conversation.call_attempt.attempt_status = _attempt_status_for_outcome(final_outcome)
    conversation.call_attempt.workflow_execution.status = _workflow_status_for_outcome(final_outcome)
    await append_event(
        session,
        conversation.id,
        EventType.CALL_ENDED,
        {"final_outcome": final_outcome.value},
    )
    await enqueue_post_call_jobs(session, conversation.id)
    metrics.increment("calls_completed", labels={"outcome": final_outcome.value})
    logger.info(
        "conversation_completed",
        extra={
            "conversation_id": str(conversation.id),
            "call_attempt_id": str(conversation.call_attempt_id),
            "workflow_execution_id": str(conversation.call_attempt.workflow_execution_id),
            "event_type": EventType.CALL_ENDED.value,
        },
    )
    await session.flush()


def _extract_payment_date(text: str) -> str:
    normalized = text.lower()
    today = datetime.now(timezone.utc).date()
    if "tomorrow" in normalized:
        return (today + timedelta(days=1)).isoformat()
    if "friday" in normalized:
        days_until_friday = (4 - today.weekday()) % 7
        days_until_friday = 7 if days_until_friday == 0 else days_until_friday
        return (today + timedelta(days=days_until_friday)).isoformat()
    return (today + timedelta(days=3)).isoformat()


def _extract_amount(text: str) -> str | None:
    patterns = (
        r"\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)",
        r"\b(?:pay|payment|paying|promise(?:\s+to\s+pay)?|amount)\s+(?:of\s+)?(\d+(?:,\d{3})*(?:\.\d{1,2})?)\b",
        r"\b(\d+(?:,\d{3})*\.\d{1,2})\b",
        r"\b(\d+(?:,\d{3})*)\s+dollars?\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match is None:
            continue
        candidate = match.group(1).replace(",", "")
        try:
            value = Decimal(candidate)
            return f"{value:.2f}"
        except (InvalidOperation, ValueError):
            continue
    return None


def _build_no_input_prompt(current_state: ConversationState, count: int) -> str:
    if count >= 2:
        return "I am not hearing a response, so I will end this attempt and try again later."
    if current_state == ConversationState.GREETING:
        return "I didn't catch that. May I speak with the borrower on the account?"
    if current_state == ConversationState.VERIFYING_IDENTITY:
        return (
            "I need to confirm I am speaking with the right person before I continue. "
            "Are you the borrower on the account?"
        )
    if current_state == ConversationState.DISCUSSING_PAYMENT:
        return (
            "I didn't catch that. Can you tell me whether you can make a payment now, "
            "need more time, or want a callback?"
        )
    if current_state == ConversationState.CONFIRMING_OUTCOME:
        return "Please confirm by saying yes, or ask for a callback instead."
    return "I didn't catch that. Please repeat that."


def _attempt_status_for_outcome(outcome: Outcome) -> CallAttemptStatus:
    if outcome == Outcome.NO_ANSWER:
        return CallAttemptStatus.NO_ANSWER
    if outcome == Outcome.VOICEMAIL_LEFT:
        return CallAttemptStatus.VOICEMAIL
    if outcome == Outcome.FAILED:
        return CallAttemptStatus.FAILED
    return CallAttemptStatus.COMPLETED


def _workflow_status_for_outcome(outcome: Outcome) -> WorkflowExecutionStatus:
    if outcome in {Outcome.CALLBACK_SCHEDULED, Outcome.NO_ANSWER, Outcome.VOICEMAIL_LEFT}:
        return WorkflowExecutionStatus.RUNNING
    return WorkflowExecutionStatus.COMPLETED
