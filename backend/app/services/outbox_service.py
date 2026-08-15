from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import EventType, OutboxJobStatus, OutboxJobType
from app.models import Conversation, OutboxJob
from app.services.conversation_store import append_event, get_conversation_with_related
from app.services.transcript_service import build_transcript


async def enqueue_post_call_jobs(session: AsyncSession, conversation_id: UUID) -> list[OutboxJob]:
    jobs: list[OutboxJob] = []
    existing_job_types = set(
        (
            await session.scalars(
                select(OutboxJob.job_type).where(OutboxJob.conversation_id == conversation_id)
            )
        ).all()
    )
    for job_type in (OutboxJobType.SUMMARY, OutboxJobType.EVALUATION, OutboxJobType.VECTOR_INDEX):
        if job_type in existing_job_types:
            continue
        job = OutboxJob(
            conversation_id=conversation_id,
            job_type=job_type,
            status=OutboxJobStatus.PENDING,
            payload={"conversation_id": str(conversation_id)},
            result={},
            available_at=datetime.now(timezone.utc),
        )
        session.add(job)
        jobs.append(job)
    if not jobs:
        return []
    await session.flush()
    await append_event(
        session,
        conversation_id,
        EventType.OUTBOX_ENQUEUED,
        {"job_types": [job.job_type.value for job in jobs]},
    )
    return jobs


async def claim_due_outbox_jobs(session: AsyncSession, limit: int = 20) -> list[OutboxJob]:
    statement = (
        select(OutboxJob)
        .where(
            OutboxJob.status == OutboxJobStatus.PENDING,
            OutboxJob.available_at <= datetime.now(timezone.utc),
        )
        .order_by(OutboxJob.available_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    jobs = list((await session.scalars(statement)).all())
    now = datetime.now(timezone.utc)
    for job in jobs:
        job.status = OutboxJobStatus.CLAIMED
        job.claimed_at = now
    await session.flush()
    return jobs


async def process_outbox_job(session: AsyncSession, job: OutboxJob) -> OutboxJob:
    conversation = await get_conversation_with_related(session, job.conversation_id)
    if job.job_type == OutboxJobType.SUMMARY:
        result = await _build_summary(conversation)
    elif job.job_type == OutboxJobType.EVALUATION:
        result = await _build_evaluation(conversation)
    else:
        result = await _build_vector_index_stub(conversation)

    job.result = result
    job.error = None
    job.status = OutboxJobStatus.DONE
    job.processed_at = datetime.now(timezone.utc)
    await append_event(
        session,
        conversation.id,
        EventType.OUTBOX_PROCESSED,
        {"job_type": job.job_type.value, "result": result},
    )
    await session.flush()
    return job


def _compact_agent_text(text: str) -> str:
    return " ".join(text.split())[:220]


async def _build_summary(conversation: Conversation) -> dict[str, object]:
    transcript = build_transcript(sorted(conversation.events, key=lambda event: event.sequence_no))
    borrower_utterances = [entry.text for entry in transcript if entry.speaker == "BORROWER" and entry.text]
    agent_utterances = [entry.text for entry in transcript if entry.speaker == "AGENT" and entry.text]
    summary = {
        "final_outcome": conversation.final_outcome.value if conversation.final_outcome else None,
        "borrower_summary": borrower_utterances[-1] if borrower_utterances else "",
        "agent_summary": _compact_agent_text(agent_utterances[-1]) if agent_utterances else "",
        "transcript_turns": len(transcript),
    }
    return summary


async def _build_evaluation(conversation: Conversation) -> dict[str, object]:
    transcript = build_transcript(sorted(conversation.events, key=lambda event: event.sequence_no))
    agent_turns = [entry.text for entry in transcript if entry.speaker == "AGENT"]
    borrower_turns = [entry.text for entry in transcript if entry.speaker == "BORROWER"]
    unlock_sequence = next(
        (
            event.sequence_no
            for event in sorted(conversation.events, key=lambda event: event.sequence_no)
            if event.type == EventType.STATE_TRANSITION
            and event.payload.get("to") == "DISCUSSING_PAYMENT"
            and event.payload.get("triggered_by") == "LLM_INTENT"
        ),
        None,
    )
    protected_before_verification = any(
        event.type == EventType.AGENT_TURN
        and (
            "balance due" in str(event.payload.get("text", "")).lower()
            or "due date" in str(event.payload.get("text", "")).lower()
        )
        and (unlock_sequence is None or event.sequence_no < unlock_sequence)
        for event in conversation.events
    )
    return {
        "compliance_flags": [],
        "issues": ["PROTECTED_CONTEXT_BEFORE_VERIFICATION"] if protected_before_verification else [],
        "agent_turn_count": len(agent_turns),
        "borrower_turn_count": len(borrower_turns),
    }


async def _build_vector_index_stub(conversation: Conversation) -> dict[str, object]:
    return {
        "indexed": True,
        "conversation_id": str(conversation.id),
        "metadata": {
            "final_outcome": conversation.final_outcome.value if conversation.final_outcome else None,
        },
    }
