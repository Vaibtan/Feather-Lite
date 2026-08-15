"""initial schema

Revision ID: 4695df21e44e
Revises:
Create Date: 2026-03-22 22:56:30.410200

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "4695df21e44e"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


borrower_status = sa.Enum("ACTIVE", "OPT_OUT", "DECEASED", name="borrower_status", native_enum=False)
contact_point_type = sa.Enum("PHONE", name="contact_point_type", native_enum=False)
consent_status = sa.Enum("ALLOWED", "OPTED_OUT", "UNKNOWN", name="consent_status", native_enum=False)
contact_relationship = sa.Enum(
    "PRIMARY",
    "CO_BORROWER",
    "OTHER",
    name="contact_relationship",
    native_enum=False,
)
loan_status = sa.Enum("CURRENT", "DELINQUENT", name="loan_status", native_enum=False)
agent_version_status = sa.Enum("DRAFT", "ACTIVE", "RETIRED", name="agent_version_status", native_enum=False)
workflow_type = sa.Enum(
    "PAYMENT_REMINDER",
    "CALLBACK_FOLLOWUP",
    "ESCALATION_FOLLOWUP",
    name="workflow_type",
    native_enum=False,
)
workflow_execution_status = sa.Enum(
    "PENDING",
    "RUNNING",
    "COMPLETED",
    "FAILED",
    name="workflow_execution_status",
    native_enum=False,
)
call_direction = sa.Enum("OUTBOUND", "INBOUND", name="call_direction", native_enum=False)
call_attempt_status = sa.Enum(
    "INITIATED",
    "ANSWERED",
    "NO_ANSWER",
    "VOICEMAIL",
    "COMPLETED",
    "FAILED",
    name="call_attempt_status",
    native_enum=False,
)
conversation_outcome = sa.Enum(
    "PROMISE_TO_PAY",
    "CALLBACK_SCHEDULED",
    "WRONG_NUMBER",
    "OPT_OUT",
    "ESCALATED",
    "DISPUTED",
    "VOICEMAIL_LEFT",
    "THIRD_PARTY_CONTACT",
    "NO_ANSWER",
    "FAILED",
    name="conversation_outcome",
    native_enum=False,
)
event_type = sa.Enum(
    "CALL_STARTED",
    "CALL_CONTROL",
    "AMD_RESULT",
    "NO_INPUT",
    "USER_TURN",
    "USER_TURN_FINAL",
    "AGENT_TURN",
    "TOOL_CALLED",
    "TOOL_RESULT",
    "STATE_TRANSITION",
    "TRANSFER_REQUESTED",
    "TRANSFER_COMPLETED",
    "CALL_ENDED",
    name="event_type",
    native_enum=False,
)
scheduled_action_type = sa.Enum(
    "CALLBACK",
    "RETRY_CALL",
    "HUMAN_FOLLOWUP",
    name="scheduled_action_type",
    native_enum=False,
)
scheduled_action_status = sa.Enum(
    "PENDING",
    "CLAIMED",
    "DONE",
    "CANCELED",
    name="scheduled_action_status",
    native_enum=False,
)


def upgrade() -> None:
    op.create_table(
        "borrowers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("preferred_language", sa.String(length=16), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("status", borrower_status, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_borrowers_status", "borrowers", ["status"], unique=False)

    op.create_table(
        "contact_points",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("type", contact_point_type, nullable=False),
        sa.Column("value", sa.String(length=32), nullable=False),
        sa.Column("is_valid", sa.Boolean(), nullable=False),
        sa.Column("consent_status", consent_status, nullable=False),
        sa.Column("timezone_override", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("value", name="uq_contact_points_value"),
    )

    op.create_table(
        "agent_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("prompt_hash", sa.String(length=128), nullable=False),
        sa.Column("status", agent_version_status, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "borrower_contact_points",
        sa.Column("borrower_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contact_point_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("relationship", contact_relationship, nullable=False),
        sa.ForeignKeyConstraint(["borrower_id"], ["borrowers.id"], name="fk_borrower_contact_points_borrower_id_borrowers"),
        sa.ForeignKeyConstraint(
            ["contact_point_id"],
            ["contact_points.id"],
            name="fk_borrower_contact_points_contact_point_id_contact_points",
        ),
        sa.PrimaryKeyConstraint("borrower_id", "contact_point_id", name="pk_borrower_contact_points"),
    )
    op.create_index(
        "ix_borrower_contact_points_borrower_id_priority",
        "borrower_contact_points",
        ["borrower_id", "priority"],
        unique=False,
    )

    op.create_table(
        "loans",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("borrower_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("principal", sa.Numeric(12, 2), nullable=False),
        sa.Column("balance_due", sa.Numeric(12, 2), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("status", loan_status, nullable=False),
        sa.Column("delinquency_days", sa.Integer(), nullable=False),
        sa.Column("last_promise_date", sa.Date(), nullable=True),
        sa.ForeignKeyConstraint(["borrower_id"], ["borrowers.id"], name="fk_loans_borrower_id_borrowers"),
    )

    op.create_table(
        "workflow_executions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("borrower_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("loan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workflow_type", workflow_type, nullable=False),
        sa.Column("status", workflow_execution_status, nullable=False),
        sa.Column("current_attempt_no", sa.Integer(), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["borrower_id"], ["borrowers.id"], name="fk_workflow_executions_borrower_id_borrowers"),
        sa.ForeignKeyConstraint(["loan_id"], ["loans.id"], name="fk_workflow_executions_loan_id_loans"),
    )
    op.create_index(
        "ix_workflow_executions_borrower_id_status",
        "workflow_executions",
        ["borrower_id", "status"],
        unique=False,
    )

    op.create_table(
        "call_attempts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("workflow_execution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contact_point_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("direction", call_direction, nullable=False),
        sa.Column("provider_call_id", sa.String(length=255), nullable=True),
        sa.Column("attempt_status", call_attempt_status, nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["workflow_execution_id"],
            ["workflow_executions.id"],
            name="fk_call_attempts_workflow_execution_id_workflow_executions",
        ),
        sa.ForeignKeyConstraint(
            ["contact_point_id"],
            ["contact_points.id"],
            name="fk_call_attempts_contact_point_id_contact_points",
        ),
    )
    op.create_index(
        "ix_call_attempts_workflow_execution_id_started_at_desc",
        "call_attempts",
        ["workflow_execution_id", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_call_attempts_contact_point_id_started_at_desc",
        "call_attempts",
        ["contact_point_id", "started_at"],
        unique=False,
    )

    op.create_table(
        "scheduled_actions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("workflow_execution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("action_type", scheduled_action_type, nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", scheduled_action_status, nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.ForeignKeyConstraint(
            ["workflow_execution_id"],
            ["workflow_executions.id"],
            name="fk_scheduled_actions_workflow_execution_id_workflow_executions",
        ),
    )
    op.create_index(
        "ix_scheduled_actions_workflow_execution_id_status_due_at",
        "scheduled_actions",
        ["workflow_execution_id", "status", "due_at"],
        unique=False,
    )

    op.create_table(
        "conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("call_attempt_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("borrower_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("final_outcome", conversation_outcome, nullable=True),
        sa.Column("final_outcome_metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("channel", sa.String(length=32), nullable=False),
        sa.Column("transfer_target", sa.String(length=255), nullable=True),
        sa.Column("protected_context_unlocked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.ForeignKeyConstraint(["call_attempt_id"], ["call_attempts.id"], name="fk_conversations_call_attempt_id_call_attempts"),
        sa.ForeignKeyConstraint(["borrower_id"], ["borrowers.id"], name="fk_conversations_borrower_id_borrowers"),
        sa.ForeignKeyConstraint(["agent_version_id"], ["agent_versions.id"], name="fk_conversations_agent_version_id_agent_versions"),
        sa.UniqueConstraint("call_attempt_id", name="uq_conversations_call_attempt_id"),
    )
    op.create_index("ix_conversations_borrower_id_started_at_desc", "conversations", ["borrower_id", "started_at"], unique=False)

    op.create_table(
        "conversation_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sequence_no", sa.BigInteger(), nullable=False),
        sa.Column("type", event_type, nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], name="fk_conversation_events_conversation_id_conversations"),
        sa.UniqueConstraint("conversation_id", "sequence_no", name="uq_conversation_events_conversation_id"),
    )


def downgrade() -> None:
    op.drop_table("conversation_events")
    op.drop_index("ix_conversations_borrower_id_started_at_desc", table_name="conversations")
    op.drop_table("conversations")
    op.drop_index("ix_scheduled_actions_workflow_execution_id_status_due_at", table_name="scheduled_actions")
    op.drop_table("scheduled_actions")
    op.drop_index("ix_call_attempts_contact_point_id_started_at_desc", table_name="call_attempts")
    op.drop_index("ix_call_attempts_workflow_execution_id_started_at_desc", table_name="call_attempts")
    op.drop_table("call_attempts")
    op.drop_index("ix_workflow_executions_borrower_id_status", table_name="workflow_executions")
    op.drop_table("workflow_executions")
    op.drop_table("loans")
    op.drop_index("ix_borrower_contact_points_borrower_id_priority", table_name="borrower_contact_points")
    op.drop_table("borrower_contact_points")
    op.drop_table("agent_versions")
    op.drop_table("contact_points")
    op.drop_index("ix_borrowers_status", table_name="borrowers")
    op.drop_table("borrowers")
