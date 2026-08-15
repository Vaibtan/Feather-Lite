from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    app_name: str
    environment: str
    version: str


class ReadinessResponse(HealthResponse):
    database: str


class MetricsResponse(BaseModel):
    uptime_seconds: float
    counters: dict[str, int]
    histograms: dict[str, dict[str, float]]
    recent_traces: list[dict]
