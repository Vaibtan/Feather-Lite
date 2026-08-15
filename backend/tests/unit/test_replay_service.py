from datetime import datetime, timezone
from types import SimpleNamespace

from app.core.enums import EventType
from app.services.replay_service import replay_conversation_state


def test_replay_conversation_state() -> None:
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
            payload={"to": "DISCUSSING_PAYMENT", "triggered_by": "LLM_INTENT"},
            created_at=datetime.now(timezone.utc),
        ),
        SimpleNamespace(
            sequence_no=3,
            type=EventType.TOOL_CALLED,
            payload={"name": "record_promise_to_pay"},
            created_at=datetime.now(timezone.utc),
        ),
        SimpleNamespace(
            sequence_no=4,
            type=EventType.CALL_ENDED,
            payload={"final_outcome": "PROMISE_TO_PAY"},
            created_at=datetime.now(timezone.utc),
        ),
    ]

    replayed = replay_conversation_state(events)  # type: ignore[arg-type]
    assert replayed["current_state"] == "DISCUSSING_PAYMENT"
    assert replayed["protected_context_unlocked"] is True
    assert replayed["final_outcome"] == "PROMISE_TO_PAY"
    assert replayed["executed_tools"] == ["record_promise_to_pay"]
