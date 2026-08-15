from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import ConversationState, EventType
from app.core.errors import NotFoundError
from app.models import CallAttempt, Conversation, ConversationEvent


async def get_conversation_with_related(
    session: AsyncSession,
    conversation_id: UUID,
    *,
    lock: bool = False,
) -> Conversation:
    statement = (
        select(Conversation)
        .options(
            selectinload(Conversation.borrower),
            selectinload(Conversation.call_attempt).selectinload(CallAttempt.contact_point),
            selectinload(Conversation.call_attempt).selectinload(CallAttempt.workflow_execution),
            selectinload(Conversation.agent_version),
            selectinload(Conversation.events),
        )
        .execution_options(populate_existing=True)
        .where(Conversation.id == conversation_id)
    )
    if lock:
        statement = statement.with_for_update()
    conversation = await session.scalar(statement)
    if conversation is None:
        raise NotFoundError(f"Conversation {conversation_id} not found")
    return conversation


async def get_next_sequence_no(session: AsyncSession, conversation_id: UUID) -> int:
    locked_conversation_id = await session.scalar(
        select(Conversation.id)
        .where(Conversation.id == conversation_id)
        .with_for_update()
    )
    if locked_conversation_id is None:
        raise NotFoundError(f"Conversation {conversation_id} not found")
    statement = select(func.max(ConversationEvent.sequence_no)).where(
        ConversationEvent.conversation_id == conversation_id
    )
    current_max = await session.scalar(statement)
    return 1 if current_max is None else int(current_max) + 1


async def append_event(
    session: AsyncSession,
    conversation_id: UUID,
    event_type: EventType,
    payload: dict[str, Any],
    *,
    created_at: datetime | None = None,
) -> ConversationEvent:
    event = ConversationEvent(
        conversation_id=conversation_id,
        sequence_no=await get_next_sequence_no(session, conversation_id),
        type=event_type,
        payload=payload,
        created_at=created_at or datetime.now(timezone.utc),
    )
    session.add(event)
    await session.flush()
    return event


def derive_current_state(conversation: Conversation) -> ConversationState:
    state_events = sorted(
        [
            event
            for event in conversation.events
            if event.type == EventType.STATE_TRANSITION
        ],
        key=lambda event: event.sequence_no,
    )
    if not state_events:
        return ConversationState.GREETING
    latest = state_events[-1].payload.get("to")
    if latest is None:
        return ConversationState.GREETING
    return ConversationState(latest)
