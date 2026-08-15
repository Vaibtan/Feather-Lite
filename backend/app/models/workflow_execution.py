from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum as SAEnum, ForeignKey, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import WorkflowExecutionStatus, WorkflowType
from app.models.base import Base, TimestampMixin


class WorkflowExecution(TimestampMixin, Base):
    __tablename__ = "workflow_executions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    borrower_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("borrowers.id"), nullable=False)
    loan_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("loans.id"), nullable=False)
    workflow_type: Mapped[WorkflowType] = mapped_column(
        SAEnum(WorkflowType, name="workflow_type", native_enum=False),
        nullable=False,
    )
    status: Mapped[WorkflowExecutionStatus] = mapped_column(
        SAEnum(WorkflowExecutionStatus, name="workflow_execution_status", native_enum=False),
        default=WorkflowExecutionStatus.PENDING,
        nullable=False,
        index=True,
    )
    current_attempt_no: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    borrower = relationship("Borrower", back_populates="workflows")
    loan = relationship("Loan", back_populates="workflows")
    call_attempts = relationship("CallAttempt", back_populates="workflow_execution")
    scheduled_actions = relationship("ScheduledAction", back_populates="workflow_execution")
