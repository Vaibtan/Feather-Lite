from uuid import UUID

from pydantic import BaseModel
from typing import Literal


class StartCallRequest(BaseModel):
    borrower_id: UUID
    contact_point_id: UUID
    channel: Literal["simulated", "voice"] = "simulated"


class StartCallResponse(BaseModel):
    conversation_id: str
    workflow_execution_id: str
    call_attempt_id: str
