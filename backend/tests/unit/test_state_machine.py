import pytest

from app.core.enums import ConversationState
from app.core.errors import StateTransitionError
from app.services.state_machine import match_override, tool_allowed, validate_transition


def test_validate_transition_allows_expected_edge() -> None:
    result = validate_transition(
        ConversationState.VERIFYING_IDENTITY,
        ConversationState.DISCUSSING_PAYMENT,
    )
    assert result == ConversationState.DISCUSSING_PAYMENT


def test_validate_transition_rejects_invalid_edge() -> None:
    with pytest.raises(StateTransitionError):
        validate_transition(
            ConversationState.GREETING,
            ConversationState.CONFIRMING_OUTCOME,
        )


def test_override_match_detects_opt_out() -> None:
    override = match_override("please stop calling me")
    assert override is not None
    assert override.target_state == ConversationState.OPT_OUT


def test_tool_allowed_matrix() -> None:
    assert tool_allowed("record_promise_to_pay", ConversationState.CONFIRMING_OUTCOME)
    assert not tool_allowed("record_promise_to_pay", ConversationState.GREETING)
