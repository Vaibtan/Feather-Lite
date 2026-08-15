from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Awaitable, Callable
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    BorrowerStatus,
    ConsentStatus,
    ContactPointType,
    ContactRelationship,
    ConversationState,
    EventType,
    LoanStatus,
)
from app.models import Borrower, BorrowerContactPoint, ContactPoint, Loan, ScheduledAction
from app.schemas.calls import StartCallRequest
from app.schemas.runtime import SimulationTurnRequest, ToolCall
from app.schemas.testing import ScenarioRunResponse, ScenarioSummary
from app.services.conversation_service import (
    finalize_conversation,
    get_conversation_detail,
    process_call_control_signal,
    process_no_input,
    simulate_turn,
)
from app.services.conversation_store import append_event, get_conversation_with_related
from app.services.replay_service import replay_conversation_state
from app.services.tool_dispatcher import execute_tool
from app.services.workflow_service import start_call


@dataclass(slots=True)
class ScenarioStep:
    kind: str
    value: str | None = None
    payload: dict[str, object] = field(default_factory=dict)


ScenarioValidator = Callable[[AsyncSession, object, object], Awaitable[list[str]]]
ScenarioExecutor = Callable[[AsyncSession, str], Awaitable[None]]


@dataclass(slots=True)
class ScenarioDefinition:
    scenario_id: str
    description: str
    steps: list[ScenarioStep]
    expected_state_path: list[str]
    expected_tools: list[str]
    expected_call_control_actions: list[str]
    required_event_types: list[str]
    expected_final_outcome: str | None
    validator: ScenarioValidator | None = None
    executor: ScenarioExecutor | None = None


async def _validate_no_protected_context_before_verification(
    session: AsyncSession,
    conversation,
    detail,
) -> list[str]:
    del session, conversation
    failures: list[str] = []
    disclosure_cutoff = next(
        (
            index
            for index, entry in enumerate(detail.event_timeline)
            if entry.type == "STATE_TRANSITION" and entry.payload.get("to") == "DISCUSSING_PAYMENT"
        ),
        len(detail.event_timeline),
    )
    visible_agent_turns = [
        entry.payload.get("text", "")
        for entry in detail.event_timeline[:disclosure_cutoff]
        if entry.type == "AGENT_TURN"
    ]
    if any(
        "balance due" in str(text).lower() or "due date" in str(text).lower()
        for text in visible_agent_turns
    ):
        failures.append("protected context leaked before verification")
    return failures


async def _validate_duplicate_tool_idempotency(
    session: AsyncSession,
    conversation,
    detail,
) -> list[str]:
    failures: list[str] = []
    tool_result_count = sum(
        1
        for event in detail.event_timeline
        if event.type == "TOOL_RESULT"
        and event.payload.get("tool_call_id") == "duplicate-schedule-callback"
    )
    if tool_result_count != 1:
        failures.append("duplicate tool call produced multiple tool results")

    action_count = await session.scalar(
        select(func.count(ScheduledAction.id)).where(
            ScheduledAction.workflow_execution_id == conversation.call_attempt.workflow_execution_id,
        )
    )
    if int(action_count or 0) != 1:
        failures.append("duplicate tool call produced multiple scheduled actions")
    return failures


async def _execute_duplicate_tool_scenario(session: AsyncSession, conversation_id: str) -> None:
    conversation = await get_conversation_with_related(session, conversation_id)
    await simulate_turn(
        session,
        conversation.id,
        SimulationTurnRequest(user_text="yes this is Jordan"),
    )
    await simulate_turn(
        session,
        conversation.id,
        SimulationTurnRequest(user_text="yes"),
    )
    conversation = await get_conversation_with_related(session, conversation.id)
    tool = ToolCall(
        name="schedule_callback",
        tool_call_id="duplicate-schedule-callback",
        args={"datetime": "2026-03-24T10:00:00+00:00", "reason": "duplicate_test"},
    )
    await execute_tool(session, conversation, ConversationState.CONFIRMING_OUTCOME, tool)
    await execute_tool(session, conversation, ConversationState.CONFIRMING_OUTCOME, tool)
    await append_event(
        session,
        conversation.id,
        EventType.STATE_TRANSITION,
        {
            "from": ConversationState.DISCUSSING_PAYMENT.value,
            "to": ConversationState.CONFIRMING_OUTCOME.value,
            "triggered_by": "TEST_DUPLICATE_TOOL",
        },
    )
    await append_event(
        session,
        conversation.id,
        EventType.AGENT_TURN,
        {
            "text": "Understood. I have scheduled a callback for 2026-03-24T10:00:00+00:00.",
            "state": ConversationState.CONFIRMING_OUTCOME.value,
        },
    )
    await finalize_conversation(
        session,
        conversation,
        ConversationState.CONFIRMING_OUTCOME,
        conversation.final_outcome,
    )
    await session.commit()


SCENARIOS: dict[str, ScenarioDefinition] = {
    "happy-path-promise-to-pay": ScenarioDefinition(
        scenario_id="happy-path-promise-to-pay",
        description="Right-party verification followed by a confirmed promise to pay.",
        steps=[
            ScenarioStep("user_turn", "yes this is Jordan"),
            ScenarioStep("user_turn", "yes"),
            ScenarioStep("user_turn", "I will pay 550 on friday"),
            ScenarioStep("user_turn", "yes"),
        ],
        expected_state_path=[
            "GREETING",
            "VERIFYING_IDENTITY",
            "DISCUSSING_PAYMENT",
            "CONFIRMING_OUTCOME",
            "ENDING",
            "COMPLETED",
        ],
        expected_tools=["record_promise_to_pay"],
        expected_call_control_actions=[],
        required_event_types=["CALL_STARTED", "TOOL_RESULT", "CALL_ENDED", "OUTBOX_ENQUEUED"],
        expected_final_outcome="PROMISE_TO_PAY",
    ),
    "happy-path-callback-scheduled": ScenarioDefinition(
        scenario_id="happy-path-callback-scheduled",
        description="Right-party verification followed by callback scheduling.",
        steps=[
            ScenarioStep("user_turn", "yes this is Jordan"),
            ScenarioStep("user_turn", "yes"),
            ScenarioStep("user_turn", "call me back tomorrow"),
        ],
        expected_state_path=[
            "GREETING",
            "VERIFYING_IDENTITY",
            "DISCUSSING_PAYMENT",
            "CONFIRMING_OUTCOME",
            "ENDING",
            "COMPLETED",
        ],
        expected_tools=["schedule_callback"],
        expected_call_control_actions=[],
        required_event_types=["CALL_STARTED", "TOOL_RESULT", "CALL_ENDED", "OUTBOX_ENQUEUED"],
        expected_final_outcome="CALLBACK_SCHEDULED",
    ),
    "wrong-number-immediate": ScenarioDefinition(
        scenario_id="wrong-number-immediate",
        description="Immediate wrong-number disposition.",
        steps=[ScenarioStep("user_turn", "wrong number")],
        expected_state_path=["GREETING", "WRONG_NUMBER", "ENDING", "COMPLETED"],
        expected_tools=["record_wrong_party_contact"],
        expected_call_control_actions=[],
        required_event_types=["CALL_STARTED", "TOOL_RESULT", "CALL_ENDED"],
        expected_final_outcome="WRONG_NUMBER",
    ),
    "wrong-party-during-verification": ScenarioDefinition(
        scenario_id="wrong-party-during-verification",
        description="Third party reached during identity verification.",
        steps=[
            ScenarioStep("user_turn", "yes this is Jordan"),
            ScenarioStep("user_turn", "the borrower is not available right now"),
        ],
        expected_state_path=[
            "GREETING",
            "VERIFYING_IDENTITY",
            "THIRD_PARTY_OR_WRONG_PARTY",
            "ENDING",
            "COMPLETED",
        ],
        expected_tools=["record_wrong_party_contact"],
        expected_call_control_actions=[],
        required_event_types=["CALL_STARTED", "TOOL_RESULT", "CALL_ENDED"],
        expected_final_outcome="THIRD_PARTY_CONTACT",
    ),
    "opt-out-immediate": ScenarioDefinition(
        scenario_id="opt-out-immediate",
        description="Borrower opts out before any account discussion.",
        steps=[ScenarioStep("user_turn", "stop calling me")],
        expected_state_path=["GREETING", "OPT_OUT", "ENDING", "COMPLETED"],
        expected_tools=["record_opt_out"],
        expected_call_control_actions=[],
        required_event_types=["CALL_STARTED", "TOOL_RESULT", "CALL_ENDED"],
        expected_final_outcome="OPT_OUT",
    ),
    "hardship-escalation": ScenarioDefinition(
        scenario_id="hardship-escalation",
        description="Hardship phrase triggers warm transfer follow-up path.",
        steps=[ScenarioStep("user_turn", "I lost my job and cannot afford this")],
        expected_state_path=["GREETING", "ESCALATED", "ENDING", "COMPLETED"],
        expected_tools=[],
        expected_call_control_actions=["WARM_TRANSFER"],
        required_event_types=["TRANSFER_REQUESTED", "TRANSFER_COMPLETED", "CALL_ENDED"],
        expected_final_outcome="ESCALATED",
    ),
    "debt-dispute-escalation": ScenarioDefinition(
        scenario_id="debt-dispute-escalation",
        description="Debt dispute triggers warm transfer follow-up path.",
        steps=[ScenarioStep("user_turn", "I dispute this debt")],
        expected_state_path=["GREETING", "ESCALATED", "ENDING", "COMPLETED"],
        expected_tools=[],
        expected_call_control_actions=["WARM_TRANSFER"],
        required_event_types=["TRANSFER_REQUESTED", "TRANSFER_COMPLETED", "CALL_ENDED"],
        expected_final_outcome="DISPUTED",
    ),
    "voicemail-drop": ScenarioDefinition(
        scenario_id="voicemail-drop",
        description="Answering-machine detection followed by voicemail drop.",
        steps=[ScenarioStep("call_control", "voicemail_drop", {"confidence": 0.99})],
        expected_state_path=["GREETING", "VOICEMAIL", "ENDING", "COMPLETED"],
        expected_tools=[],
        expected_call_control_actions=["VOICEMAIL_DROP"],
        required_event_types=["AMD_RESULT", "CALL_CONTROL", "CALL_ENDED"],
        expected_final_outcome="VOICEMAIL_LEFT",
    ),
    "no-input-timeout": ScenarioDefinition(
        scenario_id="no-input-timeout",
        description="Two consecutive no-input events close the attempt and schedule a retry.",
        steps=[ScenarioStep("no_input"), ScenarioStep("no_input")],
        expected_state_path=["GREETING", "ENDING", "COMPLETED"],
        expected_tools=[],
        expected_call_control_actions=["NO_INPUT_CLOSE"],
        required_event_types=["NO_INPUT", "CALL_CONTROL", "CALL_ENDED"],
        expected_final_outcome="NO_ANSWER",
    ),
    "barge-in-during-agent-speech": ScenarioDefinition(
        scenario_id="barge-in-during-agent-speech",
        description="Barge-in is logged while the borrower still completes a normal callback path.",
        steps=[
            ScenarioStep("call_control", "barge_in", {"partial_agent_text": "This is Feather-Lite Collections"}),
            ScenarioStep("user_turn", "yes this is Jordan"),
            ScenarioStep("user_turn", "yes"),
            ScenarioStep("user_turn", "call me back tomorrow"),
        ],
        expected_state_path=[
            "GREETING",
            "VERIFYING_IDENTITY",
            "DISCUSSING_PAYMENT",
            "CONFIRMING_OUTCOME",
            "ENDING",
            "COMPLETED",
        ],
        expected_tools=["schedule_callback"],
        expected_call_control_actions=["BARGE_IN_DETECTED"],
        required_event_types=["CALL_CONTROL", "TOOL_RESULT", "CALL_ENDED"],
        expected_final_outcome="CALLBACK_SCHEDULED",
    ),
    "duplicate-tool-call-idempotent": ScenarioDefinition(
        scenario_id="duplicate-tool-call-idempotent",
        description="A repeated tool_call_id does not duplicate side effects.",
        steps=[],
        expected_state_path=[
            "GREETING",
            "VERIFYING_IDENTITY",
            "DISCUSSING_PAYMENT",
            "CONFIRMING_OUTCOME",
            "ENDING",
            "COMPLETED",
        ],
        expected_tools=["schedule_callback"],
        expected_call_control_actions=[],
        required_event_types=["TOOL_RESULT"],
        expected_final_outcome="CALLBACK_SCHEDULED",
        validator=_validate_duplicate_tool_idempotency,
        executor=_execute_duplicate_tool_scenario,
    ),
    "protected-context-not-exposed-before-verification": ScenarioDefinition(
        scenario_id="protected-context-not-exposed-before-verification",
        description="Protected balance/due-date context remains hidden until right-party confirmation.",
        steps=[
            ScenarioStep("user_turn", "who is this"),
            ScenarioStep("user_turn", "yes this is Jordan"),
            ScenarioStep("user_turn", "call me back tomorrow"),
        ],
        expected_state_path=[
            "GREETING",
            "VERIFYING_IDENTITY",
            "DISCUSSING_PAYMENT",
            "CONFIRMING_OUTCOME",
            "ENDING",
            "COMPLETED",
        ],
        expected_tools=["schedule_callback"],
        expected_call_control_actions=[],
        required_event_types=["CALL_STARTED", "TOOL_RESULT", "CALL_ENDED"],
        expected_final_outcome="CALLBACK_SCHEDULED",
        validator=_validate_no_protected_context_before_verification,
    ),
}


def list_scenarios() -> list[ScenarioSummary]:
    return [
        ScenarioSummary(scenario_id=scenario.scenario_id, description=scenario.description)
        for scenario in SCENARIOS.values()
    ]


async def run_scenario(
    session: AsyncSession,
    scenario_id: str,
) -> ScenarioRunResponse:
    scenario = SCENARIOS.get(scenario_id)
    if scenario is None:
        raise ValueError(f"Unknown scenario: {scenario_id}")

    borrower, contact_point = await _create_scenario_fixture(session, scenario_id)
    # Freeze clock at 2pm ET so TCPA window check always passes
    from zoneinfo import ZoneInfo
    frozen_now = datetime(2026, 3, 26, 14, 0, 0, tzinfo=ZoneInfo("America/New_York"))
    start_response = await start_call(
        session,
        StartCallRequest(
            borrower_id=borrower.id,
            contact_point_id=contact_point.id,
        ),
        now=frozen_now,
    )

    if scenario.executor is not None:
        await scenario.executor(session, start_response.conversation_id)
    else:
        for step in scenario.steps:
            if step.kind == "user_turn" and step.value is not None:
                await simulate_turn(
                    session,
                    UUID(start_response.conversation_id),
                    SimulationTurnRequest(user_text=step.value),
                )
            elif step.kind == "no_input":
                await process_no_input(session, UUID(start_response.conversation_id))
            elif step.kind == "call_control" and step.value is not None:
                await process_call_control_signal(
                    session,
                    UUID(start_response.conversation_id),
                    step.value,
                    step.payload,
                )
            else:
                raise ValueError(f"Unsupported scenario step: {step.kind}")

    detail = await get_conversation_detail(session, UUID(start_response.conversation_id))
    conversation = await get_conversation_with_related(session, UUID(start_response.conversation_id))
    actual_state_path = [
        entry.payload["to"]
        for entry in detail.event_timeline
        if entry.type == "STATE_TRANSITION"
    ]
    actual_tools = [
        str(entry.payload.get("name"))
        for entry in detail.event_timeline
        if entry.type == "TOOL_CALLED"
    ]
    actual_call_control_actions = [
        str(entry.payload.get("action"))
        for entry in detail.event_timeline
        if entry.type == "CALL_CONTROL"
    ]
    actual_event_types = [entry.type for entry in detail.event_timeline]
    replay_snapshot = replay_conversation_state(conversation.events)

    assertion_failures: list[str] = []
    if actual_state_path != scenario.expected_state_path:
        assertion_failures.append("state path mismatch")
    if actual_tools != scenario.expected_tools:
        assertion_failures.append("tool sequence mismatch")
    if actual_call_control_actions != scenario.expected_call_control_actions:
        assertion_failures.append("call-control action mismatch")
    if detail.conversation["final_outcome"] != scenario.expected_final_outcome:
        assertion_failures.append("final outcome mismatch")
    missing_event_types = [
        event_type for event_type in scenario.required_event_types if event_type not in actual_event_types
    ]
    if missing_event_types:
        assertion_failures.append(f"missing event types: {', '.join(missing_event_types)}")
    if replay_snapshot.get("final_outcome") != scenario.expected_final_outcome:
        assertion_failures.append("replay final outcome mismatch")
    if scenario.validator is not None:
        assertion_failures.extend(await scenario.validator(session, conversation, detail))

    return ScenarioRunResponse(
        scenario_id=scenario.scenario_id,
        passed=not assertion_failures,
        conversation_id=start_response.conversation_id,
        expected_state_path=scenario.expected_state_path,
        actual_state_path=actual_state_path,
        expected_tools=scenario.expected_tools,
        actual_tools=actual_tools,
        expected_call_control_actions=scenario.expected_call_control_actions,
        actual_call_control_actions=actual_call_control_actions,
        required_event_types=scenario.required_event_types,
        actual_event_types=actual_event_types,
        expected_final_outcome=scenario.expected_final_outcome,
        final_outcome=detail.conversation["final_outcome"],
        replay_snapshot=replay_snapshot,
        assertion_failures=assertion_failures,
    )


async def _create_scenario_fixture(
    session: AsyncSession,
    scenario_id: str,
) -> tuple[Borrower, ContactPoint]:
    suffix = uuid4().hex[:10]
    borrower = Borrower(
        name=f"Scenario {scenario_id}",
        preferred_language="en",
        timezone="America/New_York",
        status=BorrowerStatus.ACTIVE,
    )
    contact_point = ContactPoint(
        type=ContactPointType.PHONE,
        value=f"+1555{suffix[:7]}",
        is_valid=True,
        consent_status=ConsentStatus.ALLOWED,
        timezone_override="America/New_York",
    )
    link = BorrowerContactPoint(
        borrower=borrower,
        contact_point=contact_point,
        priority=1,
        relationship=ContactRelationship.PRIMARY,
    )
    loan = Loan(
        borrower=borrower,
        principal=Decimal("10000.00"),
        balance_due=Decimal("550.00"),
        due_date=date.today(),
        status=LoanStatus.DELINQUENT,
        delinquency_days=15,
    )
    session.add_all([borrower, contact_point, link, loan])
    await session.commit()
    await session.refresh(borrower)
    await session.refresh(contact_point)
    return borrower, contact_point
