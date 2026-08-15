from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.schemas.testing import ScenarioRunResponse, ScenarioSummary
from app.services.scenario_runner import list_scenarios, run_scenario

router = APIRouter(prefix="/api/testing", tags=["testing"])


@router.get("/scenarios", response_model=list[ScenarioSummary])
async def list_scenarios_route() -> list[ScenarioSummary]:
    return list_scenarios()


@router.post("/scenarios/{scenario_id}/run", response_model=ScenarioRunResponse)
async def run_scenario_route(
    scenario_id: str,
    session: AsyncSession = Depends(get_db),
) -> ScenarioRunResponse:
    try:
        return await run_scenario(session, scenario_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
