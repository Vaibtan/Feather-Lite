from __future__ import annotations

from app.core.enums import EventType
from app.models.conversation_event import ConversationEvent
from app.schemas.runtime import EventTimelineEntry, TranscriptEntry


def build_transcript(events: list[ConversationEvent]) -> list[TranscriptEntry]:
    transcript: list[TranscriptEntry] = []
    for event in sorted(events, key=lambda item: item.sequence_no):
        if event.type == EventType.USER_TURN_FINAL:
            transcript.append(
                TranscriptEntry(
                    speaker="BORROWER",
                    text=str(event.payload.get("text", "")),
                    timestamp=event.created_at.isoformat(),
                )
            )
        elif event.type == EventType.AGENT_TURN:
            transcript.append(
                TranscriptEntry(
                    speaker="AGENT",
                    text=str(event.payload.get("text", "")),
                    timestamp=event.created_at.isoformat(),
                )
            )
    return transcript


def build_event_timeline(events: list[ConversationEvent]) -> list[EventTimelineEntry]:
    return [
        EventTimelineEntry(
            type=event.type.value,
            payload=event.payload,
            created_at=event.created_at.isoformat(),
        )
        for event in sorted(events, key=lambda item: item.sequence_no)
    ]
