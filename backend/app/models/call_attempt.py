from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum as SAEnum, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import CallAttemptStatus, CallDirection
from app.models.base import Base


class CallAttempt(Base):
    __tablename__ = "call_attempts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    workflow_execution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_executions.id"),
        nullable=False,
    )
    contact_point_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("contact_points.id"),
        nullable=False,
    )
    direction: Mapped[CallDirection] = mapped_column(
        SAEnum(CallDirection, name="call_direction", native_enum=False),
        nullable=False,
    )
    provider_call_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attempt_status: Mapped[CallAttemptStatus] = mapped_column(
        SAEnum(CallAttemptStatus, name="call_attempt_status", native_enum=False),
        default=CallAttemptStatus.INITIATED,
        nullable=False,
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    workflow_execution = relationship("WorkflowExecution", back_populates="call_attempts")
    contact_point = relationship("ContactPoint", back_populates="call_attempts")
    conversation = relationship("Conversation", back_populates="call_attempt", uselist=False)
