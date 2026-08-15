from __future__ import annotations

import uuid

from sqlalchemy import Boolean, Enum as SAEnum, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship as orm_relationship

from app.core.enums import ConsentStatus, ContactPointType, ContactRelationship
from app.models.base import Base, TimestampMixin


class ContactPoint(TimestampMixin, Base):
    __tablename__ = "contact_points"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    type: Mapped[ContactPointType] = mapped_column(
        SAEnum(ContactPointType, name="contact_point_type", native_enum=False),
        default=ContactPointType.PHONE,
        nullable=False,
    )
    value: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    is_valid: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    consent_status: Mapped[ConsentStatus] = mapped_column(
        SAEnum(ConsentStatus, name="consent_status", native_enum=False),
        default=ConsentStatus.UNKNOWN,
        nullable=False,
    )
    timezone_override: Mapped[str | None] = mapped_column(String(64), nullable=True)

    borrower_links = orm_relationship(
        "BorrowerContactPoint",
        back_populates="contact_point",
        cascade="all, delete-orphan",
    )
    call_attempts = orm_relationship("CallAttempt", back_populates="contact_point")


class BorrowerContactPoint(Base):
    __tablename__ = "borrower_contact_points"

    borrower_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("borrowers.id"),
        primary_key=True,
    )
    contact_point_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("contact_points.id"),
        primary_key=True,
    )
    priority: Mapped[int] = mapped_column(default=1, nullable=False)
    relationship: Mapped[ContactRelationship] = mapped_column(
        SAEnum(ContactRelationship, name="contact_relationship", native_enum=False),
        default=ContactRelationship.PRIMARY,
        nullable=False,
    )

    borrower = orm_relationship("Borrower", back_populates="contact_links")
    contact_point = orm_relationship("ContactPoint", back_populates="borrower_links")
