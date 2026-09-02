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
import { DateTime, Duration, Effect, Either, Option, Stream } from "effect";
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
  NEVER_SERVED_REASON,
  ORPHANED_REASON,
  biasTermsFor,
  holdRequest,
  overrideTransition,
  POLICY,
  promiseReadback,
  promiseRecordedConfirmation,
  READBACK_INTERRUPTED_DETAIL,
  READBACK_UNCONFIRMED_DETAIL,
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
import { ConversationCompleted, NotFound, TurnInProgress, TurnSuperseded } from "../errors.js";
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
import type { DeciderInput, TurnDecisionSource, TurnResult } from "./types.js";

/* ------------------------------------------------------------------ */
/* Public input types                                                   */
/* ------------------------------------------------------------------ */

/**
 * How much longer the worker should wait before its no-input strike, on a `wait` (issue #1, D1).
 *
 * Once, and bounded: the spec's "extend the away timer once, by a bounded amount". Long enough to
 * find a card or a calendar, short enough that a borrower who has walked away is still noticed.
 */
export const WAIT_EXTEND_MS = 15_000;

export interface TurnParams {
  readonly conversationId: string;
  readonly turnId: string;
  readonly userText: string;
  /** Voice runtime: what was actually heard of the previous agent line (barge-in). */
  readonly playout?: { readonly turnId: string; readonly heardText: string; readonly interrupted: boolean } | undefined;
  /** Voice runtime barge-in: take over an in-flight turn instead of failing with TurnInProgress. */
  readonly supersede?: boolean | undefined;
  /**
   * How long the caller held this turn before claiming, waiting out a non-interruptible segment
   * (issue #1 D1, F2). Passed in rather than measured here because the hold happens **before** T1,
   * outside any transaction; the orchestrator's job is only to record it.
   */
  readonly heldMs?: number | undefined;
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
      readonly ttsAudioMs?: number | undefined;
      readonly ttsChars?: number | undefined;
      /** Pauses this turn recovered from without cutting the line (issue #1, D1's `resume`). */
      readonly resumedMs?: ReadonlyArray<number> | undefined;
    };

export type Emit = (frame: TurnFrame) => Effect.Effect<void>;

interface SaySegment {
  readonly text: string;
  readonly allowInterruptions: boolean;
}

/* ------------------------------------------------------------------ */

/**
 * What the ledger says about whether the borrower heard the read-back (PRD §5.2.8, ADR 0008).
 *
 * The evidence is the `AGENT_TURN_PLAYOUT` the voice runtime reports for the read-back turn. A
 * report that says `interrupted` refuses, as it always has. The empty case is the one that used to
 * be wrong: the guard read "no report says interrupted" as "heard in full", so a read-back whose
 * report never arrived — a worker killed after speaking, a signal POST that failed, a job process
 * that died — recorded the promise on no evidence at all. ADR 0008's TTS cross-check covers a
 * report that arrives *wrong*; nothing covered one that never arrives.
 *
 * So on `voice` the guard requires a report that positively says the line was heard. On
 * `simulated` the absence keeps its vacuous pass: the scenario runner drives the orchestrator
 * directly and there is no playout reporter in that path by design, so demanding one would fail
 * the twenty scenarios over a fact about the harness rather than about the call.
 *
 * **The residual, stated rather than discovered later.** The worker posts that report as a
 * fire-and-forget signal (`agent.ts`: `void agent.reportPlayout(item)`), so in principle it can
 * land *after* the borrower's "yes" has already been processed, and the guard would repeat a
 * read-back that was in fact heard. Measured over every voice call in the local ledger, the report
 * precedes the `record_promise_to_pay` on 122 of 122 — the ordering ADR 0008 observed on eight
 * instrumented runs, counted rather than sampled. The cost when it does lose the race is one
 * repeated read-back, not a wrong record, which is the direction this guard is supposed to fail
 * in. Closing it properly is issue #1's D1 `held`: a turn arriving against an unreported
 * non-interruptible segment waits for the segment's playout instead of judging without it.
 */
type ReadBackVerdict = "heard" | "interrupted" | "unconfirmed";

const readBackVerdict = (events: ReadonlyArray<EventRecord>, readBackTurnId: string | null, channel: string): ReadBackVerdict => {
  // A proposal carrying no read-back turn id has no evidence by construction, not by accident.
  const reported = (pred: (p: { readonly interrupted: boolean; readonly heard_text: string }) => boolean) =>
    readBackTurnId !== null && events.some((e) => e.type === "AGENT_TURN_PLAYOUT" && e.payload.turn_id === readBackTurnId && pred(e.payload));
  if (reported((p) => p.interrupted)) return "interrupted";
  // Heard-in-full needs text: an empty `heard_text` is the silent-playout shape, not evidence.
  if (reported((p) => p.heard_text.trim().length > 0)) return "heard";
  return channel === "voice" ? "unconfirmed" : "heard";
};

const unheardDetail = (v: ReadBackVerdict): string => (v === "interrupted" ? READBACK_INTERRUPTED_DETAIL : READBACK_UNCONFIRMED_DETAIL);

/**
 * How long a re-send of a still-running turn waits for the copy that holds it (C5), and how often it
 * looks. Ten seconds is longer than any turn this system has measured — the whole waterfall is
 * ~2.4 s at p50 and `ttft_ms` has been seen at 4.6 s — and short enough that a borrower is not left
 * on a silent line by a wedged one.
 */
const SAME_TURN_ATTACH_MS = 10_000;
const SAME_TURN_ATTACH_POLL_MS = 100;

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

        /**
         * Outcome-driven next actions (SPEC §14.2), except for a call that has no leg to re-dial
         * (C4).
         *
         * A scheduled `RETRY_CALL` is dispatched in `sip` mode — outbound, by definition, since
         * there is no browser tab waiting on the other end of it. So a call that only ever existed
         * *as* a browser tab cannot be its own retry: there is no number that would reach that
         * borrower again, and every attempt would end the way the ones this fix was written for
         * did, with the worker hanging up and the failure scheduling another attempt. Every call
         * the load harness places is one of these.
         *
         * `origin` is null on rows written before migration 0008, and null is treated as "not known
         * to be browser-originated" — today's behaviour, preserved, rather than an origin invented
         * for calls this database cannot speak for.
         */
        const noLegToRedial = row.channel === "voice" && row.origin === "browser";
        if (noLegToRedial && (outcome === "NO_ANSWER" || outcome === "THIRD_PARTY_CONTACT" || outcome === "FAILED")) {
          yield* Effect.logDebug("no re-dial scheduled: the call was browser-originated and has no outbound leg").pipe(
            Effect.annotateLogs({ conversation_id: row.id, outcome }),
          );
        }
        if (!noLegToRedial && (outcome === "NO_ANSWER" || outcome === "THIRD_PARTY_CONTACT" || outcome === "FAILED")) {
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
            /**
             * **The one line the borrower may not talk over** (issue #1, D1 — Phase 2).
             *
             * The fully-heard guard refuses to record a promise whose read-back nothing says was
             * heard in full (C1), so a "yes" spoken over it commits a turn that is then refused and
             * the read-back plays again — eight seconds of it, on the turn the borrower was most
             * ready to agree on. Tier 3's `yes-during-read-back` counted exactly two read-backs on
             * every green run.
             *
             * Marking it non-interruptible is what lets `held` (F2) park that turn until the segment
             * finishes, so the "yes" is answered once. The worker keeps
             * `discardAudioIfUninterruptible: false` (Q4), so the borrower's words still reach the
             * ledger — `held` is a control-plane decision about *when* to process them, never an
             * audio discard.
             */
            says.push({ text: promiseReadback({ amount: proposal.amount, date: proposal.date }), allowInterruptions: false });
            result = { amount: proposal.amount, date: proposal.date };
            break;
          }
          case "record_promise_to_pay": {
            const proposal = row.pendingProposal;
            const verdict = proposal ? readBackVerdict(params.events, proposal.read_back_turn_id, row.channel) : "unconfirmed";
            if (!proposal || verdict !== "heard") {
              rejected = { reason: "INVALID_ARGS", detail: proposal ? unheardDetail(verdict) : NO_PENDING_PROPOSAL_DETAIL };
              yield* append(row.id, { type: "TOOL_REJECTED", payload: { name: call.name, tool_call_id: toolCallId, state, reason: rejected.reason, detail: rejected.detail } }, at);
              if (proposal) {
                // Repeat the read-back and re-arm the guard for this turn.
                pendingProposal = { ...proposal, read_back_turn_id: params.turnId };
                yield* conv.updateConversation(row.id, { pendingProposal });
                // The repeat is the same line and carries the same rule.
                says.push({ text: `Let me repeat that. ${promiseReadback({ amount: proposal.amount, date: proposal.date })}`, allowInterruptions: false });
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
        const runT1 = sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lockOrFail(params.conversationId);
            // Idempotency first: the same turn_id again (retry / reconnect) replays the recorded
            // result even if that turn completed the conversation.
            const existing = yield* conv.findTurn({ conversationId: row.id, turnId: params.turnId });
            if (Option.isSome(existing) && existing.value.status === "DONE" && existing.value.result) {
              return { replay: existing.value.result as unknown as TurnResult, row, ctx: null, events: [] as ReadonlyArray<EventRecord>, attach: false as const };
            }
            /**
             * The same turn id, sent again while the first copy is still running (C5).
             *
             * This is a re-send after a reconnect, not a second turn: the guard below already treats
             * `activeTurnId === params.turnId` as "not a conflict", and `claimTurn` then refused it
             * anyway on `active_turn_id IS NULL`, so the caller got a `TurnInProgress` naming its
             * *own* turn as the blocker.
             *
             * It is **not** fixed by relaxing that predicate, which is the obvious change and the
             * wrong one: both copies would then pass T1, append a second `USER_TURN_FINAL` for the
             * borrower's line, decide twice and append a second `AGENT_TURN`. The tool is idempotent
             * by `tool_call_id` and would not fire twice, but the transcript would carry every line
             * of that turn twice, which is worse than the 409.
             *
             * So the re-send attaches instead: it waits for the copy that is running to finish and
             * replays its recorded result, which is the same answer the `DONE` branch above gives a
             * reconnect that arrives a moment later. `TurnRunner` already does this in-process for
             * up to `TURN_MAX_LIFETIME_SECONDS`; this is the same promise kept in the database, so it
             * survives that window and a second replica.
             */
            /**
             * A turn that was superseded is over, and re-sending it does not restart it (C9).
             *
             * Idempotency replayed only `DONE`, so a `SUPERSEDED` row fell through to the claim —
             * and by then the barge-in that superseded it has released `active_turn_id`, so the
             * claim succeeds and the turn runs again: a second `USER_TURN_FINAL` for a line the
             * ledger already holds, and a fresh reply decided against a conversation that has moved
             * on. Half-executed, because `TURN_SUPERSEDED` is already in the log above it.
             *
             * The retry fails explicitly instead. It is a conflict, like `TurnInProgress`, and a
             * different one: not "somebody holds the line now" but "this turn is over".
             */
            if (Option.isSome(existing) && existing.value.status === "SUPERSEDED") {
              return yield* Effect.fail(new TurnSuperseded({ conversationId: row.id, turnId: params.turnId }));
            }
            if (Option.isSome(existing) && existing.value.status === "RUNNING" && row.activeTurnId === params.turnId) {
              return { replay: null, row, ctx: null, events: [] as ReadonlyArray<EventRecord>, attach: true as const };
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
            return { replay: null, row, ctx, events, attach: false as const };
          }),
        );

        /**
         * T1, retried while a copy of this same turn is still running (C5).
         *
         * Bounded, because the alternative to waiting is not "wait longer" but "answer wrongly":
         * if the copy that holds the turn is wedged or its process is gone, the honest answer is the
         * `TurnInProgress` this used to give immediately, and the caller can supersede. The bound is
         * generous against a turn — a slow decide is a second or two, and `ttft_ms` has been seen at
         * 4.6 s (ADR 0008) — and short against a borrower, who is on the phone.
         */
        let t1 = yield* runT1;
        for (let waited = 0; t1.attach && waited < SAME_TURN_ATTACH_MS; waited += SAME_TURN_ATTACH_POLL_MS) {
          yield* Effect.sleep(Duration.millis(SAME_TURN_ATTACH_POLL_MS));
          t1 = yield* runT1;
        }
        if (t1.attach) {
          // Still running after the bound: the copy holding it is wedged or its process is gone.
          return yield* Effect.fail(new TurnInProgress({ conversationId: t1.row.id, activeTurnId: params.turnId }));
        }

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

        /* ---------- wait (no tx, no decider) ---------- */
        /**
         * The borrower asked for a moment (issue #1, D1's `wait`).
         *
         * The decider is not consulted: a hold is a lexicon decision, not a model one (Q3). T1 has
         * already appended the borrower's line, because the ledger is the truth about what was said
         * (Q4) — the control plane simply declines to answer and asks the worker for more away time,
         * so the silence the borrower asked for does not trip a no-input strike.
         *
         * **A second consecutive hold is answered.** Otherwise a borrower could park the call
         * indefinitely, one "one second" at a time, and the away timer would keep extending.
         */
        if (holdRequest(params.userText) && (yield* conv.lastDisposition(row.id, params.turnId)) !== "wait") {
          const at = DateTime.toDateUtc(yield* DateTime.now);
          const waited: TurnResult = {
            turnId: params.turnId,
            decider: "none",
            disposition: "wait",
            resolution: "none",
            agentText: "",
            newState: state,
            toolCalled: null,
            callControlAction: null,
            outcome: null,
            endCall: false,
            degraded: false,
            ttftMs: null,
            extendAwayMs: WAIT_EXTEND_MS,
          };
          yield* conv.finishTurn({ conversationId: row.id, turnId: params.turnId, status: "DONE", result: waited as unknown as Record<string, unknown>, finishedAt: at });
          yield* conv.releaseTurn(row.id, params.turnId);
          yield* emit({
            type: "turn_end",
            turn_id: params.turnId,
            new_state: state,
            agent_text: "",
            tool_called: null,
            call_control_action: null,
            outcome: null,
            end_call: false,
            degraded: false,
            ttft_ms: null,
            extend_away_ms: WAIT_EXTEND_MS,
          });
          return waited;
        }

        /* ---------- decide (no tx) ---------- */
        const override = matchOverride(params.userText, { borrowerFirstName: ctx.borrowerFirstName });
        /**
         * One shape for every arm of the decide phase (F3).
         *
         * `decider` names the arm that produced the decision — the override that never reached a
         * model, the model itself, the scripted stand-in, and D2's fast path when it lands. It is
         * not `conversations.decider`, which names the service configured for the whole call and so
         * reads the same on all of them.
         */
        let decisionResult: { decision: TurnDecision | null; decider: TurnDecisionSource; streamedText: string; degraded: string | null; ttftMs: number | null } = {
          decision: null,
          // An override answered without consulting anything; the branch below overwrites this.
          decider: "override",
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
          decisionResult = { decision, decider: cfg.turnDecider === "scripted" ? "scripted" : "model", streamedText: streamed, degraded, ttftMs: ttft };
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
            let toolRejected = false;
            let unlockedThisTurn = false;
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
                // This turn unlocked protected context if the tool did, and the conversation was
                // locked when the turn started (issue #1, D3).
                if (r.unlocked && !locked.protectedContextUnlocked) unlockedThisTurn = true;
                if (r.rejected) {
                  degraded = true;
                  // Kept apart from `degraded` for the disposition: a tool the state machine refused
                  // is the system working, not the model failing (F3).
                  toolRejected = true;
                }
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

            /**
             * The model said goodbye and no tool recorded anything (C13).
             *
             * This used to be `FAILED`, which conflated "the call had no outcome" with "the system
             * broke" — and `FAILED` schedules a re-dial, so a borrower who was told goodbye politely
             * got called again for it, while the funnel counted the call as a failure.
             *
             * `NO_DISPOSITION` is a completed call with nothing to record. It does not retry:
             * nothing went wrong that trying again would fix.
             */
            if (outcome === null && nextState === "ENDING") outcome = "NO_DISPOSITION";

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

            /**
             * The recogniser is told what to expect on the turn that unlocks protected context, and
             * only that turn (issue #1, D3).
             *
             * Gated on the unlock itself rather than on the state, because that is the same gate the
             * prompt uses: a keyterm list carrying the borrower's name and balance is account data
             * leaving the system just as surely as a sentence is. `unlockedThisTurn` is set only
             * when the tool unlocked it **and** the conversation was locked when the turn started,
             * so the list goes out once — re-sending it would re-open the Deepgram websocket on
             * every turn of the call (`stt.js:284`).
             */
            const bias =
              unlockedThisTurn
                ? biasTermsFor(
                    {
                      borrowerName: ctx.bundle.protectedContext?.borrower_full_name ?? "",
                      creditorName: cfg.companyName,
                      balanceDue: ctx.bundle.protectedContext?.balance_due ?? null,
                      dueDate: ctx.bundle.protectedContext?.due_date ?? null,
                    },
                    { verified: true },
                  )
                : null;

            const result: TurnResult = {
              turnId: params.turnId,
              decider: decisionResult.decider,
              ...(params.heldMs === undefined ? {} : { heldMs: params.heldMs }),
              /**
               * Assembled once, here, from what the four branches above already knew. `rejected`
               * sets `degraded`, so a rejection reads as `rejected` rather than being lost inside a
               * boolean that also means "the model failed".
               */
              resolution: toolRejected ? "rejected" : degraded ? "degraded" : toolCalled !== null ? "tool" : "spoke",
              disposition: params.heldMs === undefined ? "respond" : "held",
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
            // `bias` rides out of the transaction rather than into `TurnResult`: it is a wire
            // concern for the worker's recogniser, not state the ledger should keep.
            return { result, says, bias };
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
          return {
            turnId: params.turnId,
            decider: decisionResult.decider,
            disposition: params.heldMs === undefined ? "respond" : "held",
            resolution: "superseded",
            agentText: decisionResult.streamedText,
            newState: state,
            toolCalled: null,
            callControlAction: null,
            outcome: null,
            endCall: false,
            degraded: false,
            ttftMs: decisionResult.ttftMs,
          } satisfies TurnResult;
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
          ...(t2.bias === null
            ? {}
            : {
                bias_terms: {
                  keyterms: t2.bias.keyterms,
                  // Pre-joined into the `word:boost` shape the plugin sends (`stt.js:89`), so the
                  // worker passes them through instead of re-deriving the format.
                  keywords: t2.bias.keywords.map(([w, b]) => `${w}:${String(b)}`),
                  numerals: t2.bias.numerals,
                },
              }),
        });
        return r;
      }).pipe(
        /**
         * Every log line this turn produces names the call and the turn it came from (D3). A
         * server under load interleaves the lines of N calls, and before this the only way to
         * attribute a `turn failed` was the timestamp — which is exactly the case where timestamps
         * collide. The annotation is on the whole effect rather than each call site so that a log
         * line added later is joinable without anyone remembering to do it.
         */
        Effect.annotateLogs({ conversation_id: params.conversationId, turn_id: params.turnId }),
      );

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
            return { turnId: `no-input-${strike}`, decider: "none", disposition: "respond", resolution: "none", agentText: text, newState: "COMPLETED", toolCalled: null, callControlAction: { action: "NO_INPUT_CLOSE", action_id: logged.action_id }, outcome: "NO_ANSWER", endCall: true, degraded: false, ttftMs: null } satisfies TurnResult;
          }
          yield* append(row.id, { type: "AGENT_TURN", payload: { text, state: row.currentState, speak_mode: "interruptible" } }, at);
          return { turnId: `no-input-${strike}`, decider: "none", disposition: "respond", resolution: "none", agentText: text, newState: row.currentState, toolCalled: null, callControlAction: null, outcome: null, endCall: false, degraded: false, ttftMs: null } satisfies TurnResult;
        }),
      ).pipe(Effect.tap(finalizeTracingIfEnded(conversationId)), Effect.annotateLogs({ conversation_id: conversationId, path: "no_input" }));

    /* ---------------------------- processSignal ---------------------------- */

    /**
     * `turn_metrics` is pure telemetry and takes neither the row lock nor the ledger (C7).
     *
     * It merges one idempotent patch into the `conversation_turns` row that already holds `ttft_ms`,
     * and hands the same numbers to the tracer, which has been holding this turn's span open waiting
     * for exactly them. Neither needs the conversation row and neither needs the event log.
     *
     * It used to take both, because `processSignal` locked and called `listEvents` before looking at
     * what kind of signal it had. The worker posts this a few hundred milliseconds after a turn's
     * audio finishes — which on a barge-in is exactly when the *next* turn's T1 holds that lock — so
     * telemetry waited on the live path and held a pool connection while it waited.
     *
     * The conversation is still read, so a signal for an id that does not exist is still a 404; it
     * is read without `FOR UPDATE`. No transaction, because there is one statement to run.
     */
    const recordTurnMetrics = (conversationId: string, signal: Extract<Signal, { kind: "turn_metrics" }>) =>
      Effect.gen(function* () {
        const row = yield* conv.findConversation(conversationId).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "conversation", id: conversationId })), onSome: Effect.succeed })),
        );
        const latency = {
          eou_delay_ms: signal.eouDelayMs ?? null,
          transcription_delay_ms: signal.transcriptionDelayMs ?? null,
          tts_ttfb_ms: signal.ttsTtfbMs ?? null,
        };
        // TTS shape lands in the same row but is not part of the latency waterfall: it is the input
        // to the chars-per-second heuristic (D5), not a component of reply time.
        const ttsShape = {
          /**
           * D1's `resume`. Kept as the list rather than a count, because the gate is a **p50 of the
           * pause durations** ("resume p50 < 300 ms") and a count cannot answer that.
           */
          ...(signal.resumedMs !== undefined && signal.resumedMs.length > 0 ? { resumed_ms: [...signal.resumedMs] } : {}),
          ...(signal.ttsAudioMs !== undefined ? { tts_audio_ms: signal.ttsAudioMs } : {}),
          ...(signal.ttsChars !== undefined ? { tts_chars: signal.ttsChars } : {}),
        };
        yield* conv.mergeTurnResult({ conversationId: row.id, turnId: signal.turnId, patch: { ...latency, ...ttsShape } });
        yield* tracing.turnLatency(row.id, signal.turnId, {
          eouDelayMs: latency.eou_delay_ms,
          transcriptionDelayMs: latency.transcription_delay_ms,
          ttsTtfbMs: latency.tts_ttfb_ms,
        });
        // Annotated rather than `satisfies`: `satisfies` keeps `decider: "none"` a literal type, and
        // the two branches of `processSignal` then have no common supertype (F3).
        const done: TurnResult = {
          turnId: `signal-${signal.kind}`,
          // A metrics signal decided nothing; it reports on a turn that was decided elsewhere (F3).
          decider: "none",
          disposition: "respond",
          resolution: "none",
          agentText: "",
          newState: row.currentState,
          toolCalled: null,
          callControlAction: null,
          outcome: null,
          endCall: false,
          degraded: false,
          ttftMs: null,
        };
        return done;
      });

    /**
     * The `held` phase's read, exposed for `TurnRunner` (issue #1 D1, F2).
     *
     * On the orchestrator rather than reached for directly from `TurnRunner`, so the runner keeps
     * the dependency set it had — its unit tests drive a fake orchestrator and must not need a
     * database to check turn retention — and so the one caller sees conversation orchestration
     * through one interface. The read itself takes no lock and joins no transaction; see the repo.
     */
    const unreportedNonInterruptible = (conversationId: string) => conv.unreportedNonInterruptible(conversationId);

    const processSignal = (conversationId: string, signal: Signal) =>
      /**
       * The tap below covers **both** branches, and has to: on a voice call `turn_metrics` is the
       * signal that finalizes the trace. `processTurn` deliberately does not finalize a voice call
       * when the turn ends, because the EOU/STT/TTS numbers are still a few hundred milliseconds
       * away, so publishing there would export the last turn with half its waterfall missing.
       */
      (signal.kind === "turn_metrics"
        ? recordTurnMetrics(conversationId, signal)
        : sql.withTransaction(
        Effect.gen(function* () {
          const at = DateTime.toDateUtc(yield* DateTime.now);
          const row = yield* lockOrFail(conversationId);
          const events = yield* conv.listEvents(row.id);
          const done = (r: Partial<TurnResult> & { agentText: string; newState: ConversationState }): TurnResult => ({
            turnId: `signal-${signal.kind}`,
            // A signal is not a decided turn; saying so keeps it out of the turn-level SLO predicate
            // rather than relying on a rule someone has to remember (F3, F4).
            decider: "none",
            disposition: "respond",
            resolution: "none",
            toolCalled: null,
            callControlAction: null,
            outcome: null,
            endCall: false,
            degraded: false,
            ttftMs: null,
            ...r,
          });

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
          // A hangup normally means the borrower or the provider ended the call, and an unverified
          // one is a NO_ANSWER. The sweeper's two reasons are different: nobody ended anything.
          // Either the worker died mid-call (ORPHANED) or no worker ever claimed it (NEVER_SERVED,
          // O4). Both are system failures, and calling either NO_ANSWER would schedule a polite
          // retry for one — which is how the never-served case stayed invisible: it looked like a
          // borrower who did not pick up (spec 2026-08-26, D6).
          const sweptByUs = signal.reason === ORPHANED_REASON || signal.reason === NEVER_SERVED_REASON;
          const outcome: Outcome = sweptByUs || row.protectedContextUnlocked ? "FAILED" : "NO_ANSWER";
          yield* finalize({ row, ctx, currentState: row.currentState, outcome, metadata: { reason: signal.reason ?? "hangup" }, at });
          return done({ agentText: "", newState: "COMPLETED", callControlAction: { action: "HANGUP", action_id: logged.action_id }, outcome, endCall: true });
        }),
      )).pipe(Effect.tap(finalizeTracingIfEnded(conversationId)), Effect.annotateLogs({ conversation_id: conversationId, path: `signal:${signal.kind}` }));

    /**
     * Let go of a turn this process claimed and will not finish (C10).
     *
     * Called only from `TurnRunner`'s shutdown finalizer, and only for turns still in flight after
     * the drain. It is the orchestrator's to do rather than the HTTP layer's for the reason ADR 0001
     * gives: the conversation's state belongs here, and `TurnRunner` is plumbing. The CAS in
     * `releaseTurn` means a turn that finished in the meantime is untouched.
     */
    const releaseStrandedTurn = (conversationId: string, turnId: string): Effect.Effect<void> =>
      // Errors are swallowed on purpose: this runs inside a shutdown finalizer, and a database that
      // is already going away must not turn a clean stop into a failed one. The row it would have
      // cleared is no worse off than it was before this existed.
      conv.releaseTurn(conversationId, turnId).pipe(Effect.ignore);

    return { processTurn, processNoInput, processSignal, unreportedNonInterruptible, releaseStrandedTurn } as const;
  }),
  dependencies: [ConversationRepo.Default, CrmRepo.Default, IdGen.Default, ContextBuilder.Default, CallControl.Default, SchedulingService.Default, OutboxService.Default],
}) {}
