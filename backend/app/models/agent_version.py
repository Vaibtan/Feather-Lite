from __future__ import annotations

import uuid

from sqlalchemy import Enum as SAEnum, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import AgentVersionStatus
from app.models.base import Base, TimestampMixin


class AgentVersion(TimestampMixin, Base):
    __tablename__ = "agent_versions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    prompt_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[AgentVersionStatus] = mapped_column(
        SAEnum(AgentVersionStatus, name="agent_version_status", native_enum=False),
        default=AgentVersionStatus.DRAFT,
        nullable=False,
    )

    conversations = relationship("Conversation", back_populates="agent_version")
