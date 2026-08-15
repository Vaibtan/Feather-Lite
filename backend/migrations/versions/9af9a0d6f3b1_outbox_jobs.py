"""add outbox jobs

Revision ID: 9af9a0d6f3b1
Revises: 4695df21e44e
Create Date: 2026-03-23 15:25:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "9af9a0d6f3b1"
down_revision: Union[str, Sequence[str], None] = "4695df21e44e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


outbox_job_type = sa.Enum(
    "SUMMARY",
    "EVALUATION",
    "VECTOR_INDEX",
    name="outbox_job_type",
    native_enum=False,
)
outbox_job_status = sa.Enum(
    "PENDING",
    "CLAIMED",
    "DONE",
    "FAILED",
    name="outbox_job_status",
    native_enum=False,
)


def upgrade() -> None:
    op.create_table(
        "outbox_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("job_type", outbox_job_type, nullable=False),
        sa.Column("status", outbox_job_status, nullable=False, server_default="PENDING"),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "result",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error", sa.String(length=512), nullable=True),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], name="fk_outbox_jobs_conversation_id_conversations"),
    )
    op.create_index("ix_outbox_jobs_status_available_at", "outbox_jobs", ["status", "available_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_outbox_jobs_status_available_at", table_name="outbox_jobs")
    op.drop_table("outbox_jobs")
