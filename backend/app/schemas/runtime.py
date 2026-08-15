from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.core.enums import ConversationState, Outcome


class ToolCall(BaseModel):
    name: str
    tool_call_id: str | None = None
    args: dict[str, Any] = Field(default_factory=dict)


class TurnDecision(BaseModel):
    message: str
    tool_call: ToolCall | None = None
    intent_satisfied: bool
    suggested_next_state: ConversationState | None = None


class SimulationTurnRequest(BaseModel):
    user_text: str = Field(min_length=1)


class SimulationTurnResponse(BaseModel):
    agent_text: str
    new_state: ConversationState
    tool_called: ToolCall | None = None
    call_control_action: dict[str, Any] | None = None
    outcome: Outcome | None = None


class EventTimelineEntry(BaseModel):
    type: str
    payload: dict[str, Any]
    created_at: str


class TranscriptEntry(BaseModel):
    speaker: str
    text: str
    timestamp: str
