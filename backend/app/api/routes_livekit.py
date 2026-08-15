from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.errors import ExternalServiceError, NotFoundError, ValidationError
from app.schemas.livekit import StartVoiceSessionRequest, StartVoiceSessionResponse
from app.services.livekit_service import start_voice_session

router = APIRouter(prefix="/api/livekit", tags=["livekit"])


@router.post("/sessions/start", response_model=StartVoiceSessionResponse)
async def start_voice_session_route(
    request: StartVoiceSessionRequest,
    session: AsyncSession = Depends(get_db),
) -> StartVoiceSessionResponse:
    try:
        return await start_voice_session(session, request)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except ExternalServiceError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
