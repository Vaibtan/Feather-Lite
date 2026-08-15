from __future__ import annotations

import uuid

from sqlalchemy import Enum as SAEnum, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import BorrowerStatus
from app.models.base import Base, TimestampMixin


class Borrower(TimestampMixin, Base):
    __tablename__ = "borrowers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    preferred_language: Mapped[str] = mapped_column(String(16), default="en", nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[BorrowerStatus] = mapped_column(
        SAEnum(BorrowerStatus, name="borrower_status", native_enum=False),
        default=BorrowerStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    contact_links = relationship("BorrowerContactPoint", back_populates="borrower", cascade="all, delete-orphan")
    loans = relationship("Loan", back_populates="borrower", cascade="all, delete-orphan")
    workflows = relationship("WorkflowExecution", back_populates="borrower")
    conversations = relationship("Conversation", back_populates="borrower")
