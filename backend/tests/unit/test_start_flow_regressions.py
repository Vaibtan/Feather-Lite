from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import routes_livekit
from app.core.errors import ExternalServiceError, NotFoundError, ValidationError
from app.main import app
from app.schemas.calls import StartCallRequest
from app.schemas.livekit import StartVoiceSessionRequest
from app.services import livekit_service
from app.services.conversation_service import _generate_turn_decision
from app.services.workflow_service import start_call
from app.voice.session_state import SessionState
from app.core.enums import ConversationState


def test_invalid_uuid_requests_return_422() -> None:
    client = TestClient(app)

    calls_response = client.post(
        "/api/calls/start",
        json={"borrower_id": "not-a-uuid", "contact_point_id": "still-not-a-uuid"},
    )
    assert calls_response.status_code == 422

    livekit_response = client.post(
        "/api/livekit/sessions/start",
        json={"borrower_id": "not-a-uuid", "contact_point_id": "still-not-a-uuid"},
    )
    assert livekit_response.status_code == 422


@pytest.mark.anyio
async def test_start_call_rejects_unlinked_contact_point() -> None:
    borrower_id = uuid4()
    contact_point_id = uuid4()
    fake_session = SimpleNamespace(
        get=AsyncMock(return_value=SimpleNamespace(id=contact_point_id)),
        scalar=AsyncMock(
            side_effect=[
                SimpleNamespace(id=borrower_id),
                None,
            ]
        ),
    )

    with pytest.raises(ValidationError, match="CONTACT_POINT_NOT_ASSOCIATED"):
        await start_call(
            fake_session,
            StartCallRequest(
                borrower_id=borrower_id,
                contact_point_id=contact_point_id,
            ),
        )


def test_confirming_outcome_allows_callback_request() -> None:
    session_state = SessionState(
        workflow_execution_id=uuid4(),
        call_attempt_id=uuid4(),
        conversation_id=uuid4(),
        contact_point_id=uuid4(),
        borrower_id=uuid4(),
        current_state=ConversationState.CONFIRMING_OUTCOME,
        protected_context_unlocked=True,
        public_context={"company": "Feather-Lite"},
        protected_context={"balance_due": "550.00"},
        memory_context={"promised_date": "2026-03-25", "promised_amount": "550.00"},
    )

    decision = _generate_turn_decision(session_state, "call me back tomorrow instead")
    assert decision.tool_call is not None
    assert decision.tool_call.name == "schedule_callback"
    assert decision.suggested_next_state == ConversationState.CONFIRMING_OUTCOME


@pytest.mark.anyio
async def test_livekit_bootstrap_failure_rolls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    borrower_id = uuid4()
    contact_point_id = uuid4()
    session = SimpleNamespace(
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )
    observed: dict[str, object] = {}

    async def fake_start_call(db_session, request, *, commit: bool = True):
        observed["commit"] = commit
        observed["channel"] = request.channel
        return SimpleNamespace(
            conversation_id=str(uuid4()),
            workflow_execution_id=str(uuid4()),
            call_attempt_id=str(uuid4()),
        )

    class FailingLiveKitAPI:
        def __init__(self, *args, **kwargs):
            self.room = SimpleNamespace(create_room=AsyncMock(side_effect=RuntimeError("room-create-failed")))
            self.agent_dispatch = SimpleNamespace(create_dispatch=AsyncMock())

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

    monkeypatch.setattr(livekit_service, "start_call", fake_start_call)
    monkeypatch.setattr(livekit_service.api, "LiveKitAPI", FailingLiveKitAPI)
    monkeypatch.setattr(
        livekit_service,
        "get_settings",
        lambda: SimpleNamespace(
            livekit_configured=True,
            livekit_url="wss://example.livekit.cloud",
            livekit_api_key="key",
            livekit_api_secret="secret",
            livekit_agent_name="feather-lite-agent",
            livekit_room_prefix="feather-lite",
            livekit_room_empty_timeout=300,
        ),
    )

    with pytest.raises(ExternalServiceError, match="LiveKit bootstrap failed"):
        await livekit_service.start_voice_session(
            session,
            StartVoiceSessionRequest(
                borrower_id=borrower_id,
                contact_point_id=contact_point_id,
            ),
        )

    assert observed["commit"] is False
    assert observed["channel"] == "voice"
    session.rollback.assert_awaited_once()
    session.commit.assert_not_awaited()


@pytest.mark.anyio
async def test_livekit_route_maps_client_and_service_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    request = StartVoiceSessionRequest(
        borrower_id=uuid4(),
        contact_point_id=uuid4(),
    )

    async def raise_not_found(session, request):
        raise NotFoundError("Borrower not found")

    monkeypatch.setattr(routes_livekit, "start_voice_session", raise_not_found)
    with pytest.raises(HTTPException) as not_found_exc:
        await routes_livekit.start_voice_session_route(request, session=object())
    assert not_found_exc.value.status_code == 404

    async def raise_validation(session, request):
        raise ValidationError("CONTACT_POINT_NOT_ASSOCIATED")

    monkeypatch.setattr(routes_livekit, "start_voice_session", raise_validation)
    with pytest.raises(HTTPException) as validation_exc:
        await routes_livekit.start_voice_session_route(request, session=object())
    assert validation_exc.value.status_code == 422

    async def raise_external(session, request):
        raise ExternalServiceError("LiveKit bootstrap failed")

    monkeypatch.setattr(routes_livekit, "start_voice_session", raise_external)
    with pytest.raises(HTTPException) as external_exc:
        await routes_livekit.start_voice_session_route(request, session=object())
    assert external_exc.value.status_code == 503
