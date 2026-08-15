from __future__ import annotations

from app.voice.session_state import SessionState


def build_prompt(
    session_state: SessionState,
    allowed_tools: list[str],
) -> dict[str, object]:
    instructions = [
        f"Current state: {session_state.current_state.value}",
        "Do not reveal protected borrower/account information before right-party verification.",
        "Stay within the allowed tool and state boundaries.",
    ]

    if session_state.protected_context_unlocked and session_state.protected_context:
        instructions.append("Protected account context is available for this turn.")

    return {
        "system_prompt": "\n".join(instructions),
        "dynamic_instructions": {
            "public_context": session_state.public_context,
            "protected_context": session_state.protected_context
            if session_state.protected_context_unlocked
            else {},
            "memory_context": session_state.memory_context
            if session_state.protected_context_unlocked
            else {},
        },
        "tool_allowlist": allowed_tools,
    }
