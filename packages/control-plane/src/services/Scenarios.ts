/**
 * Deterministic scenario suite (SPEC §18) — the executable acceptance criteria.
 *
 * Every scenario runs the SAME orchestrator the API and voice worker use, against a real
 * Postgres, with a deterministic decider (scripted by default; some pin a failing/static one).
 * Assertions cover: state path, tool sequence, call-control actions, required event types,
 * final outcome, replay-from-events, and scenario-specific validators.
 */
import { DateTime, Effect, Layer, Option, Ref, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import type { ConversationState, EventRecord, TurnChunk } from "@feather-lite/domain";
import { decision, numericScore, replay } from "@feather-lite/domain";
import type { TurnFrame } from "@feather-lite/contracts";
import { AppConfig } from "../config.js";
import { PreCallRejected, TurnDeciderUnavailable, UnknownScenario } from "../errors.js";
import { withFrozenClock } from "./VirtualClock.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { IdGen } from "./Ids.js";
import { Orchestrator, type Signal } from "./Orchestrator.js";
import { Queries, type ConversationDetail } from "./Queries.js";
import { Scores } from "./Scores.js";
import { TurnDecider, type TurnDeciderShape, scriptedTurnDecider } from "./TurnDecider.js";
import type { DeciderInput, TurnResult } from "./types.js";
import { WorkflowService } from "./Workflow.js";

/* ------------------------------------------------------------------ */
/* Definitions                                                          */
/* ------------------------------------------------------------------ */

export type ScenarioStep =
  | { readonly kind: "turn"; readonly text: string; readonly turnId?: string; readonly playout?: { turnId: string; heardText: string; interrupted: boolean } }
  | { readonly kind: "signal"; readonly signal: Signal }
  | { readonly kind: "no_input" };

export interface ScenarioRunContext {
  readonly detail: ConversationDetail;
  readonly turnResults: ReadonlyArray<TurnResult>;
  readonly frames: ReadonlyArray<TurnFrame>;
  readonly deciderInputs: ReadonlyArray<DeciderInput>;
  readonly borrowerId: string;
  readonly contactPointId: string;
  readonly workflowExecutionId: string;
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly description: string;
  readonly steps: ReadonlyArray<ScenarioStep>;
  readonly expectedStatePath: ReadonlyArray<ConversationState>;
  readonly expectedTools: ReadonlyArray<string>;
  readonly expectedCallControlActions: ReadonlyArray<string>;
  readonly requiredEventTypes: ReadonlyArray<string>;
  readonly expectedFinalOutcome: string | null;
  /** Override the decider for this scenario (default: scripted). */
  readonly decider?: "scripted" | "failing" | ((input: DeciderInput) => TurnChunk[]);
  /** Channel of the fixture call. AMD/no-answer scenarios are voice: the opening is not spoken until the runtime reports it. */
  readonly channel?: "simulated" | "voice";
  /** Steps that are expected to fail (e.g. a turn after completion). */
  readonly expectErrors?: boolean;
  /** Extra checks; return failure messages. Runs with DB access. */
  readonly validate?: (ctx: ScenarioRunContext) => Effect.Effect<ReadonlyArray<string>, unknown, CrmRepo | SchedulingRepo | ConversationRepo | WorkflowService>;
}

export interface ScenarioRunResult {
  readonly scenario_id: string;
  readonly passed: boolean;
  readonly conversation_id: string;
  readonly expected_state_path: ReadonlyArray<string>;
  readonly actual_state_path: ReadonlyArray<string>;
  readonly expected_tools: ReadonlyArray<string>;
  readonly actual_tools: ReadonlyArray<string>;
  readonly expected_call_control_actions: ReadonlyArray<string>;
  readonly actual_call_control_actions: ReadonlyArray<string>;
  readonly required_event_types: ReadonlyArray<string>;
  readonly actual_event_types: ReadonlyArray<string>;
  readonly expected_final_outcome: string | null;
  readonly final_outcome: string | null;
  readonly replay_snapshot: Record<string, unknown>;
  readonly assertion_failures: ReadonlyArray<string>;
  readonly frames: ReadonlyArray<TurnFrame>;
  readonly duration_ms: number;
}

const HAPPY_PATH: ReadonlyArray<ConversationState> = ["GREETING", "VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "CONFIRMING_OUTCOME", "ENDING", "COMPLETED"];
const CORE_EVENTS = ["CALL_STARTED", "CALL_ENDED", "OUTBOX_ENQUEUED"];

const agentTextBefore = (events: ReadonlyArray<EventRecord>, predicate: (e: EventRecord) => boolean): string[] => {
  const cutoff = events.find(predicate)?.sequence_no ?? Number.MAX_SAFE_INTEGER;
  return events.filter((e) => e.type === "AGENT_TURN" && e.sequence_no < cutoff).map((e) => (e.type === "AGENT_TURN" ? e.payload.text : ""));
};

export const SCENARIOS: ReadonlyArray<ScenarioDefinition> = [
  {
    id: "happy-path-promise-to-pay",
    description: "Right-party confirmation, proposal, read-back, confirmed promise to pay recorded durably before it is spoken.",
    steps: [
      { kind: "turn", text: "yes, this is Jordan" },
      { kind: "turn", text: "I can pay 550 on Friday" },
      { kind: "turn", text: "yes" },
    ],
    expectedStatePath: HAPPY_PATH,
    expectedTools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS, "TOOL_RESULT"],
    expectedFinalOutcome: "PROMISE_TO_PAY",
    validate: (ctx) =>
      Effect.gen(function* () {
        const f: string[] = [];
        const ev = ctx.detail.events;
        const recorded = ev.find((e) => e.type === "TOOL_RESULT" && e.payload.name === "record_promise_to_pay");
        const confirmation = ev.find((e) => e.type === "AGENT_TURN" && /recorded your promise/.test(e.payload.text));
        if (!recorded || !confirmation) f.push("missing record_promise_to_pay TOOL_RESULT or spoken confirmation");
        else if (!(recorded.sequence_no < confirmation.sequence_no)) f.push("confirmation was spoken before the promise was durably recorded");
        const meta = ctx.detail.conversation.final_outcome_metadata;
        if (meta["promised_amount"] !== "550.00") f.push(`promised_amount was ${String(meta["promised_amount"])}`);
        // The read-back must have carried the exact amount before confirmation.
        if (!ev.some((e) => e.type === "AGENT_TURN" && /550 dollars/.test(e.payload.text) && /Please say yes/.test(e.payload.text))) f.push("read-back not spoken");
        // Confirmation is a non-interruptible `say` frame emitted after turn_end ordering.
        const sayIdx = ctx.frames.findIndex((fr) => fr.type === "say" && /recorded your promise/.test(fr.text));
        const endIdx = ctx.frames.findIndex((fr, i) => fr.type === "turn_end" && i > sayIdx);
        if (sayIdx < 0 || endIdx < 0) f.push("confirmation say frame missing or not followed by turn_end");
        const crm = yield* CrmRepo;
        const loan = yield* crm.primaryLoanForBorrower(ctx.borrowerId);
        if (Option.isNone(loan) || loan.value.lastPromiseDate === null) f.push("loan.last_promise_date not updated");
        return f;
      }),
  },
  {
    id: "happy-path-callback-scheduled",
    description: "Right-party confirmation followed by a callback scheduled at the borrower's requested local time.",
    steps: [
      { kind: "turn", text: "speaking" },
      { kind: "turn", text: "can you call me back tomorrow at 3pm?" },
    ],
    expectedStatePath: ["GREETING", "VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "ENDING", "COMPLETED"],
    expectedTools: ["confirm_right_party", "schedule_callback"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS, "TOOL_RESULT"],
    expectedFinalOutcome: "CALLBACK_SCHEDULED",
    validate: (ctx) =>
      Effect.gen(function* () {
        const f: string[] = [];
        const sched = yield* SchedulingRepo;
        const actions = yield* sched.listForWorkflow(ctx.workflowExecutionId);
        const cb = actions.find((a) => a.actionType === "CALLBACK");
        if (!cb || cb.status !== "PENDING") f.push("no PENDING CALLBACK scheduled action");
        else {
          // 3pm America/New_York (EDT, UTC-4) == 19:00Z
          const hourUtc = cb.dueAt.getUTCHours();
          if (hourUtc !== 19) f.push(`callback due at ${cb.dueAt.toISOString()}, expected 19:00Z (15:00 EDT)`);
        }
        return f;
      }),
  },
  {
    id: "wrong-number-immediate",
    description: "Wrong-number override before the LLM; contact point invalidated; future attempts to it blocked.",
    steps: [{ kind: "turn", text: "you've got the wrong number" }],
    expectedStatePath: ["GREETING", "WRONG_NUMBER", "ENDING", "COMPLETED"],
    expectedTools: ["record_wrong_party_contact"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS, "TOOL_RESULT"],
    expectedFinalOutcome: "WRONG_NUMBER",
    validate: (ctx) =>
      Effect.gen(function* () {
        const f: string[] = [];
        const crm = yield* CrmRepo;
        const cp = yield* crm.findContactPoint(ctx.contactPointId);
        if (Option.isNone(cp) || cp.value.isValid) f.push("contact point still valid after WRONG_NUMBER");
        const st = ctx.detail.events.find((e) => e.type === "STATE_TRANSITION" && e.payload.to === "WRONG_NUMBER");
        if (!st || st.type !== "STATE_TRANSITION" || st.payload.triggered_by !== "OVERRIDE_RULE") f.push("WRONG_NUMBER not triggered by OVERRIDE_RULE");
        return f;
      }),
  },
  {
    id: "wrong-party-during-verification",
    description: "A third party answers: no protected data, contact point stays valid, retry scheduled.",
    steps: [
      { kind: "turn", text: "who is this?" },
      { kind: "turn", text: "he's not available right now, can I take a message?" },
    ],
    expectedStatePath: ["GREETING", "VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY", "ENDING", "COMPLETED"],
    expectedTools: ["record_wrong_party_contact"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS, "TOOL_RESULT"],
    expectedFinalOutcome: "THIRD_PARTY_CONTACT",
    validate: (ctx) =>
      Effect.gen(function* () {
        const f: string[] = [];
        const crm = yield* CrmRepo;
        const cp = yield* crm.findContactPoint(ctx.contactPointId);
        if (Option.isNone(cp) || !cp.value.isValid) f.push("contact point invalidated on THIRD_PARTY_CONTACT");
        const sched = yield* SchedulingRepo;
        const actions = yield* sched.listForWorkflow(ctx.workflowExecutionId);
        if (!actions.some((a) => a.actionType === "RETRY_CALL" && a.status === "PENDING")) f.push("no retry scheduled after third-party contact");
        if (ctx.detail.transcript.some((t) => t.speaker === "AGENT" && /balance|550/.test(t.text))) f.push("protected data spoken to a third party");
        return f;
      }),
  },
  {
    id: "opt-out-immediate",
    description: "Opt-out override: suppression written synchronously; a new call for the borrower is rejected 422.",
    steps: [{ kind: "turn", text: "please stop calling me" }],
    expectedStatePath: ["GREETING", "OPT_OUT", "ENDING", "COMPLETED"],
    expectedTools: ["record_opt_out"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS, "TOOL_RESULT"],
    expectedFinalOutcome: "OPT_OUT",
    validate: (ctx) =>
      Effect.gen(function* () {
        const f: string[] = [];
        const crm = yield* CrmRepo;
        const b = yield* crm.findBorrower(ctx.borrowerId);
        if (Option.isNone(b) || b.value.status !== "OPT_OUT") f.push("borrower not marked OPT_OUT");
        const wf = yield* WorkflowService;
        const again = yield* wf
          .startCall({ borrowerId: ctx.borrowerId, contactPointId: ctx.contactPointId, channel: "simulated", now: FROZEN_NOW })
          .pipe(Effect.either);
        if (again._tag !== "Left" || !(again.left instanceof PreCallRejected) || !again.left.failures.includes("BORROWER_OPT_OUT")) {
          f.push("a new call was not rejected with BORROWER_OPT_OUT");
        }
        return f;
      }),
  },
  {
    id: "hardship-escalation",
    description: "Hardship phrase overrides the LLM: warm-transfer stub, human follow-up queued, ESCALATED.",
    steps: [{ kind: "turn", text: "I lost my job and I can't afford this right now" }],
    expectedStatePath: ["GREETING", "ESCALATED", "ENDING", "COMPLETED"],
    expectedTools: [],
    expectedCallControlActions: ["WARM_TRANSFER"],
    requiredEventTypes: [...CORE_EVENTS, "TRANSFER_REQUESTED", "TRANSFER_COMPLETED"],
    expectedFinalOutcome: "ESCALATED",
    validate: (ctx) =>
      Effect.gen(function* () {
        const f: string[] = [];
        const sched = yield* SchedulingRepo;
        const actions = yield* sched.listForWorkflow(ctx.workflowExecutionId);
        if (!actions.some((a) => a.actionType === "HUMAN_FOLLOWUP" && a.payload["queue"] === "hardship_queue")) f.push("no HUMAN_FOLLOWUP in hardship_queue");
        if (ctx.detail.conversation.transfer_target !== "hardship_queue") f.push("transfer_target not set");
        return f;
      }),
  },
  {
    id: "debt-dispute-escalation",
    description: "Dispute phrase overrides the LLM: collection stops, DISPUTED outcome, disputes queue.",
    steps: [{ kind: "turn", text: "I don't owe this, I dispute this debt" }],
    expectedStatePath: ["GREETING", "ESCALATED", "ENDING", "COMPLETED"],
    expectedTools: [],
    expectedCallControlActions: ["WARM_TRANSFER"],
    requiredEventTypes: [...CORE_EVENTS, "TRANSFER_REQUESTED", "TRANSFER_COMPLETED"],
    expectedFinalOutcome: "DISPUTED",
  },
  {
    id: "voicemail-drop",
    description: "AMD reports a machine before anything is spoken: FDCPA-safe voicemail, no Mini-Miranda, VOICEMAIL_LEFT.",
    channel: "voice",
    steps: [{ kind: "signal", signal: { kind: "amd_result", result: "MACHINE", confidence: 0.97 } }],
    expectedStatePath: ["GREETING", "VOICEMAIL", "ENDING", "COMPLETED"],
    expectedTools: [],
    expectedCallControlActions: ["VOICEMAIL_DROP"],
    requiredEventTypes: ["CALL_STARTED", "AMD_RESULT", "CALL_CONTROL", "CALL_ENDED"],
    expectedFinalOutcome: "VOICEMAIL_LEFT",
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          const agent = ctx.detail.transcript.filter((t) => t.speaker === "AGENT").map((t) => t.text);
          if (agent.some((t) => /attempt to collect a debt/i.test(t))) f.push("Mini-Miranda recited into voicemail");
          if (!agent.some((t) => /return our call/i.test(t))) f.push("voicemail script not spoken");
          if (agent.some((t) => /debt|balance|owe|\$|\d{4}-\d{2}-\d{2}/i.test(t))) f.push("voicemail disclosed debt details");
          return f;
        })(),
      ),
  },
  {
    id: "no-input-timeout",
    description: "Two consecutive no-input strikes close the attempt as NO_ANSWER and schedule a retry.",
    steps: [{ kind: "no_input" }, { kind: "no_input" }],
    expectedStatePath: ["GREETING", "ENDING", "COMPLETED"],
    expectedTools: [],
    expectedCallControlActions: ["NO_INPUT_CLOSE"],
    requiredEventTypes: ["CALL_STARTED", "NO_INPUT", "CALL_CONTROL", "CALL_ENDED"],
    expectedFinalOutcome: "NO_ANSWER",
    validate: (ctx) =>
      Effect.gen(function* () {
        const f: string[] = [];
        const sched = yield* SchedulingRepo;
        const actions = yield* sched.listForWorkflow(ctx.workflowExecutionId);
        if (!actions.some((a) => a.actionType === "RETRY_CALL")) f.push("no RETRY_CALL scheduled");
        const strikes = ctx.detail.events.filter((e) => e.type === "NO_INPUT").map((e) => (e.type === "NO_INPUT" ? e.payload.count : 0));
        if (strikes.join(",") !== "1,2") f.push(`no-input strikes were ${strikes.join(",")}`);
        if (!ctx.detail.transcript.some((t) => t.speaker === "AGENT" && /still there/.test(t.text))) f.push("first strike did not prompt 'Are you still there?'");
        return f;
      }),
  },
  {
    id: "barge-in-during-agent-speech",
    description: "Borrower interrupts the agent; the transcript keeps only what was heard; the call still completes.",
    steps: [
      { kind: "turn", text: "yes this is Jordan", turnId: "t1" },
      { kind: "turn", text: "just call me back tomorrow morning", turnId: "t2", playout: { turnId: "t1", heardText: "Thanks for confirming, Jordan. I'm calling about your account", interrupted: true } },
    ],
    expectedStatePath: ["GREETING", "VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "ENDING", "COMPLETED"],
    expectedTools: ["confirm_right_party", "schedule_callback"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS, "AGENT_TURN_PLAYOUT"],
    expectedFinalOutcome: "CALLBACK_SCHEDULED",
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          const t1 = ctx.detail.transcript.find((t) => t.speaker === "AGENT" && t.interrupted === true);
          if (!t1) f.push("no interrupted agent line in transcript");
          else if (t1.text !== "Thanks for confirming, Jordan. I'm calling about your account") f.push(`transcript kept generated text, not heard text: ${t1.text}`);
          const inputs = ctx.deciderInputs.find((i) => i.turnId === "t2");
          if (!inputs || inputs.heardAgentText === null) f.push("decider did not receive the heard (truncated) agent text");
          return f;
        })(),
      ),
  },
  {
    id: "duplicate-tool-call-idempotent",
    description: "The same turn_id delivered twice (retry / reconnect) replays the result and duplicates nothing.",
    steps: [
      { kind: "turn", text: "yes this is Jordan", turnId: "t1" },
      { kind: "turn", text: "I can pay 550 on Friday", turnId: "t2" },
      { kind: "turn", text: "yes", turnId: "t3" },
      { kind: "turn", text: "yes", turnId: "t3" },
    ],
    expectedStatePath: HAPPY_PATH,
    expectedTools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS],
    expectedFinalOutcome: "PROMISE_TO_PAY",
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          const results = ctx.detail.events.filter((e) => e.type === "TOOL_RESULT" && e.payload.name === "record_promise_to_pay");
          if (results.length !== 1) f.push(`record_promise_to_pay TOOL_RESULT count = ${results.length}`);
          if (ctx.detail.events.filter((e) => e.type === "CALL_ENDED").length !== 1) f.push("CALL_ENDED duplicated");
          const [a, b] = ctx.turnResults.slice(-2);
          if (!a || !b || a.agentText !== b.agentText || a.outcome !== b.outcome) f.push("replayed turn result differs from the original");
          return f;
        })(),
      ),
  },
  {
    id: "protected-context-not-exposed-before-verification",
    description: "Protected account data is absent from the decider's context and from speech until right-party confirmation.",
    steps: [
      { kind: "turn", text: "who is this?" },
      { kind: "turn", text: "what is this about?" },
      { kind: "turn", text: "ok yes this is Jordan" },
      { kind: "turn", text: "call me back tomorrow" },
    ],
    expectedStatePath: ["GREETING", "VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "ENDING", "COMPLETED"],
    expectedTools: ["confirm_right_party", "schedule_callback"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS],
    expectedFinalOutcome: "CALLBACK_SCHEDULED",
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          const before = agentTextBefore(ctx.detail.events, (e) => e.type === "STATE_TRANSITION" && e.payload.triggered_by === "RIGHT_PARTY_CONFIRMED");
          if (before.some((t) => /550|balance|due date|delinquen/i.test(t))) f.push("protected data spoken before verification");
          const pre = ctx.deciderInputs.filter((i) => i.state === "GREETING" || i.state === "VERIFYING_IDENTITY");
          if (pre.length === 0) f.push("no decider inputs captured before verification");
          if (pre.some((i) => i.context.protectedContext !== null || i.context.memory !== null)) f.push("decider saw protected context before verification");
          if (pre.some((i) => JSON.stringify(i.context).includes("550.00"))) f.push("balance leaked into decider context");
          return f;
        })(),
      ),
  },
  {
    id: "read-back-interrupted-is-repeated",
    description: "A promise is recorded only if the read-back was fully heard; an interrupted read-back is repeated.",
    steps: [
      { kind: "turn", text: "yes this is Jordan", turnId: "t1" },
      { kind: "turn", text: "I'll pay 550 on Friday", turnId: "t2" },
      { kind: "turn", text: "yes", turnId: "t3", playout: { turnId: "t2", heardText: "To confirm: you will pay", interrupted: true } },
      { kind: "turn", text: "yes", turnId: "t4", playout: { turnId: "t3", heardText: "Let me repeat that.", interrupted: false } },
    ],
    expectedStatePath: HAPPY_PATH,
    expectedTools: ["confirm_right_party", "propose_promise_to_pay", "record_promise_to_pay", "record_promise_to_pay"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS, "TOOL_REJECTED", "AGENT_TURN_PLAYOUT"],
    expectedFinalOutcome: "PROMISE_TO_PAY",
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          const rejected = ctx.detail.events.filter((e) => e.type === "TOOL_REJECTED");
          if (rejected.length !== 1 || (rejected[0]?.type === "TOOL_REJECTED" && !/interrupted/.test(rejected[0].payload.detail))) f.push("expected exactly one TOOL_REJECTED for the interrupted read-back");
          const repeats = ctx.detail.transcript.filter((t) => t.speaker === "AGENT" && /Let me repeat that/.test(t.text));
          if (repeats.length !== 1) f.push("read-back was not repeated once");
          return f;
        })(),
      ),
  },
  {
    id: "invalid-llm-transition-recovered",
    description: "The model suggests an illegal jump (GREETING -> CONFIRMING_OUTCOME); the state machine rejects it and the call continues.",
    steps: [{ kind: "turn", text: "hello?" }],
    decider: () => [decision({ message: "Great, let me confirm your payment.", toolCall: null, intentSatisfied: true, suggestedNextState: "CONFIRMING_OUTCOME" })],
    expectedStatePath: ["GREETING"],
    expectedTools: [],
    expectedCallControlActions: [],
    requiredEventTypes: ["CALL_STARTED", "TURN_DECISION_REJECTED"],
    expectedFinalOutcome: null,
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          if (ctx.detail.conversation.current_state !== "GREETING") f.push("state changed after an invalid transition");
          const last = ctx.turnResults.at(-1);
          if (!last?.degraded) f.push("turn not marked degraded");
          return f;
        })(),
      ),
  },
  {
    id: "tool-in-wrong-state-fails-closed",
    description: "The model calls record_promise_to_pay in GREETING; the tool matrix rejects it with no side effects.",
    steps: [{ kind: "turn", text: "sure whatever" }],
    decider: () => [decision({ message: "", toolCall: { name: "record_promise_to_pay", args: { confirmed: true } }, intentSatisfied: true, suggestedNextState: null })],
    expectedStatePath: ["GREETING"],
    expectedTools: [],
    expectedCallControlActions: [],
    requiredEventTypes: ["CALL_STARTED", "TOOL_REJECTED"],
    expectedFinalOutcome: null,
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          const rej = ctx.detail.events.find((e) => e.type === "TOOL_REJECTED");
          if (!rej || rej.type !== "TOOL_REJECTED" || rej.payload.reason !== "NOT_ALLOWED") f.push("expected TOOL_REJECTED NOT_ALLOWED");
          if (ctx.detail.events.some((e) => e.type === "TOOL_CALLED")) f.push("TOOL_CALLED recorded for a rejected tool");
          return f;
        })(),
      ),
  },
  {
    id: "right-party-third-party-phrasings",
    description: "Ordinary third-party phrasings never unlock protected context (the review's probe list).",
    steps: [
      { kind: "turn", text: "yes, but she's not here right now" },
    ],
    expectedStatePath: ["GREETING", "VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY", "ENDING", "COMPLETED"],
    expectedTools: ["record_wrong_party_contact"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS],
    expectedFinalOutcome: "THIRD_PARTY_CONTACT",
    validate: (ctx) =>
      Effect.succeed(ctx.detail.conversation.protected_context_unlocked ? ["protected context unlocked for a third party"] : []),
  },
  {
    id: "wrong-number-by-name",
    description: "'I am not <name>, he moved out' is a wrong-number override even though it contains 'I am'.",
    steps: [{ kind: "turn", text: "I am not Jordan, he moved out last year" }],
    expectedStatePath: ["GREETING", "WRONG_NUMBER", "ENDING", "COMPLETED"],
    expectedTools: ["record_wrong_party_contact"],
    expectedCallControlActions: [],
    requiredEventTypes: [...CORE_EVENTS],
    expectedFinalOutcome: "WRONG_NUMBER",
  },
  {
    id: "decider-unavailable-safe-fallback",
    description: "The LLM is down: the agent speaks a safe fallback, state is unchanged, the failure is an event.",
    steps: [{ kind: "turn", text: "yes this is Jordan" }],
    decider: "failing",
    expectedStatePath: ["GREETING"],
    expectedTools: [],
    expectedCallControlActions: [],
    requiredEventTypes: ["CALL_STARTED", "TURN_DECISION_REJECTED"],
    expectedFinalOutcome: null,
    validate: (ctx) =>
      Effect.succeed(
        ((): string[] => {
          const f: string[] = [];
          const rej = ctx.detail.events.find((e) => e.type === "TURN_DECISION_REJECTED");
          if (!rej || rej.type !== "TURN_DECISION_REJECTED" || rej.payload.reason !== "DECIDER_UNAVAILABLE") f.push("expected DECIDER_UNAVAILABLE");
          if (!ctx.frames.some((fr) => fr.type === "say" && /say that again/.test(fr.text))) f.push("no safe fallback spoken");
          return f;
        })(),
      ),
  },
  {
    id: "no-answer-signal",
    description: "Telephony reports no answer: NO_ANSWER outcome and a retry scheduled.",
    channel: "voice",
    steps: [{ kind: "signal", signal: { kind: "no_answer" } }],
    expectedStatePath: ["GREETING", "ENDING", "COMPLETED"],
    expectedTools: [],
    expectedCallControlActions: ["NO_ANSWER"],
    requiredEventTypes: ["CALL_STARTED", "CALL_CONTROL", "CALL_ENDED"],
    expectedFinalOutcome: "NO_ANSWER",
  },
  {
    id: "hangup-after-verification",
    description: "Borrower hangs up mid-call after verification: FAILED outcome, retry scheduled, nothing claimed.",
    steps: [
      { kind: "turn", text: "yes this is Jordan" },
      { kind: "signal", signal: { kind: "hangup", reason: "participant_disconnected" } },
    ],
    expectedStatePath: ["GREETING", "VERIFYING_IDENTITY", "DISCUSSING_PAYMENT", "ENDING", "COMPLETED"],
    expectedTools: ["confirm_right_party"],
    expectedCallControlActions: ["HANGUP"],
    requiredEventTypes: ["CALL_STARTED", "CALL_CONTROL", "CALL_ENDED"],
    expectedFinalOutcome: "FAILED",
  },
];

/* ------------------------------------------------------------------ */
/* Runner                                                               */
/* ------------------------------------------------------------------ */

/** 14:00 America/New_York on a Sunday in August: inside the TCPA window regardless of wall clock. */
export const FROZEN_NOW = DateTime.unsafeMake("2026-08-16T18:00:00Z");

const deciderFor = (def: ScenarioDefinition, captured: Ref.Ref<ReadonlyArray<DeciderInput>>): TurnDeciderShape => {
  const inner: TurnDeciderShape =
    def.decider === "failing"
      ? { name: "failing", decide: () => Stream.fail(new TurnDeciderUnavailable({ detail: "simulated outage" })) }
      : typeof def.decider === "function"
        ? { name: "static", decide: ((fn) => (input: DeciderInput) => Stream.fromIterable(fn(input)))(def.decider) }
        : scriptedTurnDecider;
  // Capture every DeciderInput for the leak assertions, then delegate.
  return {
    name: inner.name,
    decide: (input) => Stream.unwrap(Ref.update(captured, (xs) => [...xs, input]).pipe(Effect.as(inner.decide(input)))),
  };
};

export class ScenarioRunner extends Effect.Service<ScenarioRunner>()("@feather-lite/ScenarioRunner", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const cfg = yield* AppConfig;
    const crm = yield* CrmRepo;
    const conv = yield* ConversationRepo;
    const sched = yield* SchedulingRepo;
    const ids = yield* IdGen;
    const workflow = yield* WorkflowService;
    const queries = yield* Queries;
    const scores = yield* Scores;

    const list = () => SCENARIOS.map((s) => ({ scenario_id: s.id, description: s.description }));

    const createFixture = (scenarioId: string) =>
      Effect.gen(function* () {
        const borrowerId = yield* ids.next();
        const contactPointId = yield* ids.next();
        const loanId = yield* ids.next();
        const suffix = borrowerId.replace(/-/g, "").slice(-7);
        yield* sql`INSERT INTO borrowers ${sql.insert({ id: borrowerId, name: "Jordan Avery", timezone: "America/New_York", status: "ACTIVE" })}`;
        yield* sql`INSERT INTO contact_points ${sql.insert({ id: contactPointId, value: `+1555${suffix.replace(/\D/g, "").padEnd(7, "0").slice(0, 7)}${scenarioId.length % 10}`, isValid: true, consentStatus: "ALLOWED", timezoneOverride: "America/New_York" })}`;
        yield* sql`INSERT INTO borrower_contact_points ${sql.insert({ borrowerId, contactPointId, priority: 1, relationship: "PRIMARY" })}`;
        yield* sql`INSERT INTO loans ${sql.insert({ id: loanId, borrowerId, principal: "10000.00", balanceDue: "550.00", dueDate: "2026-08-01", status: "DELINQUENT", delinquencyDays: 15 })}`;
        return { borrowerId, contactPointId };
      });

    const run = (scenarioId: string) =>
      Effect.gen(function* () {
        const def = SCENARIOS.find((s) => s.id === scenarioId);
        if (!def) return yield* Effect.fail(new UnknownScenario({ scenarioId }));
        const t0 = Date.now();
        const captured = yield* Ref.make<ReadonlyArray<DeciderInput>>([]);
        const frames = yield* Ref.make<ReadonlyArray<TurnFrame>>([]);
        const emit = (frame: TurnFrame) => Ref.update(frames, (xs) => [...xs, frame]);

        const fixture = yield* createFixture(def.id);
        const started = yield* workflow.startCall({ borrowerId: fixture.borrowerId, contactPointId: fixture.contactPointId, channel: def.channel ?? "simulated", now: FROZEN_NOW }).pipe(withFrozenClock(FROZEN_NOW));

        const orchestratorLayer = Orchestrator.Default.pipe(Layer.provide(Layer.succeed(TurnDecider, deciderFor(def, captured))));
        const turnResults: TurnResult[] = [];
        let stepNo = 0;
        const runSteps = Effect.gen(function* () {
          const orch = yield* Orchestrator;
          for (const step of def.steps) {
            stepNo += 1;
            if (step.kind === "turn") {
              const r = yield* orch
                .processTurn({ conversationId: started.conversationId, turnId: step.turnId ?? `t${stepNo}`, userText: step.text, playout: step.playout }, emit)
                .pipe(Effect.either);
              if (r._tag === "Right") turnResults.push(r.right);
              // The turn failed outright, so no arm decided it and it has no disposition of its own (F3).
              else turnResults.push({ turnId: step.turnId ?? `t${stepNo}`, decider: "none", disposition: "respond", resolution: "degraded", agentText: `ERROR ${String(r.left)}`, newState: "GREETING", toolCalled: null, callControlAction: null, outcome: null, endCall: false, degraded: true, ttftMs: null });
            } else if (step.kind === "no_input") {
              turnResults.push(yield* orch.processNoInput(started.conversationId));
            } else {
              turnResults.push(yield* orch.processSignal(started.conversationId, step.signal));
            }
          }
        }).pipe(Effect.provide(orchestratorLayer), withFrozenClock(FROZEN_NOW));
        yield* runSteps;

        const detail = yield* queries.conversationDetail(started.conversationId);
        const ctx: ScenarioRunContext = {
          detail,
          turnResults,
          frames: yield* Ref.get(frames),
          deciderInputs: yield* Ref.get(captured),
          borrowerId: fixture.borrowerId,
          contactPointId: fixture.contactPointId,
          workflowExecutionId: started.workflowExecutionId,
        };
        const actualPath = detail.events.filter((e) => e.type === "STATE_TRANSITION").map((e) => (e.type === "STATE_TRANSITION" ? e.payload.to : "?"));
        const actualTools = detail.events.filter((e) => e.type === "TOOL_CALLED").map((e) => (e.type === "TOOL_CALLED" ? e.payload.name : "?"));
        const actualCc = detail.events.filter((e) => e.type === "CALL_CONTROL").map((e) => (e.type === "CALL_CONTROL" ? e.payload.action : "?"));
        const actualTypes = detail.events.map((e) => e.type);
        const snap = replay(detail.events);

        const failures: string[] = [];
        if (JSON.stringify(actualPath) !== JSON.stringify(def.expectedStatePath)) failures.push(`state path ${JSON.stringify(actualPath)} != ${JSON.stringify(def.expectedStatePath)}`);
        if (JSON.stringify(actualTools) !== JSON.stringify(def.expectedTools)) failures.push(`tools ${JSON.stringify(actualTools)} != ${JSON.stringify(def.expectedTools)}`);
        if (JSON.stringify(actualCc) !== JSON.stringify(def.expectedCallControlActions)) failures.push(`call-control ${JSON.stringify(actualCc)} != ${JSON.stringify(def.expectedCallControlActions)}`);
        const missing = def.requiredEventTypes.filter((t) => !actualTypes.includes(t as never));
        if (missing.length) failures.push(`missing event types: ${missing.join(", ")}`);
        if (detail.conversation.final_outcome !== def.expectedFinalOutcome) failures.push(`outcome ${String(detail.conversation.final_outcome)} != ${String(def.expectedFinalOutcome)}`);
        if (snap.finalOutcome !== def.expectedFinalOutcome) failures.push(`replay outcome ${String(snap.finalOutcome)} != ${String(def.expectedFinalOutcome)}`);
        if (snap.currentState !== detail.conversation.current_state) failures.push(`replay state ${snap.currentState} != row state ${detail.conversation.current_state}`);
        // Every finalized conversation must have a released turn slot and a stored turn result per turn.
        const row = yield* conv.findConversation(started.conversationId);
        if (Option.isSome(row) && row.value.activeTurnId !== null) failures.push("active_turn_id not released");
        const errored = turnResults.filter((r) => r.agentText.startsWith("ERROR "));
        if (errored.length > 0 && !def.expectErrors) failures.push(`steps failed: ${errored.map((r) => r.agentText).join(" | ")}`);
        if (def.validate) failures.push(...(yield* def.validate(ctx)));

        const result: ScenarioRunResult = {
          scenario_id: def.id,
          passed: failures.length === 0,
          conversation_id: started.conversationId,
          expected_state_path: def.expectedStatePath,
          actual_state_path: actualPath,
          expected_tools: def.expectedTools,
          actual_tools: actualTools,
          expected_call_control_actions: def.expectedCallControlActions,
          actual_call_control_actions: actualCc,
          required_event_types: def.requiredEventTypes,
          actual_event_types: actualTypes,
          expected_final_outcome: def.expectedFinalOutcome,
          final_outcome: detail.conversation.final_outcome,
          replay_snapshot: { ...snap, toolCallIds: [...snap.toolCallIds], actionIds: [...snap.actionIds] },
          assertion_failures: failures,
          frames: ctx.frames,
          duration_ms: Date.now() - t0,
        };
        return result;
      }).pipe(Effect.provideService(SchedulingRepo, sched), Effect.provideService(CrmRepo, crm), Effect.provideService(ConversationRepo, conv), Effect.provideService(WorkflowService, workflow));

    /**
     * Run the suite, and record what share of it passed as a score (spec 2026-08-26, D9).
     *
     * The suite is scored against a **synthetic conversation id, minted per run**: it is a test
     * run, not a call, and there is nothing in `conversations` to hang it on. `conversation_scores`
     * carries no foreign key for exactly this reason. A fresh id per run means the history is a
     * series of runs rather than one row overwritten each time — the opposite of the upsert
     * behaviour every per-call score wants, and the right one here.
     *
     * Langfuse datasets and experiments were considered and not adopted: the suite already *is* the
     * dataset, it lives in this repo beside the code it tests, and it runs in CI. Pushing a score is
     * all that was missing to put CI correctness on the same page as call quality.
     */
    const runAll = () =>
      Effect.gen(function* () {
        const results = yield* Effect.forEach(SCENARIOS, (s) => run(s.id), { concurrency: 1 });
        const failed = results.filter((r) => !r.passed).map((r) => r.scenario_id);
        const suiteId = yield* ids.next();
        yield* scores
          .record(
            numericScore(suiteId, "scenario.pass_rate", Math.round(((results.length - failed.length) / Math.max(1, results.length)) * 1000) / 1000, "SCENARIO", {
              comment: `${results.length - failed.length}/${results.length} scenarios passed`,
              evidence: { failed, total: results.length, suite_run_id: suiteId },
            }),
          )
          // A scenario run must not fail because its score could not be written; the run's own
          // result is the thing under test and it is already in hand.
          .pipe(Effect.catchAllCause((cause) => Effect.logWarning("scenario pass-rate score not written").pipe(Effect.annotateLogs({ cause: String(cause) }))));
        return results;
      });

    void cfg;
    return { list, run, runAll } as const;
  }),
  dependencies: [CrmRepo.Default, ConversationRepo.Default, SchedulingRepo.Default, IdGen.Default, WorkflowService.Default, Queries.Default, Scores.Default],
}) {}
