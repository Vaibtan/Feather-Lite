from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import logging

from app.core.db import AsyncSessionFactory
from app.core.enums import ScheduledActionStatus
from app.models import ScheduledAction
from app.services.scheduled_action_service import claim_due_scheduled_actions, process_scheduled_action

logger = logging.getLogger("feather_lite.scheduled_actions")


class ScheduledActionWorker:
    async def run_once(self, limit: int = 20) -> list[dict[str, object]]:
        results: list[dict[str, object]] = []
        async with AsyncSessionFactory() as session:
            actions = await claim_due_scheduled_actions(session, limit=limit)
            await session.commit()
            action_ids = [action.id for action in actions]

        for action_id in action_ids:
            async with AsyncSessionFactory() as session:
                action = await session.get(ScheduledAction, action_id)
                if action is None or action.status != ScheduledActionStatus.CLAIMED:
                    continue
                try:
                    result = await process_scheduled_action(session, action)
                    await session.commit()
                    results.append(result)
                    logger.info(
                        "scheduled_action_processed",
                        extra={"action": action.action_type.value},
                    )
                except Exception as exc:
                    retry_count = int(action.payload.get("retry_count", 0)) + 1
                    if retry_count >= 3:
                        action.status = ScheduledActionStatus.CANCELED
                    else:
                        action.status = ScheduledActionStatus.PENDING
                        action.due_at = datetime.now(timezone.utc) + timedelta(
                            minutes=min(60, retry_count * 5)
                        )
                    action.payload = {
                        **action.payload,
                        "last_error": str(exc),
                        "retry_count": retry_count,
                    }
                    await session.commit()
                    logger.exception(
                        "scheduled_action_failed",
                        extra={"action": action.action_type.value},
                    )
                    results.append(
                        {
                            "action_type": action.action_type.value,
                            "status": action.status.value,
                            "error": str(exc),
                            "retry_count": retry_count,
                        }
                    )
        return results


async def _main() -> None:
    worker = ScheduledActionWorker()
    await worker.run_once()


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
