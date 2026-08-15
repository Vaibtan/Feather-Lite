from __future__ import annotations

from app.core.enums import ConversationState, EventType
from app.models.conversation_event import ConversationEvent


def replay_conversation_state(events: list[ConversationEvent]) -> dict[str, object]:
    ordered_events = sorted(events, key=lambda event: event.sequence_no)
    current_state = ConversationState.GREETING
    protected_context_unlocked = False
    final_outcome = None
    executed_tools: list[str] = []
    call_control_actions: list[str] = []

    for event in ordered_events:
        if event.type == EventType.STATE_TRANSITION:
            target_state = event.payload.get("to")
            if target_state:
                try:
                    current_state = ConversationState(target_state)
                except ValueError:
                    continue
                triggered_by = event.payload.get("triggered_by", "")
                if (
                    current_state == ConversationState.DISCUSSING_PAYMENT
                    and triggered_by == "LLM_INTENT"
                ):
                    protected_context_unlocked = True
        elif event.type == EventType.TOOL_CALLED:
            tool_name = event.payload.get("name")
            if tool_name:
                executed_tools.append(str(tool_name))
        elif event.type == EventType.CALL_CONTROL:
            action = event.payload.get("action")
            if action:
                call_control_actions.append(str(action))
        elif event.type == EventType.CALL_ENDED:
            final_outcome = event.payload.get("final_outcome")

    return {
        "current_state": current_state.value,
        "protected_context_unlocked": protected_context_unlocked,
        "final_outcome": final_outcome,
        "executed_tools": executed_tools,
        "call_control_actions": call_control_actions,
    }
