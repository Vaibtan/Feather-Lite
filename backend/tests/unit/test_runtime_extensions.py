from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from unittest.mock import AsyncMock

from app.main import app
from app.core.enums import ConversationState, Outcome
from app.schemas.runtime import ToolCall, TurnDecision
from app.services import conversation_service as cs
from app.services.conversation_service import TurnProcessingResult
from app.services.replay_service import replay_conversation_state
from app.services.scenario_runner import list_scenarios
from app.services.tool_dispatcher import execute_tool
from app.core.errors import ToolExecutionError
from app.core.enums import EventType
from app.voice.session_state import SessionState
from app.voice.livekit_adapter import normalize_turn_processing_result


def test_scenario_registry_contains_full_mandatory_suite() -> None:
    scenario_ids = {scenario.scenario_id for scenario in list_scenarios()}
    assert len(scenario_ids) == 12
    assert "happy-path-promise-to-pay" in scenario_ids
    assert "duplicate-tool-call-idempotent" in scenario_ids
    assert "protected-context-not-exposed-before-verification" in scenario_ids


def test_voice_adapter_normalizes_terminal_turn_result() -> None:
    result = TurnProcessingResult(
        agent_text="Understood. Goodbye.",
        new_state=ConversationState.COMPLETED,
        tool_called=ToolCall(name="record_opt_out", tool_call_id=str(uuid4()), args={}),
        outcome=Outcome.OPT_OUT,
        intent_satisfied=False,
    )

    adapted = normalize_turn_processing_result(result)
    assert adapted.spoken_text == "Understood. Goodbye."
    assert adapted.turn_decision.suggested_next_state == ConversationState.COMPLETED
    assert adapted.turn_decision.tool_call is not None
    assert adapted.turn_decision.intent_satisfied is False
    assert adapted.should_end_call is True
    assert adapted.allow_interruptions is False


def test_metrics_endpoint_returns_snapshot() -> None:
    client = TestClient(app)
    response = client.get("/metrics")
    assert response.status_code == 200
    payload = response.json()
    assert "uptime_seconds" in payload
    assert "counters" in payload
    assert "recent_traces" in payload


def test_replay_handles_inflight_conversation_after_restart_boundary() -> None:
    events = [
        SimpleNamespace(
            sequence_no=1,
            type=EventType.STATE_TRANSITION,
            payload={"to": "GREETING"},
            created_at=datetime.now(timezone.utc),
        ),
        SimpleNamespace(
            sequence_no=2,
            type=EventType.STATE_TRANSITION,
            payload={"to": "VERIFYING_IDENTITY"},
            created_at=datetime.now(timezone.utc),
        ),
        SimpleNamespace(
            sequence_no=3,
            type=EventType.STATE_TRANSITION,
            payload={"to": "DISCUSSING_PAYMENT"},
            created_at=datetime.now(timezone.utc),
        ),
        SimpleNamespace(
            sequence_no=4,
            type=EventType.TOOL_CALLED,
            payload={"name": "schedule_callback"},
            created_at=datetime.now(timezone.utc),
        ),
    ]

    replayed = replay_conversation_state(events)  # type: ignore[arg-type]
    assert replayed["current_state"] == "DISCUSSING_PAYMENT"
    assert replayed["final_outcome"] is None
    assert replayed["executed_tools"] == ["schedule_callback"]


def test_replay_ignores_invalid_future_state_values() -> None:
    events = [
        SimpleNamespace(
            sequence_no=1,
            type=EventType.STATE_TRANSITION,
            payload={"to": "GREETING"},
            created_at=datetime.now(timezone.utc),
        ),
        SimpleNamespace(
            sequence_no=2,
            type=EventType.STATE_TRANSITION,
            payload={"to": "FUTURE_STATE"},
            created_at=datetime.now(timezone.utc),
        ),
    ]

    replayed = replay_conversation_state(events)  # type: ignore[arg-type]
    assert replayed["current_state"] == "GREETING"


@pytest.mark.anyio
async def test_execute_tool_rejects_invalid_state_before_side_effects() -> None:
    with pytest.raises(ToolExecutionError):
        await execute_tool(
            session=object(),  # type: ignore[arg-type]
            conversation=SimpleNamespace(id=uuid4()),
            current_state=ConversationState.GREETING,
            tool_call=ToolCall(name="record_promise_to_pay", args={"date": "2026-03-24", "amount": "10.00"}),
        )


@pytest.mark.anyio
async def test_process_user_turn_uses_current_state_for_promise_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    conversation_id = uuid4()
    borrower_id = uuid4()
    contact_point_id = uuid4()
    workflow_execution_id = uuid4()
    call_attempt_id = uuid4()
    conversation = SimpleNamespace(
        id=conversation_id,
        borrower_id=borrower_id,
        call_attempt_id=call_attempt_id,
        final_outcome=None,
        final_outcome_metadata={"promised_date": "2026-03-27", "promised_amount": "10.00"},
        protected_context_unlocked=True,
        events=[
            SimpleNamespace(
                type=EventType.STATE_TRANSITION,
                payload={"to": ConversationState.CONFIRMING_OUTCOME.value},
                sequence_no=1,
            )
        ],
        call_attempt=SimpleNamespace(
            contact_point_id=contact_point_id,
            workflow_execution_id=workflow_execution_id,
            workflow_execution=SimpleNamespace(
                workflow_type=SimpleNamespace(value="PAYMENT_REMINDER"),
                current_attempt_no=1,
            ),
        ),
    )
    session = SimpleNamespace(commit=AsyncMock())
    executed: dict[str, object] = {}

    monkeypatch.setattr(cs, "get_conversation_with_related", AsyncMock(return_value=conversation))
    monkeypatch.setattr(cs, "append_event", AsyncMock())
    monkeypatch.setattr(
        cs,
        "_build_session_state",
        AsyncMock(
            return_value=SessionState(
                workflow_execution_id=workflow_execution_id,
                call_attempt_id=call_attempt_id,
                conversation_id=conversation_id,
                contact_point_id=contact_point_id,
                borrower_id=borrower_id,
                current_state=ConversationState.CONFIRMING_OUTCOME,
                protected_context_unlocked=True,
                public_context={},
                protected_context={"balance_due": "10.00"},
                memory_context={"promised_date": "2026-03-27", "promised_amount": "10.00"},
            )
        ),
    )
    monkeypatch.setattr(
        cs,
        "_generate_turn_decision",
        lambda _session_state, _text: TurnDecision(
            message="Thank you. I am recording that commitment now.",
            tool_call=ToolCall(
                name="record_promise_to_pay",
                args={"date": "2026-03-27", "amount": "10.00", "notes": "confirmed by borrower"},
            ),
            intent_satisfied=True,
            suggested_next_state=ConversationState.ENDING,
        ),
    )

    async def fake_execute_tool(_session, _conversation, current_state, tool_call):
        executed["state"] = current_state
        executed["tool"] = tool_call.name
        conversation.final_outcome = Outcome.PROMISE_TO_PAY
        return {"promised_amount": "10.00", "promised_date": "2026-03-27"}

    monkeypatch.setattr(cs, "execute_tool", fake_execute_tool)
    monkeypatch.setattr(cs, "finalize_conversation", AsyncMock())

    result = await cs.process_user_turn(session, conversation_id, "yes")
    assert executed["tool"] == "record_promise_to_pay"
    assert executed["state"] == ConversationState.CONFIRMING_OUTCOME
    assert result.outcome == Outcome.PROMISE_TO_PAY


def test_discussing_payment_marks_intro_done_after_first_turn() -> None:
    session_state = SessionState(
        workflow_execution_id=uuid4(),
        call_attempt_id=uuid4(),
        conversation_id=uuid4(),
        contact_point_id=uuid4(),
        borrower_id=uuid4(),
        current_state=ConversationState.DISCUSSING_PAYMENT,
        protected_context_unlocked=True,
        public_context={"company": "Feather-Lite"},
        protected_context={"balance_due": "550.00", "due_date": "2026-03-30"},
        memory_context={"_payment_intro_done": True},
    )

    decision = cs._generate_turn_decision(session_state, "call me back tomorrow")
    assert decision.tool_call is not None
    assert "Your current balance due is" not in decision.message


def test_extract_amount_requires_payment_like_amounts() -> None:
    assert cs._extract_amount("I will pay $125 tomorrow") == "125.00"
    assert cs._extract_amount("I will pay on the 15th") is None
    assert cs._extract_amount("call me back in 2 days") is None
