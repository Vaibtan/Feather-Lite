from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Enum as SAEnum, ForeignKey, Integer, Numeric
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import LoanStatus
from app.models.base import Base


class Loan(Base):
    __tablename__ = "loans"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    borrower_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("borrowers.id"), nullable=False)
    principal: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    balance_due: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[LoanStatus] = mapped_column(
        SAEnum(LoanStatus, name="loan_status", native_enum=False),
        nullable=False,
    )
    delinquency_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_promise_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    borrower = relationship("Borrower", back_populates="loans")
    workflows = relationship("WorkflowExecution", back_populates="loan")
