from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.core.db import AsyncSessionFactory
from app.core.enums import OutboxJobStatus
from app.services.outbox_service import claim_due_outbox_jobs, process_outbox_job

logger = logging.getLogger("feather_lite.outbox")

MAX_RETRIES = 3


class OutboxWorker:
    async def run_once(self, limit: int = 20) -> list[dict[str, object]]:
        async with AsyncSessionFactory() as session:
            jobs = await claim_due_outbox_jobs(session, limit=limit)
            await session.commit()

        processed: list[dict[str, object]] = []
        for job in jobs:
            async with AsyncSessionFactory() as session:
                job_in_session = await session.get(type(job), job.id)
                if job_in_session is None:
                    continue
                try:
                    await process_outbox_job(session, job_in_session)
                    await session.commit()
                    logger.info(
                        "outbox_job_processed",
                        extra={"action": job_in_session.job_type.value},
                    )
                    processed.append(
                        {
                            "job_id": str(job_in_session.id),
                            "job_type": job_in_session.job_type.value,
                            "status": job_in_session.status.value,
                        }
                    )
                except Exception as exc:
                    retry_count = job_in_session.payload.get("retry_count", 0) + 1
                    if retry_count < MAX_RETRIES:
                        backoff_minutes = min(60, retry_count * 5)
                        job_in_session.status = OutboxJobStatus.PENDING
                        job_in_session.claimed_at = None
                        job_in_session.available_at = datetime.now(timezone.utc) + timedelta(minutes=backoff_minutes)
                        job_in_session.payload = {**job_in_session.payload, "retry_count": retry_count}
                        job_in_session.error = str(exc)
                        logger.warning(
                            "outbox_job_retrying",
                            extra={"action": job_in_session.job_type.value, "retry": retry_count},
                        )
                    else:
                        job_in_session.status = OutboxJobStatus.FAILED
                        job_in_session.error = str(exc)
                        logger.exception(
                            "outbox_job_failed_permanently",
                            extra={"action": job_in_session.job_type.value, "retries": retry_count},
                        )
                    await session.commit()
                    processed.append(
                        {
                            "job_id": str(job_in_session.id),
                            "job_type": job_in_session.job_type.value,
                            "status": job_in_session.status.value,
                            "error": str(exc),
                        }
                    )
        return processed


async def _main() -> None:
    worker = OutboxWorker()
    result = await worker.run_once()
    print(result)


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
