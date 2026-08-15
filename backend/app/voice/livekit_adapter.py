from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.runtime import TurnDecision
from app.services.conversation_service import (
    TurnProcessingResult,
    process_no_input,
    process_user_turn,
)


@dataclass(slots=True)
class VoiceTurnAdapterResult:
    spoken_text: str
    allow_interruptions: bool
    should_end_call: bool
    turn_decision: TurnDecision
    call_control_action: dict[str, object] | None
    outcome: object | None


def normalize_turn_processing_result(result: TurnProcessingResult) -> VoiceTurnAdapterResult:
    turn_decision = TurnDecision(
        message=result.agent_text,
        tool_call=result.tool_called,
        intent_satisfied=result.intent_satisfied,
        suggested_next_state=result.new_state,
    )
    return VoiceTurnAdapterResult(
        spoken_text=result.agent_text,
        allow_interruptions=result.outcome is None,
        should_end_call=result.outcome is not None,
        turn_decision=turn_decision,
        call_control_action=result.call_control_action,
        outcome=result.outcome,
    )


async def process_voice_turn(
    session: AsyncSession,
    conversation_id: UUID,
    user_text: str | None,
) -> VoiceTurnAdapterResult:
    if user_text and user_text.strip():
        result = await process_user_turn(session, conversation_id, user_text.strip())
    else:
        result = await process_no_input(session, conversation_id)
    return normalize_turn_processing_result(result)
