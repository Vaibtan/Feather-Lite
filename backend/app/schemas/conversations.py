from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.schemas.runtime import EventTimelineEntry, TranscriptEntry


class ConversationListItem(BaseModel):
    conversation_id: str
    borrower_name: str
    started_at: str
    ended_at: str | None
    final_outcome: str | None
    duration_seconds: int | None
    channel: str


class ConversationDetailResponse(BaseModel):
    conversation: dict[str, Any]
    transcript: list[TranscriptEntry]
    event_timeline: list[EventTimelineEntry]
