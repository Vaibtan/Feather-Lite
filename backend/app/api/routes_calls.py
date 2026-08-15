from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.errors import NotFoundError, ValidationError
from app.schemas.calls import StartCallRequest, StartCallResponse
from app.services.workflow_service import start_call

router = APIRouter(prefix="/api/calls", tags=["calls"])


@router.post("/start", response_model=StartCallResponse)
async def start_call_route(
    request: StartCallRequest,
    session: AsyncSession = Depends(get_db),
) -> StartCallResponse:
    try:
        return await start_call(session, request)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        failures = [part for part in str(exc).split(",") if part]
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "error": "Pre-call validation failed",
                "validation_failures": failures,
            },
        ) from exc
