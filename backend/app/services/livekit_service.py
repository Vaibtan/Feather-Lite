from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from livekit import api
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import ExternalServiceError, ValidationError
from app.schemas.calls import StartCallRequest
from app.schemas.livekit import StartVoiceSessionRequest, StartVoiceSessionResponse
from app.services.workflow_service import start_call


def build_room_name(conversation_id: UUID) -> str:
    settings = get_settings()
    return f"{settings.livekit_room_prefix}-{conversation_id}"


def build_room_metadata(
    *,
    conversation_id: str,
    workflow_execution_id: str,
    call_attempt_id: str,
    borrower_id: str,
    contact_point_id: str,
) -> str:
    return json.dumps(
        {
            "conversation_id": conversation_id,
            "workflow_execution_id": workflow_execution_id,
            "call_attempt_id": call_attempt_id,
            "borrower_id": borrower_id,
            "contact_point_id": contact_point_id,
            "channel": "voice",
        }
    )


def parse_room_metadata(raw_metadata: str | None) -> dict[str, Any]:
    if not raw_metadata:
        return {}
    try:
        parsed = json.loads(raw_metadata)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def extract_conversation_id(raw_metadata: str | None, room_name: str | None = None) -> UUID | None:
    settings = get_settings()
    metadata = parse_room_metadata(raw_metadata)
    candidate = metadata.get("conversation_id")
    if isinstance(candidate, str):
        try:
            return UUID(candidate)
        except ValueError:
            return None

    prefix = f"{settings.livekit_room_prefix}-"
    if room_name and room_name.startswith(prefix):
        try:
            return UUID(room_name[len(prefix) :])
        except ValueError:
            return None
    return None


def _build_participant_identity(request: StartVoiceSessionRequest) -> str:
    if request.participant_identity:
        return request.participant_identity
    return f"borrower-{str(request.borrower_id)[:8]}"


def _build_participant_token(
    *,
    room_name: str,
    participant_identity: str,
    participant_name: str | None,
    metadata: str,
) -> str:
    settings = get_settings()
    parsed_metadata = parse_room_metadata(metadata)
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(participant_identity)
        .with_name(participant_name or participant_identity)
        .with_metadata(metadata)
        .with_attributes({"conversation_id": str(parsed_metadata.get("conversation_id", ""))})
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
    )
    return token.to_jwt()


async def start_voice_session(
    session: AsyncSession,
    request: StartVoiceSessionRequest,
) -> StartVoiceSessionResponse:
    settings = get_settings()
    if not settings.livekit_configured:
        raise ExternalServiceError(
            "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET."
        )

    call = await start_call(
        session,
        StartCallRequest(
            borrower_id=request.borrower_id,
            contact_point_id=request.contact_point_id,
            channel="voice",
        ),
        commit=False,
    )

    room_name = build_room_name(UUID(call.conversation_id))
    metadata = build_room_metadata(
        conversation_id=call.conversation_id,
        workflow_execution_id=call.workflow_execution_id,
        call_attempt_id=call.call_attempt_id,
        borrower_id=str(request.borrower_id),
        contact_point_id=str(request.contact_point_id),
    )

    dispatch_id: str | None = None
    room_created = False
    try:
        async with api.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        ) as lkapi:
            await lkapi.room.create_room(
                api.CreateRoomRequest(
                    name=room_name,
                    empty_timeout=settings.livekit_room_empty_timeout,
                    metadata=metadata,
                )
            )
            room_created = True
            dispatch = await lkapi.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(
                    agent_name=settings.livekit_agent_name,
                    room=room_name,
                    metadata=metadata,
                )
            )
            dispatch_id = dispatch.id
            await session.commit()
    except Exception as exc:
        await session.rollback()
        if room_created:
            await _cleanup_livekit_resources(room_name=room_name, dispatch_id=dispatch_id)
        raise ExternalServiceError(f"LiveKit bootstrap failed: {exc}") from exc

    participant_identity = _build_participant_identity(request)
    participant_token = _build_participant_token(
        room_name=room_name,
        participant_identity=participant_identity,
        participant_name=request.participant_name,
        metadata=metadata,
    )

    return StartVoiceSessionResponse(
        conversation_id=call.conversation_id,
        workflow_execution_id=call.workflow_execution_id,
        call_attempt_id=call.call_attempt_id,
        room_name=room_name,
        participant_identity=participant_identity,
        participant_token=participant_token,
        livekit_url=settings.livekit_url or "",
        agent_name=settings.livekit_agent_name,
        dispatch_id=dispatch_id or "",
    )


async def _cleanup_livekit_resources(*, room_name: str, dispatch_id: str | None) -> None:
    settings = get_settings()
    try:
        async with api.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        ) as lkapi:
            errors: list[str] = []
            if dispatch_id is not None:
                try:
                    await lkapi.agent_dispatch.delete_dispatch(dispatch_id, room_name)
                except Exception as exc:
                    errors.append(f"dispatch cleanup failed: {exc}")
            try:
                await lkapi.room.delete_room(api.DeleteRoomRequest(room=room_name))
            except Exception as exc:
                errors.append(f"room cleanup failed: {exc}")
            if errors:
                raise RuntimeError("; ".join(errors))
    except Exception as exc:
        import logging

        logging.getLogger("feather_lite.livekit").warning(
            "livekit_cleanup_failed room=%s dispatch_id=%s error=%s",
            room_name,
            dispatch_id,
            exc,
        )
