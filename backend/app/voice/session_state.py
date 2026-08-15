from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from app.core.enums import ConversationState


@dataclass(slots=True)
class SessionState:
    workflow_execution_id: UUID
    call_attempt_id: UUID
    conversation_id: UUID
    contact_point_id: UUID
    borrower_id: UUID
    current_state: ConversationState
    protected_context_unlocked: bool
    public_context: dict[str, Any] = field(default_factory=dict)
    protected_context: dict[str, Any] = field(default_factory=dict)
    memory_context: dict[str, Any] = field(default_factory=dict)
