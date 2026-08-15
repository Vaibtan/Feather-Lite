from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Enum as SAEnum, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import Outcome
from app.models.base import Base


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    call_attempt_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("call_attempts.id"),
        nullable=False,
        unique=True,
    )
    borrower_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("borrowers.id"), nullable=False)
    agent_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agent_versions.id"),
        nullable=False,
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    final_outcome: Mapped[Outcome | None] = mapped_column(
        SAEnum(Outcome, name="conversation_outcome", native_enum=False),
        nullable=True,
    )
    final_outcome_metadata: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    channel: Mapped[str] = mapped_column(String(32), nullable=False)
    transfer_target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    protected_context_unlocked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    call_attempt = relationship("CallAttempt", back_populates="conversation")
    borrower = relationship("Borrower", back_populates="conversations")
    agent_version = relationship("AgentVersion", back_populates="conversations")
    events = relationship("ConversationEvent", back_populates="conversation", cascade="all, delete-orphan")
