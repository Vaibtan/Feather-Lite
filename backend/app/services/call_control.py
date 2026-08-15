from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import EventType
from app.models.conversation import Conversation
from app.models.conversation_event import ConversationEvent
from app.services.conversation_store import append_event


async def _find_existing_call_control_payload(
    session: AsyncSession,
    conversation: Conversation,
    action_id: str,
) -> dict[str, Any] | None:
    events = list(
        (
            await session.scalars(
                select(ConversationEvent)
                .where(
                    ConversationEvent.conversation_id == conversation.id,
                    ConversationEvent.type == EventType.CALL_CONTROL,
                )
                .order_by(ConversationEvent.sequence_no.asc())
            )
        ).all()
    )
    for event in events:
        if event.payload.get("action_id") == action_id:
            return dict(event.payload)
    return None


async def log_call_control_action(
    session: AsyncSession,
    conversation: Conversation,
    action: str,
    payload: dict[str, Any] | None = None,
    *,
    action_id: str | None = None,
) -> dict[str, Any]:
    event_action_id = action_id or str(uuid4())
    existing = await _find_existing_call_control_payload(session, conversation, event_action_id)
    if existing is not None:
        return existing

    event_payload = {
        "action": action,
        "action_id": event_action_id,
        **(payload or {}),
    }
    await append_event(
        session,
        conversation.id,
        EventType.CALL_CONTROL,
        event_payload,
        created_at=datetime.now(timezone.utc),
    )
    return event_payload


async def append_amd_result(
    session: AsyncSession,
    conversation: Conversation,
    *,
    machine_detected: bool,
    classification: str,
    confidence: float,
) -> None:
    await append_event(
        session,
        conversation.id,
        EventType.AMD_RESULT,
        {
            "machine_detected": machine_detected,
            "classification": classification,
            "confidence": confidence,
        },
    )


async def log_transfer_events(
    session: AsyncSession,
    conversation: Conversation,
    *,
    target: str,
    reason: str,
    action_id: str | None = None,
) -> dict[str, Any]:
    payload = await log_call_control_action(
        session,
        conversation,
        "WARM_TRANSFER",
        {"target": target, "reason": reason},
        action_id=action_id,
    )
    existing_transfer = list(
        (
            await session.scalars(
                select(ConversationEvent).where(
                    ConversationEvent.conversation_id == conversation.id,
                    ConversationEvent.type.in_(
                        [EventType.TRANSFER_REQUESTED, EventType.TRANSFER_COMPLETED]
                    ),
                )
            )
        ).all()
    )
    if not any(event.payload.get("action_id") == payload["action_id"] for event in existing_transfer):
        await append_event(
            session,
            conversation.id,
            EventType.TRANSFER_REQUESTED,
            {
                "target": target,
                "reason": reason,
                "action_id": payload["action_id"],
            },
        )
        await append_event(
            session,
            conversation.id,
            EventType.TRANSFER_COMPLETED,
            {
                "target": target,
                "reason": reason,
                "action_id": payload["action_id"],
                "status": "handoff_stubbed",
            },
        )
    return payload
