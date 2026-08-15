/**
 * Idempotent demo seed (plan rev.2 R23). Borrowers across time zones, one opted out, one
 * with an invalid contact point, and REAL history produced by running the orchestrator
 * (so transcripts/timelines/memory blocks are genuine, not hand-written rows).
 */
import { DateTime, Effect } from "effect";
import { withShiftedClock, type ShiftedClock } from "./VirtualClock.js";
import { PgClient } from "@effect/sql-pg";
import { CrmRepo } from "../repos/crm.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { IdGen } from "./Ids.js";
import { Orchestrator } from "./Orchestrator.js";
import { WorkflowService } from "./Workflow.js";

export interface SeedBorrower {
  readonly name: string;
  readonly timezone: string;
  readonly phone: string;
  readonly status?: "ACTIVE" | "OPT_OUT";
  readonly contactValid?: boolean;
  readonly consent?: "ALLOWED" | "OPTED_OUT" | "UNKNOWN";
  readonly loan: { principal: string; balanceDue: string; dueDate: string; status: "CURRENT" | "DELINQUENT"; delinquencyDays: number };
  /** Scripted history to run through the orchestrator (simulated channel). */
  readonly history?: ReadonlyArray<{ readonly at: string; readonly turns: ReadonlyArray<string> | "no_answer" }>;
}

export const DEMO_BORROWERS: ReadonlyArray<SeedBorrower> = [
  {
    name: "Jordan Avery",
    timezone: "America/New_York",
    phone: "+15551234567",
    loan: { principal: "10000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 15 },
    history: [{ at: "2026-08-10T16:00:00Z", turns: "no_answer" }],
  },
  {
    name: "Priya Nair",
    timezone: "Asia/Kolkata",
    phone: "+919812345678",
    loan: { principal: "6000.00", balanceDue: "300.00", dueDate: "2026-08-05", status: "DELINQUENT", delinquencyDays: 11 },
    history: [
      { at: "2026-08-04T09:00:00Z", turns: ["yes this is Priya", "I can pay 300 on the 8th", "yes"] },
      { at: "2026-08-12T09:30:00Z", turns: "no_answer" },
    ],
  },
  {
    name: "Sam Ortiz",
    timezone: "America/Chicago",
    phone: "+15559876543",
    status: "OPT_OUT",
    consent: "OPTED_OUT",
    loan: { principal: "2500.00", balanceDue: "125.00", dueDate: "2026-07-20", status: "DELINQUENT", delinquencyDays: 27 },
    history: [{ at: "2026-07-25T18:00:00Z", turns: ["yes speaking", "stop calling me"] }],
  },
  {
    name: "Lee Chen",
    timezone: "America/Los_Angeles",
    phone: "+15557770000",
    contactValid: false,
    loan: { principal: "8000.00", balanceDue: "420.00", dueDate: "2026-08-03", status: "DELINQUENT", delinquencyDays: 13 },
    history: [{ at: "2026-08-06T20:00:00Z", turns: ["wrong number, no one by that name here"] }],
  },
  {
    name: "Morgan Reyes",
    timezone: "Europe/London",
    phone: "+447700900123",
    loan: { principal: "3000.00", balanceDue: "150.00", dueDate: "2026-08-20", status: "CURRENT", delinquencyDays: 0 },
  },
];

export class SeedService extends Effect.Service<SeedService>()("@feather-lite/SeedService", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const crm = yield* CrmRepo;
    const sched = yield* SchedulingRepo;
    const ids = yield* IdGen;
    const workflow = yield* WorkflowService;
    const orch = yield* Orchestrator;

    const seedOne = (b: SeedBorrower) =>
      Effect.gen(function* () {
        const existing = yield* sql<{ readonly id: string }>`SELECT id FROM borrowers WHERE name = ${b.name} LIMIT 1`;
        if (existing.length > 0) return { name: b.name, created: false };
        const borrowerId = yield* ids.next();
        const cpId = yield* ids.next();
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: b.name, timezone: b.timezone, status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: b.phone, isValid: true, consentStatus: "ALLOWED", timezoneOverride: null })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: b.loan.principal, balanceDue: b.loan.balanceDue, dueDate: b.loan.dueDate, status: b.loan.status, delinquencyDays: b.loan.delinquencyDays })}`;

        // History through the real orchestrator (states/events/outbox exactly as production writes them).
        for (const h of b.history ?? []) {
          // Shifted clock: the whole historical call (start, turns, end, scheduled actions) is stamped as of `h.at`.
          const historical = (clock: ShiftedClock) => Effect.gen(function* () {
            const started = yield* workflow.startCall({ borrowerId, contactPointId: cpId, channel: "simulated" }).pipe(Effect.either);
            if (started._tag === "Left") return;
            if (h.turns === "no_answer") {
              yield* orch.processSignal(started.right.conversationId, { kind: "no_answer" });
            } else {
              let n = 0;
              for (const t of h.turns) {
                n += 1;
                yield* clock.advance("20 seconds"); // realistic spacing between turns in the historical transcript
                const r = yield* orch.processTurn({ conversationId: started.right.conversationId, turnId: `seed-${n}`, userText: t }, () => Effect.void).pipe(Effect.either);
                if (r._tag === "Left" || r.right.endCall) break;
              }
            }
            // History must not block today's demo: clear pending retries/callbacks it created.
            yield* sched.cancelPending({ workflowExecutionId: started.right.workflowExecutionId, reason: "seed_history", actionTypes: ["RETRY_CALL", "CALLBACK"] });
          });
          yield* withShiftedClock(DateTime.unsafeMake(h.at))(historical);
        }
        // Final flags after history (so an opted-out borrower's history still shows the real opt-out call).
        if (b.status === "OPT_OUT") yield* crm.setBorrowerStatus(borrowerId, "OPT_OUT");
        if (b.consent) yield* crm.setContactPointConsent(cpId, b.consent);
        if (b.contactValid === false) yield* crm.setContactPointValidity(cpId, false);
        return { name: b.name, created: true };
      });

    const run = () =>
      Effect.gen(function* () {
        yield* crm.ensureActiveAgentVersion(yield* ids.next(), "collections-v2", "v2-bootstrap");
        const results = [];
        for (const b of DEMO_BORROWERS) results.push(yield* seedOne(b));
        return results;
      });

    /** Demo reset: wipe conversations/attempts/actions/jobs, keep borrowers; then re-run history. */
    const reset = () =>
      Effect.gen(function* () {
        yield* sql`TRUNCATE TABLE conversation_turns, conversation_events, outbox_jobs, scheduled_actions, conversations, call_attempts, workflow_executions, loans, borrower_contact_points, contact_points, borrowers RESTART IDENTITY CASCADE`;
        return yield* run();
      });

    return { run, reset } as const;
  }),
  dependencies: [CrmRepo.Default, SchedulingRepo.Default, IdGen.Default, WorkflowService.Default, Orchestrator.Default],
}) {}
