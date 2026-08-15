from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in (
            "conversation_id",
            "workflow_execution_id",
            "call_attempt_id",
            "scenario_id",
            "event_type",
            "action",
            "metric",
            "trace_name",
        ):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    root_logger = logging.getLogger()
    if getattr(configure_logging, "_configured", False):
        return
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter())
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)
    configure_logging._configured = True  # type: ignore[attr-defined]


class MetricsRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_at = time.time()
        self._counters: dict[str, int] = {}
        self._histograms: dict[str, dict[str, float]] = {}
        self._recent_traces: deque[dict[str, Any]] = deque(maxlen=200)

    @staticmethod
    def _key(name: str, labels: dict[str, Any] | None = None) -> str:
        if not labels:
            return name
        parts = ",".join(f"{key}={labels[key]}" for key in sorted(labels))
        return f"{name}|{parts}"

    def increment(
        self,
        name: str,
        value: int = 1,
        *,
        labels: dict[str, Any] | None = None,
    ) -> None:
        key = self._key(name, labels)
        with self._lock:
            self._counters[key] = self._counters.get(key, 0) + value

    def observe(
        self,
        name: str,
        value: float,
        *,
        labels: dict[str, Any] | None = None,
    ) -> None:
        key = self._key(name, labels)
        with self._lock:
            bucket = self._histograms.setdefault(
                key,
                {"count": 0.0, "total": 0.0, "max": float("-inf")},
            )
            bucket["count"] += 1
            bucket["total"] += value
            bucket["max"] = max(bucket["max"], value)

    def record_trace(
        self,
        trace_name: str,
        *,
        metadata: dict[str, Any] | None = None,
        latency_ms: float | None = None,
    ) -> None:
        trace = {
            "trace_name": trace_name,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "metadata": metadata or {},
        }
        if latency_ms is not None:
            trace["latency_ms"] = round(latency_ms, 2)
        with self._lock:
            self._recent_traces.appendleft(trace)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            histograms: dict[str, dict[str, float]] = {}
            for key, bucket in self._histograms.items():
                count = bucket["count"]
                histograms[key] = {
                    "count": int(count),
                    "total": round(bucket["total"], 2),
                    "max": round(bucket["max"], 2) if count else 0.0,
                    "avg": round(bucket["total"] / count, 2) if count else 0.0,
                }
            return {
                "uptime_seconds": round(time.time() - self._started_at, 2),
                "counters": dict(self._counters),
                "histograms": histograms,
                "recent_traces": list(self._recent_traces),
            }


metrics = MetricsRegistry()
