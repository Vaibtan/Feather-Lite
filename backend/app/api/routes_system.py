from fastapi import APIRouter, Depends, HTTPException, status

from app.core.config import Settings, get_settings
from app.core.db import check_database_health
from app.schemas.system import HealthResponse, MetricsResponse, ReadinessResponse
from app.services.observability import metrics

router = APIRouter(tags=["system"])


@router.get("/healthz", response_model=HealthResponse)
async def healthz(settings: Settings = Depends(get_settings)) -> HealthResponse:
    return HealthResponse(
        status="ok",
        app_name=settings.app_name,
        environment=settings.environment,
        version=settings.app_version,
    )


@router.get("/readyz", response_model=ReadinessResponse)
async def readyz(settings: Settings = Depends(get_settings)) -> ReadinessResponse:
    database_ok = await check_database_health()
    if not database_ok:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is not ready",
        )

    return ReadinessResponse(
        status="ready",
        app_name=settings.app_name,
        environment=settings.environment,
        version=settings.app_version,
        database="ok",
    )


@router.get("/metrics", response_model=MetricsResponse)
async def get_metrics() -> MetricsResponse:
    return MetricsResponse(**metrics.snapshot())
