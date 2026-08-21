/**
 * Idempotent demo seed (plan rev.2 R23). Borrowers across time zones, one opted out, one
 * with an invalid contact point, and REAL history produced by running the orchestrator
 * (so transcripts/timelines/memory blocks are genuine, not hand-written rows).
 */
import { DateTime, Effect, Option } from "effect";
import { isWithinContactWindow } from "@feather-lite/domain";
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

/**
 * A unique, syntactically plausible NANP number for a load fixture. `contact_points.value` is
 * unique, so this must not collide across a 1000-row run: it takes 48 bits of the fixture's UUID
 * rather than the digits-only surgery that a hex id makes unreliable (a UUID with few decimal
 * digits would pad out to the same number as its neighbours).
 */
const fixturePhone = (borrowerId: string): string => {
  const bits = BigInt(`0x${borrowerId.replace(/-/g, "").slice(0, 12)}`);
  // 555-01xx is the reserved fictional exchange; keep the last 7 digits inside it.
  return `+1555${(bits % 10_000_000n).toString().padStart(7, "0")}`;
};

/** Spread across the globe so at least one is inside 08:00-21:00 local at any UTC hour. */
const CONTACT_WINDOW_CANDIDATES = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "Europe/Moscow",
] as const;

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

    /**
     * Throwaway borrowers for a load run. Two pre-call rules force one borrower per concurrent
     * conversation: ACTIVE_CONVERSATION (one live call per borrower) and the 7-in-7 frequency cap.
     * The timezone is picked so the run is inside the TCPA window whatever the wall clock says —
     * otherwise every start would 422 at the wrong hour of the day.
     *
     * One transaction for the whole batch: a fixture set is all-or-nothing, so a failure partway
     * (a phone collision, a lost connection) leaves no half-built borrowers behind for the next run
     * to trip over.
     */
    const loadFixtures = (input: { readonly count: number; readonly prefix?: string | undefined }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const zone = CONTACT_WINDOW_CANDIDATES.find((tz) => Option.getOrElse(isWithinContactWindow(now, tz), () => false));
          if (!zone) return yield* Effect.fail(new Error("no candidate timezone is inside the TCPA contact window"));
          const prefix = input.prefix ?? `load-${Date.now().toString(36)}`;
          yield* crm.ensureActiveAgentVersion(yield* ids.next(), "collections-v2", "v2-bootstrap");

          const out: Array<{ borrower_id: string; contact_point_id: string; name: string; timezone: string }> = [];
          for (let i = 0; i < input.count; i += 1) {
            const borrowerId = yield* ids.next();
            const cpId = yield* ids.next();
            const name = `Jordan ${prefix}-${String(i).padStart(4, "0")}`;
            yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name, timezone: zone, status: "ACTIVE" })}`;
            yield* sql`INSERT INTO contact_points ${sql.insert({ id: cpId, value: fixturePhone(borrowerId), isValid: true, consentStatus: "ALLOWED", timezoneOverride: zone })}`;
            yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId: cpId, priority: 1, relationship: "PRIMARY" })}`;
            yield* sql`INSERT INTO loans ${sql.insert({ id: yield* ids.next(), borrowerId, principal: "10000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 15 })}`;
            out.push({ borrower_id: borrowerId, contact_point_id: cpId, name, timezone: zone });
          }
          return out;
        }),
      );

    /** Demo reset: wipe conversations/attempts/actions/jobs, keep borrowers; then re-run history. */
    const reset = () =>
      Effect.gen(function* () {
        yield* sql`TRUNCATE TABLE conversation_turns, conversation_events, outbox_jobs, scheduled_actions, conversations, call_attempts, workflow_executions, loans, borrower_contact_points, contact_points, borrowers RESTART IDENTITY CASCADE`;
        return yield* run();
      });

    return { run, reset, loadFixtures } as const;
  }),
  dependencies: [CrmRepo.Default, SchedulingRepo.Default, IdGen.Default, WorkflowService.Default, Orchestrator.Default],
}) {}
