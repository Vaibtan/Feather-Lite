from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.errors import NotFoundError, ValidationError
from app.schemas.conversations import ConversationDetailResponse, ConversationListItem
from app.schemas.runtime import SimulationTurnRequest, SimulationTurnResponse
from app.services.conversation_service import (
    get_conversation_detail,
    list_conversations,
    simulate_turn,
)

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("", response_model=list[ConversationListItem])
async def list_conversations_route(
    session: AsyncSession = Depends(get_db),
) -> list[ConversationListItem]:
    return await list_conversations(session)


@router.get("/{conversation_id}", response_model=ConversationDetailResponse)
async def get_conversation_route(
    conversation_id: UUID,
    session: AsyncSession = Depends(get_db),
) -> ConversationDetailResponse:
    try:
        return await get_conversation_detail(session, conversation_id)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post("/{conversation_id}/simulate_turn", response_model=SimulationTurnResponse)
async def simulate_turn_route(
    conversation_id: UUID,
    request: SimulationTurnRequest,
    session: AsyncSession = Depends(get_db),
) -> SimulationTurnResponse:
    try:
        return await simulate_turn(session, conversation_id, request)
    except NotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
