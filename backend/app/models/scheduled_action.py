from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Enum as SAEnum, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import ScheduledActionStatus, ScheduledActionType
from app.models.base import Base


class ScheduledAction(Base):
    __tablename__ = "scheduled_actions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    workflow_execution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_executions.id"),
        nullable=False,
    )
    action_type: Mapped[ScheduledActionType] = mapped_column(
        SAEnum(ScheduledActionType, name="scheduled_action_type", native_enum=False),
        nullable=False,
    )
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[ScheduledActionStatus] = mapped_column(
        SAEnum(ScheduledActionStatus, name="scheduled_action_status", native_enum=False),
        default=ScheduledActionStatus.PENDING,
        nullable=False,
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)

    workflow_execution = relationship("WorkflowExecution", back_populates="scheduled_actions")
