from __future__ import annotations

import asyncio
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from app.core.db import AsyncSessionFactory
from app.core.enums import (
    AgentVersionStatus,
    BorrowerStatus,
    CallDirection,
    CallAttemptStatus,
    ConsentStatus,
    ContactPointType,
    ContactRelationship,
    LoanStatus,
    Outcome,
    WorkflowExecutionStatus,
    WorkflowType,
)
from app.models import (
    AgentVersion,
    Borrower,
    BorrowerContactPoint,
    CallAttempt,
    ContactPoint,
    Conversation,
    Loan,
    WorkflowExecution,
)


async def seed_demo_data() -> None:
    async with AsyncSessionFactory() as session:
        existing = await session.scalar(select(Borrower).where(Borrower.name == "Jordan Avery"))
        if existing is not None: return
        borrower = Borrower(name = "Jordan Avery", preferred_language = "en", \
            timezone = "America/New_York", status = BorrowerStatus.ACTIVE)
        contact_point = ContactPoint(type = ContactPointType.PHONE, value = "+15551234567", \
            is_valid = True, consent_status = ConsentStatus.ALLOWED, timezone_override = "America/New_York")
        agent_version = AgentVersion(name = "collections-v1", prompt_hash = "bootstrap", \
            status = AgentVersionStatus.ACTIVE)
        loan = Loan(borrower = borrower, principal = Decimal("10000.00"), \
            balance_due = Decimal("550.00"), due_date = date.today(), \
            status = LoanStatus.DELINQUENT, delinquency_days = 15)
        workflow = WorkflowExecution(borrower = borrower, loan = loan, \
            workflow_type = WorkflowType.PAYMENT_REMINDER, status = WorkflowExecutionStatus.COMPLETED, \
            current_attempt_no = 1)
        attempt = CallAttempt(workflow_execution = workflow, contact_point = contact_point, \
            direction = CallDirection.OUTBOUND, provider_call_id = None, \
            attempt_status = CallAttemptStatus.COMPLETED, started_at = datetime.now(timezone.utc), ended_at = datetime.now(timezone.utc))
        conversation = Conversation(call_attempt = attempt, borrower = borrower, \
            agent_version = agent_version, started_at = datetime.now(timezone.utc), ended_at = datetime.now(timezone.utc), \
            channel = "simulated", final_outcome = Outcome.PROMISE_TO_PAY, final_outcome_metadata = {}, protected_context_unlocked = False)
        link = BorrowerContactPoint(borrower = borrower, contact_point = contact_point, \
            priority = 1, relationship = ContactRelationship.PRIMARY)

        session.add_all([borrower, contact_point, agent_version, loan, workflow, attempt, conversation, link])
        await session.commit()

def main() -> None: asyncio.run(seed_demo_data())

if __name__ == "__main__": main()
