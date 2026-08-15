from uuid import UUID

from pydantic import BaseModel


class StartVoiceSessionRequest(BaseModel):
    borrower_id: UUID
    contact_point_id: UUID
    participant_identity: str | None = None
    participant_name: str | None = None


class StartVoiceSessionResponse(BaseModel):
    conversation_id: str
    workflow_execution_id: str
    call_attempt_id: str
    room_name: str
    participant_identity: str
    participant_token: str
    livekit_url: str
    agent_name: str
    dispatch_id: str
