from uuid import uuid4

from app.core.enums import ConversationState
from app.voice.prompt_builder import build_prompt
from app.voice.session_state import SessionState


def test_prompt_builder_hides_protected_context_before_unlock() -> None:
    session_state = SessionState(
        workflow_execution_id=uuid4(),
        call_attempt_id=uuid4(),
        conversation_id=uuid4(),
        contact_point_id=uuid4(),
        borrower_id=uuid4(),
        current_state=ConversationState.VERIFYING_IDENTITY,
        protected_context_unlocked=False,
        public_context={"company": "Feather-Lite"},
        protected_context={"balance_due": "550.00"},
    )

    prompt = build_prompt(session_state, ["lookup_contact_profile"])
    dynamic = prompt["dynamic_instructions"]
    assert dynamic["protected_context"] == {}


def test_prompt_builder_includes_protected_context_after_unlock() -> None:
    session_state = SessionState(
        workflow_execution_id=uuid4(),
        call_attempt_id=uuid4(),
        conversation_id=uuid4(),
        contact_point_id=uuid4(),
        borrower_id=uuid4(),
        current_state=ConversationState.DISCUSSING_PAYMENT,
        protected_context_unlocked=True,
        public_context={"company": "Feather-Lite"},
        protected_context={"balance_due": "550.00"},
    )

    prompt = build_prompt(session_state, ["get_account_context"])
    dynamic = prompt["dynamic_instructions"]
    assert dynamic["protected_context"]["balance_due"] == "550.00"
