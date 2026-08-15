from __future__ import annotations

from dataclasses import dataclass

from app.core.enums import ConversationState
from app.core.errors import StateTransitionError


@dataclass(slots=True)
class OverrideMatch:
    target_state: ConversationState
    reason: str


# Normal state transitions. Override rules (OPT_OUT, WRONG_NUMBER,
# ESCALATED) bypass this map and can transition from any state.
# ESCALATED is reachable only via overrides (hardship/dispute).
ADJACENCY_MAP: dict[ConversationState, set[ConversationState]] = {
    ConversationState.GREETING: {
        ConversationState.VOICEMAIL,
        ConversationState.VERIFYING_IDENTITY,
    },
    ConversationState.VERIFYING_IDENTITY: {
        ConversationState.THIRD_PARTY_OR_WRONG_PARTY,
        ConversationState.DISCUSSING_PAYMENT,
    },
    ConversationState.DISCUSSING_PAYMENT: {
        ConversationState.CONFIRMING_OUTCOME,
        ConversationState.WARM_TRANSFER_PENDING,
        ConversationState.WRONG_NUMBER,
        ConversationState.OPT_OUT,
    },
    ConversationState.CONFIRMING_OUTCOME: {ConversationState.ENDING},
    ConversationState.VOICEMAIL: {ConversationState.ENDING},
    ConversationState.THIRD_PARTY_OR_WRONG_PARTY: {ConversationState.ENDING},
    ConversationState.WARM_TRANSFER_PENDING: {ConversationState.ENDING},
    ConversationState.OPT_OUT: {ConversationState.ENDING},
    ConversationState.WRONG_NUMBER: {ConversationState.ENDING},
    ConversationState.ESCALATED: {ConversationState.ENDING},
    ConversationState.ENDING: {ConversationState.COMPLETED},
    ConversationState.COMPLETED: set(),
}

TOOL_STATE_MATRIX: dict[str, set[ConversationState]] = {
    "lookup_contact_profile": {
        ConversationState.GREETING,
        ConversationState.VERIFYING_IDENTITY,
    },
    "get_account_context": {
        ConversationState.DISCUSSING_PAYMENT,
        ConversationState.CONFIRMING_OUTCOME,
    },
    "record_promise_to_pay": {ConversationState.CONFIRMING_OUTCOME},
    "schedule_callback": {
        ConversationState.DISCUSSING_PAYMENT,
        ConversationState.CONFIRMING_OUTCOME,
    },
    "record_opt_out": {ConversationState.OPT_OUT},
    "record_wrong_party_contact": {
        ConversationState.THIRD_PARTY_OR_WRONG_PARTY,
        ConversationState.WRONG_NUMBER,
    },
}

OVERRIDE_RULES: list[tuple[ConversationState, tuple[str, ...], str]] = [
    (
        ConversationState.OPT_OUT,
        ("stop calling", "don't call again", "remove my number", "cease contact"),
        "OPT_OUT",
    ),
    (
        ConversationState.ESCALATED,
        ("i dispute this", "not my debt", "prove i owe", "i don't owe this", "talk to my lawyer"),
        "DISPUTE",
    ),
    (
        ConversationState.ESCALATED,
        ("lost my job", "can't afford", "bankruptcy"),
        "HARDSHIP",
    ),
    (
        ConversationState.WRONG_NUMBER,
        ("wrong number", "no one by that name", "you have the wrong person"),
        "WRONG_NUMBER",
    ),
]


def validate_transition(
    current_state: ConversationState,
    suggested_state: ConversationState | None,
) -> ConversationState | None:
    if suggested_state is None or suggested_state == current_state:
        return suggested_state
    allowed = ADJACENCY_MAP.get(current_state, set())
    if suggested_state not in allowed:
        raise StateTransitionError(
            f"Invalid transition from {current_state.value} to {suggested_state.value}"
        )
    return suggested_state


def tool_allowed(tool_name: str, current_state: ConversationState) -> bool:
    return current_state in TOOL_STATE_MATRIX.get(tool_name, set())


def match_override(user_text: str) -> OverrideMatch | None:
    normalized = user_text.strip().lower()
    for target_state, phrases, reason in OVERRIDE_RULES:
        if any(phrase in normalized for phrase in phrases):
            return OverrideMatch(target_state=target_state, reason=reason)
    return None
