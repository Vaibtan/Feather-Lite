/**
 * The conversation orchestrator — "state machine is the enforcer, the model is the
 * conversationalist" (PRD §5.2.3), implemented as the three-phase turn from plan rev.2 R4:
 *
 *   T1  (tx)  lock conversation, reject completed / concurrent turn, CAS active_turn_id,
 *             append USER_TURN_FINAL (+ AGENT_TURN_PLAYOUT if reported), commit.
 *   decide    NO transaction. Deterministic overrides first; else the TurnDecider streams.
 *             Text deltas are forwarded to the caller immediately (chat mode).
 *   T2  (tx)  lock, verify still the active turn, validate transition + tool against the
 *             state machine, execute tool (idempotent), append TOOL_CALLED / TOOL_RESULT /
 *             STATE_TRANSITION / AGENT_TURN, finalize if terminal (+outbox), release the turn, commit.
 *   emit      deterministic `say` segments (read-backs, confirmations) and `turn_end` —
 *             only after commit (durable-before-claim).
 *
 * `processSignal` (AMD / hangup / no-answer / barge-in / playout) and `processNoInput`
 * are single-transaction runtime paths on the same event log.
 */
import { DateTime, Effect, Either, Option, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import type {
  CallAttemptStatus,
  CallControlAction,
  ConversationState,
  EventRecord,
  Outcome,
  PendingProposal,
  ToolCall,
  ToolName,
  TurnDecision,
  WorkflowExecutionStatus,
} from "@feather-lite/domain";
import {
  buildTranscript,
  callbackScheduledConfirmation,
  closingPath,
  disputeClose,
  forcedTransition,
  hardshipClose,
  holdForTransfer,
  matchOverride,
  NO_PENDING_PROPOSAL_DETAIL,
  noInputPrompt,
  optOutConfirmation,
  overrideTransition,
  POLICY,
  promiseReadback,
  promiseRecordedConfirmation,
  READBACK_INTERRUPTED_DETAIL,
  replay,
  safeFallback,
  thirdPartyClose,
  toolsForState,
  transition,
  triggerFor,
  validateToolCall,
  visibleContext,
  voicemailScript,
  wrongNumberClose,
} from "@feather-lite/domain";
import type { TurnFrame } from "@feather-lite/contracts";
import { spokenIsoDate, spokenMoney } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { ConversationCompleted, NotFound, TurnInProgress } from "../errors.js";
import type { ConversationRow, PendingProposalJson } from "../db/rows.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import { CallControl } from "./CallControl.js";
import { ContextBuilder, type ConversationContext } from "./ContextBuilder.js";
import { IdGen } from "./Ids.js";
import { OutboxService } from "./Outbox.js";
import { SchedulingService } from "./Scheduling.js";
import { Tracing } from "./Tracing.js";
import { TurnDecider } from "./TurnDecider.js";
import type { DeciderInput, TurnResult } from "./types.js";

/* ------------------------------------------------------------------ */
/* Public input types                                                   */
/* ------------------------------------------------------------------ */

export interface TurnParams {
  readonly conversationId: string;
  readonly turnId: string;
  readonly userText: string;
  /** Voice runtime: what was actually heard of the previous agent line (barge-in). */
  readonly playout?: { readonly turnId: string; readonly heardText: string; readonly interrupted: boolean } | undefined;
  /** Voice runtime barge-in: take over an in-flight turn instead of failing with TurnInProgress. */
  readonly supersede?: boolean | undefined;
}

export type Signal =
  | { readonly kind: "amd_result"; readonly result: "HUMAN" | "MACHINE" | "NO_ANSWER" | "UNCERTAIN"; readonly confidence?: number | undefined; readonly actionId?: string | undefined }
  | { readonly kind: "no_answer"; readonly actionId?: string | undefined }
  | { readonly kind: "hangup"; readonly reason?: string | undefined; readonly actionId?: string | undefined }
  | { readonly kind: "barge_in"; readonly partialAgentText?: string | undefined; readonly actionId?: string | undefined }
  | { readonly kind: "playout"; readonly turnId: string; readonly heardText: string; readonly interrupted: boolean }
  | { readonly kind: "opening_played"; readonly text: string }
  | { readonly kind: "voicemail_drop"; readonly confidence?: number | undefined; readonly actionId?: string | undefined }
  | {
      readonly kind: "turn_metrics";
      readonly turnId: string;
      readonly eouDelayMs?: number | undefined;
      readonly transcriptionDelayMs?: number | undefined;
      readonly ttsTtfbMs?: number | undefined;
    };

export type Emit = (frame: TurnFrame) => Effect.Effect<void>;

interface SaySegment {
  readonly text: string;
  readonly allowInterruptions: boolean;
}

/* ------------------------------------------------------------------ */

const attemptStatusFor = (o: Outcome): CallAttemptStatus =>
  o === "NO_ANSWER" ? "NO_ANSWER" : o === "VOICEMAIL_LEFT" ? "VOICEMAIL" : o === "FAILED" ? "FAILED" : "COMPLETED";
const workflowStatusFor = (o: Outcome): WorkflowExecutionStatus =>
  o === "CALLBACK_SCHEDULED" || o === "NO_ANSWER" || o === "VOICEMAIL_LEFT" || o === "THIRD_PARTY_CONTACT" || o === "FAILED" ? "RUNNING" : "COMPLETED";

const toDomainProposal = (p: PendingProposalJson | null): PendingProposal | null =>
  p === null
    ? null
    : { kind: "PROMISE_TO_PAY", amount: p.amount as never, date: p.date as never, proposedAtSeq: p.proposed_at_seq, readBackAtSeq: null };

const derivedToolCallId = (turnId: string, call: ToolCall): string =>
  `${turnId}:${call.name}:${JSON.stringify(call.args)}`.slice(0, 200);

export class Orchestrator extends Effect.Service<Orchestrator>()("@feather-lite/Orchestrator", {
  effect: Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const cfg = yield* AppConfig;
    const conv = yield* ConversationRepo;
    const crm = yield* CrmRepo;
    const ids = yield* IdGen;
    const ctxBuilder = yield* ContextBuilder;
    const callControl = yield* CallControl;
    const scheduling = yield* SchedulingService;
    const outbox = yield* OutboxService;
    const decider = yield* TurnDecider;
    const tracing = yield* Tracing;

    /* ------------------------------ helpers ------------------------------ */

    const append = (conversationId: string, event: EventRecord extends infer _ ? Parameters<typeof conv.appendEvent>[0]["event"] : never, at: Date) =>
      Effect.gen(function* () {
        return yield* conv.appendEvent({ id: yield* ids.next(), conversationId, event, createdAt: at });
      });

    const lockOrFail = (conversationId: string) =>
      conv.lockConversation(conversationId).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "conversation", id: conversationId })), onSome: Effect.succeed })),
      );

    /** Record STATE_TRANSITION events for a path and update the row's current_state. */
    const applyTransitions = (
      row: ConversationRow,
      edges: ReadonlyArray<{ readonly from: ConversationState; readonly to: ConversationState; readonly triggeredBy: Parameters<typeof triggerFor>[2] | "forced" | "outcome" | "ended"; readonly matched?: string }>,
      at: Date,
    ) =>
      Effect.gen(function* () {
        let current = row.currentState;
        for (const e of edges) {
          const triggered_by =
            e.triggeredBy === "forced"
              ? "AMD"
              : e.triggeredBy === "outcome"
                ? "OUTCOME_COMMITTED"
                : e.triggeredBy === "ended"
                  ? "CALL_ENDED"
                  : triggerFor(e.from, e.to, e.triggeredBy);
          yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: e.from, to: e.to, triggered_by, ...(e.matched ? { matched: e.matched } : {}) } }, at);
          current = e.to;
        }
        if (current !== row.currentState) yield* conv.updateConversation(row.id, { currentState: current });
        return current;
      });

    /**
     * Finalize: closing path -> CALL_ENDED -> row/attempt/workflow status -> next actions -> outbox.
     * Must run inside the caller's transaction with the row locked.
     */
    const finalize = (params: {
      row: ConversationRow;
      ctx: ConversationContext;
      currentState: ConversationState;
      outcome: Outcome;
      metadata: Record<string, unknown>;
      at: Date;
    }) =>
      Effect.gen(function* () {
        const { row, ctx, outcome, at } = params;
        const path = closingPath(params.currentState);
        for (const [from, to] of path) {
          yield* append(row.id, { type: "STATE_TRANSITION", payload: { from, to, triggered_by: to === "COMPLETED" ? "CALL_ENDED" : "OUTCOME_COMMITTED" } }, at);
        }
        yield* append(row.id, { type: "CALL_ENDED", payload: { final_outcome: outcome } }, at);
        yield* conv.updateConversation(row.id, {
          currentState: "COMPLETED",
          finalOutcome: outcome,
          finalOutcomeMetadata: { ...row.finalOutcomeMetadata, ...params.metadata },
          endedAt: at,
        });
        yield* conv.setAttemptStatus(row.callAttemptId, attemptStatusFor(outcome), at);
        yield* conv.setWorkflowStatus(ctx.workflowExecutionId, workflowStatusFor(outcome));

        // Outcome-driven next actions (SPEC §14.2).
        if (outcome === "NO_ANSWER" || outcome === "THIRD_PARTY_CONTACT" || outcome === "FAILED") {
          yield* scheduling.createRetry({
            workflowExecutionId: ctx.workflowExecutionId,
            borrowerId: row.borrowerId,
            contactPointId: ctx.contactPointId,
            channel: row.channel,
            reason: outcome.toLowerCase(),
            now: at,
          });
        }
        yield* outbox.enqueuePostCall(row.id, at);
      });

    /** Turn the tool decision into effects. Runs inside T2 with the row locked. */
    const executeTool = (params: {
      row: ConversationRow;
      ctx: ConversationContext;
      events: ReadonlyArray<EventRecord>;
      state: ConversationState;
      call: ToolCall;
      turnId: string;
      at: Date;
    }) =>
      Effect.gen(function* () {
        const { row, ctx, state, call, at } = params;
        const snapshot = replay(params.events);
        const toolCallId = call.toolCallId ?? derivedToolCallId(params.turnId, call);
        const says: SaySegment[] = [];
        let nextState: ConversationState = state;
        let outcome: Outcome | null = null;
        let metadata: Record<string, unknown> = {};
        let unlocked = row.protectedContextUnlocked;
        let pendingProposal: PendingProposalJson | null | undefined = undefined; // undefined = unchanged
        let rejected: { reason: "NOT_ALLOWED" | "INVALID_ARGS"; detail: string } | null = null;
        let result: Record<string, unknown> = {};

        // Idempotency: a repeated tool_call_id returns the recorded result and does nothing else.
        if (snapshot.toolCallIds.has(toolCallId)) {
          const prior = params.events.find((e) => e.type === "TOOL_RESULT" && e.payload.tool_call_id === toolCallId);
          return { toolCallId, executed: false as const, duplicate: true as const, result: (prior?.type === "TOOL_RESULT" ? prior.payload.result : {}) as Record<string, unknown>, says, nextState, outcome, metadata, unlocked, pendingProposal, rejected };
        }

        const validated = validateToolCall(call, state);
        if (Either.isLeft(validated)) {
          rejected = { reason: validated.left._tag === "ToolNotAllowed" ? "NOT_ALLOWED" : "INVALID_ARGS", detail: validated.left.message };
          yield* append(row.id, { type: "TOOL_REJECTED", payload: { name: call.name, tool_call_id: toolCallId, state, reason: rejected.reason, detail: rejected.detail } }, at);
          return { toolCallId, executed: false as const, duplicate: false as const, result, says, nextState, outcome, metadata, unlocked, pendingProposal, rejected };
        }
        const args = validated.right as Record<string, unknown>;
        yield* append(row.id, { type: "TOOL_CALLED", payload: { name: call.name, tool_call_id: toolCallId, args } }, at);

        switch (call.name) {
          case "lookup_contact_profile": {
            const cp = yield* crm.findContactPoint(ctx.contactPointId);
            result = Option.isSome(cp) ? { value: cp.value.value, is_valid: cp.value.isValid, consent_status: cp.value.consentStatus } : { found: false };
            break;
          }
          case "get_account_context": {
            result = ctx.bundle.protectedContext ? { ...ctx.bundle.protectedContext } : { found: false };
            break;
          }
          case "confirm_right_party": {
            const confirmed = Boolean(args["confirmed"]);
            if (confirmed) {
              unlocked = true;
              const edges: ConversationState[] = state === "GREETING" ? ["VERIFYING_IDENTITY", "DISCUSSING_PAYMENT"] : ["DISCUSSING_PAYMENT"];
              let from: ConversationState = state;
              for (const to of edges) {
                yield* append(row.id, { type: "STATE_TRANSITION", payload: { from, to, triggered_by: triggerFor(from, to, "llm") } }, at);
                from = to;
              }
              nextState = "DISCUSSING_PAYMENT";
              yield* conv.updateConversation(row.id, { protectedContextUnlocked: true, currentState: nextState });
              result = { confirmed: true };
              // Deterministic account statement: amounts and dates are read from the ledger, never
              // generated by the model. Interruptible (it is not a legal disclosure).
              const pc = ctx.bundle.protectedContext;
              says.push({
                text: pc
                  ? `Thank you, ${ctx.borrowerFirstName}. I'm calling about your account with a balance of ${spokenMoney(pc.balance_due)}, which was due on ${spokenIsoDate(pc.due_date)}. Are you able to make a payment, or would you like me to call you back another time?`
                  : `Thank you, ${ctx.borrowerFirstName}. Are you able to make a payment, or would you like me to call you back another time?`,
                allowInterruptions: true,
              });
            } else {
              const edges: ConversationState[] = state === "GREETING" ? ["VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY"] : ["THIRD_PARTY_OR_WRONG_PARTY"];
              let from: ConversationState = state;
              for (const to of edges) {
                yield* append(row.id, { type: "STATE_TRANSITION", payload: { from, to, triggered_by: "LLM_INTENT" } }, at);
                from = to;
              }
              nextState = "THIRD_PARTY_OR_WRONG_PARTY";
              yield* conv.updateConversation(row.id, { currentState: nextState });
              outcome = "THIRD_PARTY_CONTACT";
              metadata = { notes: String(args["reason"] ?? "not the borrower") };
              says.push({ text: thirdPartyClose(), allowInterruptions: false });
              result = { confirmed: false, outcome };
            }
            break;
          }
          case "propose_promise_to_pay": {
            const proposal: PendingProposalJson = {
              kind: "PROMISE_TO_PAY",
              amount: String(args["amount"]),
              date: String(args["date"]),
              proposed_at_seq: snapshot.lastSequenceNo + 1,
              read_back_turn_id: params.turnId,
            };
            pendingProposal = proposal;
            if (state !== "CONFIRMING_OUTCOME") {
              yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: state, to: "CONFIRMING_OUTCOME", triggered_by: "PROPOSAL" } }, at);
              nextState = "CONFIRMING_OUTCOME";
            }
            yield* conv.updateConversation(row.id, { currentState: nextState, pendingProposal: proposal });
            // Read-back is interruptible on purpose (Phase 1.5 finding #6); the fully-heard guard is
            // enforced at record time via AGENT_TURN_PLAYOUT.
            says.push({ text: promiseReadback({ amount: proposal.amount, date: proposal.date }), allowInterruptions: true });
            result = { amount: proposal.amount, date: proposal.date };
            break;
          }
          case "record_promise_to_pay": {
            const proposal = row.pendingProposal;
            const heardFully = proposal
              ? !params.events.some((e) => e.type === "AGENT_TURN_PLAYOUT" && e.payload.turn_id === proposal.read_back_turn_id && e.payload.interrupted)
              : false;
            if (!proposal || !heardFully) {
              rejected = { reason: "INVALID_ARGS", detail: proposal ? READBACK_INTERRUPTED_DETAIL : NO_PENDING_PROPOSAL_DETAIL };
              yield* append(row.id, { type: "TOOL_REJECTED", payload: { name: call.name, tool_call_id: toolCallId, state, reason: rejected.reason, detail: rejected.detail } }, at);
              if (proposal) {
                // Repeat the read-back and re-arm the guard for this turn.
                pendingProposal = { ...proposal, read_back_turn_id: params.turnId };
                yield* conv.updateConversation(row.id, { pendingProposal });
                says.push({ text: `Let me repeat that. ${promiseReadback({ amount: proposal.amount, date: proposal.date })}`, allowInterruptions: true });
              } else {
                says.push({ text: "I don't have a payment amount and date to record yet. What amount and date work for you?", allowInterruptions: true });
                if (state === "CONFIRMING_OUTCOME") {
                  yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: state, to: "DISCUSSING_PAYMENT", triggered_by: "USER_DECLINED" } }, at);
                  nextState = "DISCUSSING_PAYMENT";
                  yield* conv.updateConversation(row.id, { currentState: nextState });
                }
              }
              return { toolCallId, executed: false as const, duplicate: false as const, result, says, nextState, outcome, metadata, unlocked, pendingProposal, rejected };
            }
            outcome = "PROMISE_TO_PAY";
            metadata = { promised_amount: proposal.amount, promised_date: proposal.date, notes: "confirmed by borrower after read-back" };
            if (ctx.loanId) yield* crm.setLoanLastPromiseDate(ctx.loanId, proposal.date);
            pendingProposal = null;
            yield* conv.updateConversation(row.id, { pendingProposal: null });
            says.push({ text: promiseRecordedConfirmation({ amount: proposal.amount, date: proposal.date }), allowInterruptions: false });
            result = { promised_amount: proposal.amount, promised_date: proposal.date };
            break;
          }
          case "schedule_callback": {
            const dueAtIso = String(args["datetime"]);
            yield* scheduling.scheduleCallback({
              workflowExecutionId: ctx.workflowExecutionId,
              borrowerId: row.borrowerId,
              contactPointId: ctx.contactPointId,
              channel: row.channel,
              dueAt: new Date(dueAtIso),
              reason: String(args["reason"] ?? "borrower_requested"),
            });
            outcome = "CALLBACK_SCHEDULED";
            metadata = { callback_at: dueAtIso };
            says.push({ text: callbackScheduledConfirmation({ datetime: dueAtIso, timeZone: ctx.borrowerTimeZone }), allowInterruptions: false });
            result = { callback_at: dueAtIso };
            break;
          }
          case "record_opt_out": {
            const scope = String(args["scope"] ?? "borrower");
            if (scope === "borrower") yield* crm.setBorrowerStatus(row.borrowerId, "OPT_OUT");
            else yield* crm.setContactPointConsent(ctx.contactPointId, "OPTED_OUT");
            yield* scheduling.cancelPending(ctx.workflowExecutionId, "opt_out", null);
            outcome = "OPT_OUT";
            metadata = { scope, reason: String(args["reason"] ?? "borrower_request") };
            says.push({ text: optOutConfirmation(), allowInterruptions: false });
            result = { scope };
            break;
          }
          case "record_wrong_party_contact": {
            const outcomeType = String(args["outcome_type"]);
            if (outcomeType === "WRONG_NUMBER") {
              yield* crm.setContactPointValidity(ctx.contactPointId, false);
              yield* scheduling.cancelPending(ctx.workflowExecutionId, "wrong_number", ["CALLBACK", "RETRY_CALL"]);
              outcome = "WRONG_NUMBER";
              if (state !== "WRONG_NUMBER") {
                yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: state, to: "WRONG_NUMBER", triggered_by: "LLM_INTENT" } }, at);
                nextState = "WRONG_NUMBER";
              }
              says.push({ text: wrongNumberClose(), allowInterruptions: false });
            } else {
              outcome = "THIRD_PARTY_CONTACT";
              if (state !== "THIRD_PARTY_OR_WRONG_PARTY") {
                const edges: ConversationState[] = state === "GREETING" ? ["VERIFYING_IDENTITY", "THIRD_PARTY_OR_WRONG_PARTY"] : ["THIRD_PARTY_OR_WRONG_PARTY"];
                let from: ConversationState = state;
                for (const to of edges) {
                  yield* append(row.id, { type: "STATE_TRANSITION", payload: { from, to, triggered_by: "LLM_INTENT" } }, at);
                  from = to;
                }
                nextState = "THIRD_PARTY_OR_WRONG_PARTY";
              }
              says.push({ text: thirdPartyClose(), allowInterruptions: false });
            }
            yield* conv.updateConversation(row.id, { currentState: nextState });
            metadata = { notes: String(args["notes"] ?? "") };
            result = { outcome, notes: metadata["notes"] };
            break;
          }
        }
        yield* append(row.id, { type: "TOOL_RESULT", payload: { name: call.name, tool_call_id: toolCallId, result } }, at);
        return { toolCallId, executed: true as const, duplicate: false as const, result, says, nextState, outcome, metadata, unlocked, pendingProposal, rejected };
      });

    /* ---------------------------- processTurn ---------------------------- */

    const processTurn = (params: TurnParams, emit: Emit) =>
      Effect.gen(function* () {
        const startedAt = yield* DateTime.now;
        const startedMs = DateTime.toEpochMillis(startedAt);
        /**
         * Wall clock, deliberately separate from `startedMs`. `startedAt` comes from the Effect
         * clock, which the VirtualClock shifts for seeded history and scenarios — so measuring a
         * duration as `Date.now() - startedMs` mixed a real timestamp with a virtual one and
         * produced nonsense (seeded rows carried a "TTFT" of several days). Ledger timestamps stay
         * on the virtual clock; elapsed time is measured here.
         */
        const wallStartedMs = Date.now();
        const nowDate = DateTime.toDateUtc(startedAt);

        /* ---------- T1 ---------- */
        const t1 = yield* sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lockOrFail(params.conversationId);
            // Idempotency first: the same turn_id again (retry / reconnect) replays the recorded
            // result even if that turn completed the conversation.
            const existing = yield* conv.findTurn({ conversationId: row.id, turnId: params.turnId });
            if (Option.isSome(existing) && existing.value.status === "DONE" && existing.value.result) {
              return { replay: existing.value.result as unknown as TurnResult, row, ctx: null, events: [] as ReadonlyArray<EventRecord> };
            }
            if (row.finalOutcome !== null || row.currentState === "COMPLETED") {
              return yield* Effect.fail(new ConversationCompleted({ conversationId: row.id }));
            }
            if (row.activeTurnId !== null && row.activeTurnId !== params.turnId) {
              if (!params.supersede) return yield* Effect.fail(new TurnInProgress({ conversationId: row.id, activeTurnId: row.activeTurnId }));
              yield* conv.finishTurn({ conversationId: row.id, turnId: row.activeTurnId, status: "SUPERSEDED", result: {}, finishedAt: nowDate });
              yield* append(row.id, { type: "TURN_SUPERSEDED", payload: { turn_id: row.activeTurnId, superseded_by: params.turnId } }, nowDate);
              yield* conv.releaseTurn(row.id, row.activeTurnId);
            }
            const claimed = yield* conv.claimTurn(row.id, params.turnId);
            if (!claimed) return yield* Effect.fail(new TurnInProgress({ conversationId: row.id, activeTurnId: row.activeTurnId ?? "?" }));
            if (Option.isNone(existing)) {
              yield* conv.insertTurn({ conversationId: row.id, turnId: params.turnId, userText: params.userText, startedAt: nowDate });
            }
            if (params.playout) {
              yield* append(row.id, { type: "AGENT_TURN_PLAYOUT", payload: { turn_id: params.playout.turnId, heard_text: params.playout.heardText, interrupted: params.playout.interrupted } }, nowDate);
            }
            yield* append(
              row.id,
              {
                type: "USER_TURN_FINAL",
                payload: {
                  text: params.userText,
                  turn_id: params.turnId,
                  ...(params.playout?.interrupted ? { heard_agent_text: params.playout.heardText } : {}),
                },
              },
              nowDate,
            );
            const ctx = yield* ctxBuilder.forConversation(row, startedAt);
            const events = yield* conv.listEvents(row.id);
            return { replay: null, row, ctx, events };
          }),
        );

        if (t1.replay) {
          const r = t1.replay;
          yield* emit({ type: "turn_start", turn_id: params.turnId, state: t1.row.currentState });
          yield* emit({ type: "turn_end", turn_id: params.turnId, new_state: r.newState, agent_text: r.agentText, tool_called: r.toolCalled ? { name: r.toolCalled.name, args: r.toolCalled.args } : null, call_control_action: r.callControlAction, outcome: r.outcome, end_call: r.endCall, degraded: r.degraded, ttft_ms: r.ttftMs });
          return r;
        }
        const row = t1.row;
        const ctx = t1.ctx as ConversationContext;
        const state = row.currentState;
        yield* emit({ type: "turn_start", turn_id: params.turnId, state });

        /* ---------- decide (no tx) ---------- */
        const override = matchOverride(params.userText, { borrowerFirstName: ctx.borrowerFirstName });
        let decisionResult: { decision: TurnDecision | null; streamedText: string; degraded: string | null; ttftMs: number | null } = {
          decision: null,
          streamedText: "",
          degraded: null,
          ttftMs: null,
        };

        if (Option.isNone(override)) {
          const visible = visibleContext(ctx.bundle, state, row.protectedContextUnlocked);
          // Effectively the whole call. A collections call is ~52-90s (docs/loadtest tier 2); even a
          // pathological 30-turn one is 1-2k prompt tokens, against gpt-4.1's 1,047,576-token window.
          // The old slice(-12) was ~6 exchanges, so the opening Mini-Miranda and anything the borrower
          // said early -- hardship, a dispute, a callback preference -- fell out mid-call and the model
          // could not recover it. `slice` is kept as a bound against an unbounded prompt, not as a window.
          const transcript = buildTranscript(t1.events, { excludeSuperseded: true })
            .slice(-100)
            .map((e) => ({ speaker: e.speaker, text: e.text }));
          const snapshot = replay(t1.events);
          // Barge-in truth may arrive with this request or as an earlier `playout` signal: consult both.
          const heardFromLedger = ((): string | null => {
            const lastAgent = [...t1.events].reverse().find((e) => e.type === "AGENT_TURN" && e.payload.turn_id && e.payload.turn_id !== "opening");
            if (!lastAgent || lastAgent.type !== "AGENT_TURN") return null;
            const playout = [...t1.events].reverse().find((e) => e.type === "AGENT_TURN_PLAYOUT" && e.payload.turn_id === lastAgent.payload.turn_id);
            return playout && playout.type === "AGENT_TURN_PLAYOUT" && playout.payload.interrupted ? playout.payload.heard_text : null;
          })();
          const input: DeciderInput = {
            conversationId: row.id,
            turnId: params.turnId,
            state,
            userText: params.userText,
            heardAgentText: params.playout?.interrupted ? params.playout.heardText : heardFromLedger,
            context: visible,
            allowedTools: toolsForState(state),
            pendingProposal: toDomainProposal(row.pendingProposal) ?? snapshot.pendingProposal,
            recentTranscript: transcript,
            model: cfg.llmModelByState[state],
            borrowerLocalDate: ctx.borrowerLocalDate,
            borrowerTimeZone: ctx.borrowerTimeZone,
            borrowerFirstName: ctx.borrowerFirstName,
          };
          let streamed = "";
          let decision: TurnDecision | null = null;
          let ttft: number | null = null;
          const consumed = yield* decider.decide(input).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                if (chunk._tag === "TextDelta") {
                  if (ttft === null) ttft = Date.now() - wallStartedMs;
                  streamed += chunk.text;
                  yield* emit({ type: "delta", text: chunk.text });
                } else {
                  decision = chunk.decision;
                  if (ttft === null) ttft = Date.now() - wallStartedMs;
                }
              }),
            ),
            Effect.either,
          );
          const degraded = Either.isLeft(consumed) ? `${consumed.left._tag}: ${consumed.left.detail}` : decision === null ? "TurnDeciderInvalidOutput: stream ended without a decision" : null;
          decisionResult = { decision, streamedText: streamed, degraded, ttftMs: ttft };
        }

        /* ---------- T2 ---------- */
        const t2 = yield* sql.withTransaction(
          Effect.gen(function* () {
            const at = DateTime.toDateUtc(yield* DateTime.now);
            const locked = yield* lockOrFail(row.id);
            if (locked.activeTurnId !== params.turnId) {
              // Superseded while deciding: record and stop quietly.
              yield* conv.finishTurn({ conversationId: row.id, turnId: params.turnId, status: "SUPERSEDED", result: {}, finishedAt: at });
              return null;
            }
            const events = yield* conv.listEvents(row.id);
            const says: SaySegment[] = [];
            let nextState: ConversationState = locked.currentState;
            let outcome: Outcome | null = null;
            let metadata: Record<string, unknown> = {};
            let toolCalled: ToolCall | null = null;
            let callControlAction: { action: CallControlAction; action_id: string } | null = null;
            let degraded = false;
            let agentText = decisionResult.streamedText;

            if (Option.isSome(override)) {
              const o = override.value;
              const moved = overrideTransition(locked.currentState, o.targetState);
              const target = Either.isRight(moved) ? moved.right : locked.currentState;
              if (Either.isRight(moved) && target !== locked.currentState) {
                yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: locked.currentState, to: target, triggered_by: "OVERRIDE_RULE", matched: o.matched } }, at);
                yield* conv.updateConversation(row.id, { currentState: target });
              }
              nextState = target;
              switch (o.reason) {
                case "OPT_OUT": {
                  const call: ToolCall = { name: "record_opt_out", args: { scope: "borrower", reason: "borrower_request" } };
                  const r = yield* executeTool({ row: locked, ctx, events, state: "OPT_OUT", call, turnId: params.turnId, at });
                  toolCalled = call;
                  says.push(...r.says);
                  outcome = r.outcome;
                  metadata = r.metadata;
                  break;
                }
                case "WRONG_NUMBER": {
                  const call: ToolCall = { name: "record_wrong_party_contact", args: { outcome_type: "WRONG_NUMBER", notes: "override: wrong number" } };
                  const r = yield* executeTool({ row: { ...locked, currentState: "WRONG_NUMBER" }, ctx, events, state: "WRONG_NUMBER", call, turnId: params.turnId, at });
                  toolCalled = call;
                  says.push(...r.says);
                  outcome = r.outcome;
                  metadata = r.metadata;
                  break;
                }
                case "DISPUTE":
                case "HARDSHIP": {
                  const queue = o.reason === "DISPUTE" ? "disputes_queue" : "hardship_queue";
                  const reason = o.reason === "DISPUTE" ? "debt_dispute" : "hardship_or_distress";
                  const logged = yield* callControl.warmTransfer({ conversationId: row.id, events, target: queue, reason, actionId: null, now: at });
                  callControlAction = { action: "WARM_TRANSFER", action_id: logged.action_id };
                  yield* scheduling.createHumanFollowup({
                    workflowExecutionId: ctx.workflowExecutionId,
                    borrowerId: row.borrowerId,
                    contactPointId: ctx.contactPointId,
                    conversationId: row.id,
                    queue,
                    reason,
                    now: at,
                  });
                  yield* conv.updateConversation(row.id, { transferTarget: queue });
                  outcome = o.reason === "DISPUTE" ? "DISPUTED" : "ESCALATED";
                  metadata = { reason, transcript_excerpt: params.userText.slice(0, 300), matched: o.matched };
                  says.push({ text: o.reason === "DISPUTE" ? disputeClose() : hardshipClose(), allowInterruptions: false });
                  break;
                }
              }
            } else if (decisionResult.decision === null) {
              // Decider failed: safe fallback, state unchanged, event recorded (registry row "TurnDeciderUnavailable").
              degraded = true;
              yield* append(row.id, { type: "TURN_DECISION_REJECTED", payload: { state: locked.currentState, reason: decisionResult.degraded?.startsWith("TurnDeciderUnavailable") ? "DECIDER_UNAVAILABLE" : "INVALID_OUTPUT", detail: decisionResult.degraded ?? "unknown" } }, at);
              if (agentText.trim().length === 0) says.push({ text: safeFallback(), allowInterruptions: true });
            } else {
              const d = decisionResult.decision;
              // 1. transition suggested by the model, validated by the state machine.
              //    When a tool is called, the TOOL drives the transition (tools are the only way to
              //    unlock context, propose, record...) and the suggestion is advisory only.
              const moved = d.toolCall !== null ? Either.right(locked.currentState) : transition(locked.currentState, d.suggestedNextState);
              if (Either.isLeft(moved)) {
                degraded = true;
                yield* append(row.id, { type: "TURN_DECISION_REJECTED", payload: { state: locked.currentState, reason: "INVALID_TRANSITION", detail: moved.left.message, suggested_next_state: String(d.suggestedNextState) } }, at);
              }
              // 2. tool (validated against the pre-transition state; may itself move state)
              if (d.toolCall !== null) {
                const r = yield* executeTool({ row: locked, ctx, events, state: locked.currentState, call: d.toolCall, turnId: params.turnId, at });
                toolCalled = d.toolCall;
                says.push(...r.says);
                outcome = r.outcome;
                metadata = r.metadata;
                nextState = r.nextState;
                if (r.rejected) degraded = true;
                if (r.executed && r.result && agentText.length === 0 && d.message.length > 0 && !r.says.length) agentText = d.message;
              } else if (Either.isRight(moved) && moved.right !== locked.currentState) {
                if (moved.right === "WARM_TRANSFER_PENDING") {
                  // Borrower asked for a human: transfer stub + escalation outcome.
                  yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: locked.currentState, to: "WARM_TRANSFER_PENDING", triggered_by: "LLM_INTENT" } }, at);
                  const logged = yield* callControl.warmTransfer({ conversationId: row.id, events, target: "collections_queue", reason: "borrower_requested_human", actionId: null, now: at });
                  callControlAction = { action: "WARM_TRANSFER", action_id: logged.action_id };
                  yield* scheduling.createHumanFollowup({ workflowExecutionId: ctx.workflowExecutionId, borrowerId: row.borrowerId, contactPointId: ctx.contactPointId, conversationId: row.id, queue: "collections_queue", reason: "borrower_requested_human", now: at });
                  yield* conv.updateConversation(row.id, { transferTarget: "collections_queue", currentState: "WARM_TRANSFER_PENDING" });
                  nextState = "WARM_TRANSFER_PENDING";
                  outcome = "ESCALATED";
                  metadata = { reason: "borrower_requested_human" };
                  says.push({ text: holdForTransfer(), allowInterruptions: false });
                } else {
                  yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: locked.currentState, to: moved.right, triggered_by: triggerFor(locked.currentState, moved.right, "llm") } }, at);
                  nextState = moved.right;
                  if (locked.currentState === "CONFIRMING_OUTCOME" && moved.right === "DISCUSSING_PAYMENT") {
                    yield* conv.updateConversation(row.id, { currentState: nextState, pendingProposal: null });
                  } else {
                    yield* conv.updateConversation(row.id, { currentState: nextState });
                  }
                  if (moved.right === "ENDING") {
                    // Model closed the call without an outcome tool: nothing to record but the goodbye.
                    if (agentText.trim().length === 0) agentText = d.message;
                  }
                }
              }
              if (agentText.trim().length === 0 && says.length === 0) {
                agentText = d.message.trim().length > 0 ? d.message : safeFallback();
              }
            }

            // Non-terminal ENDING (model said goodbye): treat as FAILED-free close -> COMPLETED with no outcome? No:
            // a call that ends without a disposition is recorded as FAILED so the workflow retries.
            if (outcome === null && nextState === "ENDING") outcome = "FAILED";

            // 3. AGENT_TURN with the full spoken text of this turn (deltas + says)
            const fullText = [agentText.trim(), ...says.map((s) => s.text)].filter((s) => s.length > 0).join(" ");
            yield* append(
              row.id,
              {
                type: "AGENT_TURN",
                payload: {
                  text: fullText,
                  state: nextState,
                  turn_id: params.turnId,
                  speak_mode: says.some((s) => !s.allowInterruptions) ? "non_interruptible" : "interruptible",
                  ...(degraded ? { degraded: true } : {}),
                },
              },
              at,
            );

            // 4. finalize if an outcome was committed
            let endCall = false;
            if (outcome !== null) {
              yield* finalize({ row: locked, ctx, currentState: nextState, outcome, metadata, at });
              nextState = "COMPLETED";
              endCall = true;
            }

            const result: TurnResult = {
              turnId: params.turnId,
              agentText: fullText,
              newState: nextState,
              toolCalled,
              callControlAction,
              outcome,
              endCall,
              degraded,
              ttftMs: decisionResult.ttftMs,
            };
            yield* conv.finishTurn({ conversationId: row.id, turnId: params.turnId, status: "DONE", result: result as unknown as Record<string, unknown>, finishedAt: at });
            yield* conv.releaseTurn(row.id, params.turnId);
            return { result, says };
          }),
        );

        if (t2 === null) {
          yield* tracing.turn({
            conversationId: row.id,
            turnId: params.turnId,
            state,
            newState: null,
            userText: params.userText,
            agentText: decisionResult.streamedText,
            tool: null,
            outcome: null,
            superseded: true,
            degraded: decisionResult.degraded,
            startedAtMs: wallStartedMs,
            endedAtMs: Date.now(),
            ttftMs: decisionResult.ttftMs,
          });
          yield* emit({ type: "error", turn_id: params.turnId, code: "SUPERSEDED", message: "turn superseded by a newer user turn" });
          return { turnId: params.turnId, agentText: decisionResult.streamedText, newState: state, toolCalled: null, callControlAction: null, outcome: null, endCall: false, degraded: false, ttftMs: decisionResult.ttftMs } satisfies TurnResult;
        }
        /* ---------- emit after commit ---------- */
        for (const s of t2.says) yield* emit({ type: "say", text: s.text, allow_interruptions: s.allowInterruptions });
        const r = t2.result;
        yield* tracing.turn({
          conversationId: row.id,
          turnId: params.turnId,
          state,
          newState: r.newState,
          userText: params.userText,
          agentText: r.agentText,
          tool: r.toolCalled?.name ?? null,
          outcome: r.outcome,
          superseded: false,
          degraded: r.degraded ? (decisionResult.degraded ?? "degraded") : null,
          startedAtMs: wallStartedMs,
          endedAtMs: Date.now(),
          ttftMs: r.ttftMs,
        });
        // The call is over. On a simulated call there is no voice worker, so nothing more is coming
        // and every held turn can be emitted now. On a voice call the last turn's EOU/STT/TTS
        // numbers are still in flight (they arrive a few hundred ms later, as a turn_metrics
        // signal) — emitting here would publish that turn with half its waterfall missing, so it is
        // left to the signal, with the shutdown flush as the backstop.
        if ((r.endCall || r.outcome !== null) && row.channel !== "voice") yield* tracing.finalize(row.id);
        yield* emit({
          type: "turn_end",
          turn_id: params.turnId,
          new_state: r.newState,
          agent_text: r.agentText,
          tool_called: r.toolCalled ? { name: r.toolCalled.name, args: r.toolCalled.args } : null,
          call_control_action: r.callControlAction,
          outcome: r.outcome,
          end_call: r.endCall,
          degraded: r.degraded,
          ttft_ms: r.ttftMs,
        });
        return r;
      });

    /* ---------------------------- processNoInput ---------------------------- */

    /**
     * A call can end down several paths — a turn, a no-input strike, a hangup or no-answer signal —
     * and every one of them must release the turns the tracer is still holding for voice-worker
     * metrics. Missing one does not lose a turn quietly: it leaves it buffered until the process
     * exits, which on a long-running server means the trace is never written at all.
     */
    const finalizeTracingIfEnded = (conversationId: string) => (r: TurnResult) =>
      r.endCall || r.outcome !== null ? tracing.finalize(conversationId) : Effect.void;

    const processNoInput = (conversationId: string, actionId: string | null = null) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const at = DateTime.toDateUtc(yield* DateTime.now);
          const row = yield* lockOrFail(conversationId);
          if (row.finalOutcome !== null) return yield* Effect.fail(new ConversationCompleted({ conversationId }));
          const ctx = yield* ctxBuilder.forConversation(row, DateTime.unsafeMake(at));
          const events = yield* conv.listEvents(row.id);
          const strike = row.noInputCount + 1;
          yield* append(row.id, { type: "NO_INPUT", payload: { state: row.currentState, count: strike } }, at);
          yield* conv.updateConversation(row.id, { noInputCount: strike });
          const text = noInputPrompt(strike);
          if (strike >= POLICY.noInputStrikes) {
            const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "NO_INPUT_CLOSE", actionId, payload: { count: strike }, now: at });
            yield* append(row.id, { type: "AGENT_TURN", payload: { text, state: row.currentState, speak_mode: "non_interruptible" } }, at);
            yield* finalize({ row, ctx, currentState: row.currentState, outcome: "NO_ANSWER", metadata: { reason: "no_input_timeout" }, at });
            return { turnId: `no-input-${strike}`, agentText: text, newState: "COMPLETED", toolCalled: null, callControlAction: { action: "NO_INPUT_CLOSE", action_id: logged.action_id }, outcome: "NO_ANSWER", endCall: true, degraded: false, ttftMs: null } satisfies TurnResult;
          }
          yield* append(row.id, { type: "AGENT_TURN", payload: { text, state: row.currentState, speak_mode: "interruptible" } }, at);
          return { turnId: `no-input-${strike}`, agentText: text, newState: row.currentState, toolCalled: null, callControlAction: null, outcome: null, endCall: false, degraded: false, ttftMs: null } satisfies TurnResult;
        }),
      ).pipe(Effect.tap(finalizeTracingIfEnded(conversationId)));

    /* ---------------------------- processSignal ---------------------------- */

    const processSignal = (conversationId: string, signal: Signal) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const at = DateTime.toDateUtc(yield* DateTime.now);
          const row = yield* lockOrFail(conversationId);
          const events = yield* conv.listEvents(row.id);
          const done = (r: Partial<TurnResult> & { agentText: string; newState: ConversationState }): TurnResult => ({
            turnId: `signal-${signal.kind}`,
            toolCalled: null,
            callControlAction: null,
            outcome: null,
            endCall: false,
            degraded: false,
            ttftMs: null,
            ...r,
          });

          if (signal.kind === "turn_metrics") {
            // Pure telemetry: merged into the turn row that already holds ttft_ms, and handed to the
            // tracer, which has been holding this turn's span open waiting for exactly these numbers.
            const latency = {
              eou_delay_ms: signal.eouDelayMs ?? null,
              transcription_delay_ms: signal.transcriptionDelayMs ?? null,
              tts_ttfb_ms: signal.ttsTtfbMs ?? null,
            };
            yield* conv.mergeTurnResult({ conversationId: row.id, turnId: signal.turnId, patch: latency });
            yield* tracing.turnLatency(row.id, signal.turnId, {
              eouDelayMs: latency.eou_delay_ms,
              transcriptionDelayMs: latency.transcription_delay_ms,
              ttsTtfbMs: latency.tts_ttfb_ms,
            });
            return done({ agentText: "", newState: row.currentState });
          }
          if (signal.kind === "playout") {
            yield* append(row.id, { type: "AGENT_TURN_PLAYOUT", payload: { turn_id: signal.turnId, heard_text: signal.heardText, interrupted: signal.interrupted } }, at);
            return done({ agentText: "", newState: row.currentState });
          }
          if (signal.kind === "opening_played") {
            const already = events.some((e) => e.type === "AGENT_TURN" && e.payload.turn_id === "opening");
            if (!already) yield* append(row.id, { type: "AGENT_TURN", payload: { text: signal.text, state: row.currentState, turn_id: "opening", speak_mode: "non_interruptible" } }, at);
            return done({ agentText: signal.text, newState: row.currentState });
          }
          if (signal.kind === "barge_in") {
            const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "BARGE_IN_DETECTED", actionId: signal.actionId ?? null, payload: { partial_agent_text: signal.partialAgentText ?? null, resume_allowed: true }, now: at });
            return done({ agentText: "", newState: row.currentState, callControlAction: { action: "BARGE_IN_DETECTED", action_id: logged.action_id } });
          }
          if (row.finalOutcome !== null) return yield* Effect.fail(new ConversationCompleted({ conversationId }));
          const ctx = yield* ctxBuilder.forConversation(row, DateTime.unsafeMake(at));

          if (signal.kind === "amd_result" || signal.kind === "voicemail_drop") {
            const result = signal.kind === "voicemail_drop" ? "MACHINE" : signal.result;
            yield* append(row.id, { type: "AMD_RESULT", payload: { result, ...(signal.confidence !== undefined ? { confidence: signal.confidence } : {}) } }, at);
            if (result === "MACHINE") {
              const moved = forcedTransition(row.currentState, "VOICEMAIL");
              if (Either.isRight(moved) && row.currentState !== "VOICEMAIL") {
                yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: row.currentState, to: "VOICEMAIL", triggered_by: "AMD" } }, at);
                yield* conv.updateConversation(row.id, { currentState: "VOICEMAIL" });
              }
              const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "VOICEMAIL_DROP", actionId: signal.actionId ?? null, payload: { ...(signal.confidence !== undefined ? { confidence: signal.confidence } : {}) }, now: at });
              const text = voicemailScript(ctx.bundle.publicContext);
              yield* append(row.id, { type: "AGENT_TURN", payload: { text, state: "VOICEMAIL", speak_mode: "non_interruptible" } }, at);
              yield* finalize({ row, ctx, currentState: "VOICEMAIL", outcome: "VOICEMAIL_LEFT", metadata: { amd: result }, at });
              return done({ agentText: text, newState: "COMPLETED", callControlAction: { action: "VOICEMAIL_DROP", action_id: logged.action_id }, outcome: "VOICEMAIL_LEFT", endCall: true });
            }
            if (result === "NO_ANSWER") {
              const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "NO_ANSWER", actionId: signal.actionId ?? null, now: at });
              yield* finalize({ row, ctx, currentState: row.currentState, outcome: "NO_ANSWER", metadata: { amd: result }, at });
              return done({ agentText: "", newState: "COMPLETED", callControlAction: { action: "NO_ANSWER", action_id: logged.action_id }, outcome: "NO_ANSWER", endCall: true });
            }
            yield* conv.setAttemptStatus(row.callAttemptId, "ANSWERED", null);
            return done({ agentText: "", newState: row.currentState });
          }
          if (signal.kind === "no_answer") {
            const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "NO_ANSWER", actionId: signal.actionId ?? null, now: at });
            yield* finalize({ row, ctx, currentState: row.currentState, outcome: "NO_ANSWER", metadata: { reason: "no_answer" }, at });
            return done({ agentText: "", newState: "COMPLETED", callControlAction: { action: "NO_ANSWER", action_id: logged.action_id }, outcome: "NO_ANSWER", endCall: true });
          }
          // hangup: the borrower (or provider) ended the call before a disposition.
          const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "HANGUP", actionId: signal.actionId ?? null, payload: { reason: signal.reason ?? "participant_disconnected" }, now: at });
          const outcome: Outcome = row.protectedContextUnlocked ? "FAILED" : "NO_ANSWER";
          yield* finalize({ row, ctx, currentState: row.currentState, outcome, metadata: { reason: signal.reason ?? "hangup" }, at });
          return done({ agentText: "", newState: "COMPLETED", callControlAction: { action: "HANGUP", action_id: logged.action_id }, outcome, endCall: true });
        }),
      ).pipe(Effect.tap(finalizeTracingIfEnded(conversationId)));

    return { processTurn, processNoInput, processSignal } as const;
  }),
  dependencies: [ConversationRepo.Default, CrmRepo.Default, IdGen.Default, ContextBuilder.Default, CallControl.Default, SchedulingService.Default, OutboxService.Default],
}) {}
