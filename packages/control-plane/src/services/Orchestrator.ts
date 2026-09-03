/**
 * The conversation orchestrator: the state machine enforces, the model converses. A turn is
 *
 *   held    wait out a non-interruptible segment the worker has not yet reported played
 *   T1 (tx) lock, reject completed / concurrent, CAS active_turn_id, append USER_TURN_FINAL
 *   wait    the borrower asked for a moment: no reply, size the silence window, done
 *   decide  no tx; deterministic overrides first, else the TurnDecider streams deltas
 *   T2 (tx) verify still active, validate transition + tool, execute, append, finalize, release
 *   emit    `say` segments and `turn_end`, only after commit
 *
 * `processSignal` and `processNoInput` are single-transaction paths on the same ledger.
 */
import { DateTime, Duration, Effect, Either, Option, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import type {
  CallControlAction,
  ConversationState,
  EventRecord,
  Outcome,
  PendingProposal,
  ToolCall,
  ToolName,
  TurnDecision,
} from "@feather-lite/domain";
import {
  buildTranscript,
  disputeClose,
  forcedTransition,
  hardshipClose,
  holdForTransfer,
  matchOverride,
  noInputPrompt,
  NEVER_SERVED_REASON,
  ORPHANED_REASON,
  biasTermsFor,
  holdRequest,
  overrideTransition,
  POLICY,
  replay,
  safeFallback,
  toolsForState,
  transition,
  triggerFor,
  visibleContext,
  voicemailScript,
  waitWindowMs,
  NUDGE_WINDOW_MS,
  SILENCE_WINDOW_MS,
} from "@feather-lite/domain";
import type { TurnFrame } from "@feather-lite/contracts";
import { AppConfig } from "../config.js";
import { ConversationCompleted, NotFound, TurnInProgress, TurnSuperseded } from "../errors.js";
import type { PendingProposalJson } from "../db/rows.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import { CallControl } from "./CallControl.js";
import { ContextBuilder, type ConversationContext } from "./ContextBuilder.js";
import { IdGen } from "./Ids.js";
import { OutboxService } from "./Outbox.js";
import { SchedulingService } from "./Scheduling.js";
import { Tracing } from "./Tracing.js";
import { ToolExecutor, type SaySegment } from "./ToolExecutor.js";
import { CallFinalizer } from "./CallFinalizer.js";
import { TurnDecider } from "./TurnDecider.js";
import type { DeciderInput, TurnDecisionSource, TurnResult } from "./types.js";

export interface TurnParams {
  readonly conversationId: string;
  readonly turnId: string;
  readonly userText: string;
  readonly playout?: { readonly turnId: string; readonly heardText: string; readonly interrupted: boolean } | undefined;
  readonly supersede?: boolean | undefined;
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
      readonly resumedMs?: ReadonlyArray<number> | undefined;
    };

export type Emit = (frame: TurnFrame) => Effect.Effect<void>;

/** Ten seconds: longer than any turn measured here, short of leaving a borrower on a silent line. */
const SAME_TURN_ATTACH_MS = 10_000;
const SAME_TURN_ATTACH_POLL_MS = 100;

const toDomainProposal = (p: PendingProposalJson | null): PendingProposal | null =>
  p === null
    ? null
    : { kind: "PROMISE_TO_PAY", amount: p.amount as never, date: p.date as never, proposedAtSeq: p.proposed_at_seq, readBackAtSeq: null };

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
    const tools = yield* ToolExecutor;
    const finalizer = yield* CallFinalizer;

    const append = (conversationId: string, event: EventRecord extends infer _ ? Parameters<typeof conv.appendEvent>[0]["event"] : never, at: Date) =>
      Effect.gen(function* () {
        return yield* conv.appendEvent({ id: yield* ids.next(), conversationId, event, createdAt: at });
      });

    const lockOrFail = (conversationId: string) =>
      conv.lockConversation(conversationId).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(new NotFound({ entity: "conversation", id: conversationId })), onSome: Effect.succeed })),
      );

    const processTurn = (params: TurnParams, emit: Emit) =>
      Effect.gen(function* () {
        const startedAt = yield* DateTime.now;
        const startedMs = DateTime.toEpochMillis(startedAt);
        /**
         * Wall clock, deliberately separate from `startedAt`, which comes from the Effect clock the
         * VirtualClock shifts for seeded history. The two must never be subtracted from one another.
         */
        const wallStartedMs = Date.now();
        const nowDate = DateTime.toDateUtc(startedAt);

        const runT1 = sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* lockOrFail(params.conversationId);
            const existing = yield* conv.findTurn({ conversationId: row.id, turnId: params.turnId });
            if (Option.isSome(existing) && existing.value.status === "DONE" && existing.value.result) {
              return { replay: existing.value.result as unknown as TurnResult, row, ctx: null, events: [] as ReadonlyArray<EventRecord>, attach: false as const };
            }
            // A re-send of a still-running turn attaches and replays instead of relaxing the claim
            // predicate, which would append the borrower's line and a reply twice. A SUPERSEDED turn
            // is over, so it fails explicitly rather than falling through to the claim and re-running.
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
            // The strikes are consecutive, which is what `POLICY.noInputStrikes` counts: a borrower
            // who answers has not gone away, and a cumulative count would close the call on the
            // first pause after any earlier nudge.
            if (row.noInputCount > 0) yield* conv.updateConversation(row.id, { noInputCount: 0 });
            const ctx = yield* ctxBuilder.forConversation(row, startedAt);
            const events = yield* conv.listEvents(row.id);
            return { replay: null, row, ctx, events, attach: false as const };
          }),
        );

        let t1 = yield* runT1;
        for (let waited = 0; t1.attach && waited < SAME_TURN_ATTACH_MS; waited += SAME_TURN_ATTACH_POLL_MS) {
          yield* Effect.sleep(Duration.millis(SAME_TURN_ATTACH_POLL_MS));
          t1 = yield* runT1;
        }
        if (t1.attach) {
          return yield* Effect.fail(new TurnInProgress({ conversationId: t1.row.id, activeTurnId: params.turnId }));
        }

        if (t1.replay) {
          const r = t1.replay;
          yield* emit({ type: "turn_start", turn_id: params.turnId, state: t1.row.currentState });
          yield* emit({ type: "turn_end", turn_id: params.turnId, new_state: r.newState, agent_text: r.agentText, tool_called: r.toolCalled ? { name: r.toolCalled.name, args: r.toolCalled.args } : null, call_control_action: r.callControlAction, outcome: r.outcome, end_call: r.endCall, degraded: r.degraded, ttft_ms: r.ttftMs, extend_away_ms: r.extendAwayMs ?? SILENCE_WINDOW_MS });
          return r;
        }
        const row = t1.row;
        const ctx = t1.ctx as ConversationContext;
        const state = row.currentState;
        yield* emit({ type: "turn_start", turn_id: params.turnId, state });

        // A second consecutive hold is answered, or a borrower could park the call indefinitely one
        // "one second" at a time, each buying a fresh silence window.
        const hold = holdRequest(params.userText);
        if (hold !== null && (yield* conv.lastDisposition(row.id, params.turnId)) !== "wait") {
          const at = DateTime.toDateUtc(yield* DateTime.now);
          const waitMs = waitWindowMs(hold.kind);
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
            extendAwayMs: waitMs,
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
            extend_away_ms: waitMs,
          });
          return waited;
        }

        const override = matchOverride(params.userText, { borrowerFirstName: ctx.borrowerFirstName });
        let decisionResult: { decision: TurnDecision | null; decider: TurnDecisionSource; streamedText: string; degraded: string | null; ttftMs: number | null } = {
          decision: null,
          decider: "override",
          streamedText: "",
          degraded: null,
          ttftMs: null,
        };

        if (Option.isNone(override)) {
          const visible = visibleContext(ctx.bundle, state, row.protectedContextUnlocked);
          const transcript = buildTranscript(t1.events, { excludeSuperseded: true })
            .slice(-100)
            .map((e) => ({ speaker: e.speaker, text: e.text }));
          const snapshot = replay(t1.events);
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

        const t2 = yield* sql.withTransaction(
          Effect.gen(function* () {
            const at = DateTime.toDateUtc(yield* DateTime.now);
            const locked = yield* lockOrFail(row.id);
            if (locked.activeTurnId !== params.turnId) {
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
                  const r = yield* tools.execute({ row: locked, ctx, events, state: "OPT_OUT", call, turnId: params.turnId, at });
                  toolCalled = call;
                  says.push(...r.says);
                  outcome = r.outcome;
                  metadata = r.metadata;
                  break;
                }
                case "WRONG_NUMBER": {
                  const call: ToolCall = { name: "record_wrong_party_contact", args: { outcome_type: "WRONG_NUMBER", notes: "override: wrong number" } };
                  const r = yield* tools.execute({ row: { ...locked, currentState: "WRONG_NUMBER" }, ctx, events, state: "WRONG_NUMBER", call, turnId: params.turnId, at });
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
              degraded = true;
              yield* append(row.id, { type: "TURN_DECISION_REJECTED", payload: { state: locked.currentState, reason: decisionResult.degraded?.startsWith("TurnDeciderUnavailable") ? "DECIDER_UNAVAILABLE" : "INVALID_OUTPUT", detail: decisionResult.degraded ?? "unknown" } }, at);
              if (agentText.trim().length === 0) says.push({ text: safeFallback(), allowInterruptions: true });
            } else {
              const d = decisionResult.decision;
              const moved = d.toolCall !== null ? Either.right(locked.currentState) : transition(locked.currentState, d.suggestedNextState);
              if (Either.isLeft(moved)) {
                degraded = true;
                yield* append(row.id, { type: "TURN_DECISION_REJECTED", payload: { state: locked.currentState, reason: "INVALID_TRANSITION", detail: moved.left.message, suggested_next_state: String(d.suggestedNextState) } }, at);
              }
              if (d.toolCall !== null) {
                const r = yield* tools.execute({ row: locked, ctx, events, state: locked.currentState, call: d.toolCall, turnId: params.turnId, at });
                toolCalled = d.toolCall;
                says.push(...r.says);
                outcome = r.outcome;
                metadata = r.metadata;
                nextState = r.nextState;
                if (r.unlocked && !locked.protectedContextUnlocked) unlockedThisTurn = true;
                if (r.rejected) {
                  degraded = true;
                  toolRejected = true;
                }
                if (r.executed && r.result && agentText.length === 0 && d.message.length > 0 && !r.says.length) agentText = d.message;
              } else if (Either.isRight(moved) && moved.right !== locked.currentState) {
                if (moved.right === "WARM_TRANSFER_PENDING") {
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
                    if (agentText.trim().length === 0) agentText = d.message;
                  }
                }
              }
              if (agentText.trim().length === 0 && says.length === 0) {
                agentText = d.message.trim().length > 0 ? d.message : safeFallback();
              }
            }

            // NO_DISPOSITION rather than FAILED: FAILED schedules a re-dial, so a borrower who was
            // told goodbye politely would be called again for it.
            if (outcome === null && nextState === "ENDING") outcome = "NO_DISPOSITION";

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

            let endCall = false;
            if (outcome !== null) {
              yield* finalizer.finalize({ row: locked, ctx, currentState: nextState, outcome, metadata, at });
              nextState = "COMPLETED";
              endCall = true;
            }

            /**
             * Gated on the unlock, not the state: the list carries the borrower's name and balance.
             * It goes out once, because re-sending re-opens the Deepgram websocket every turn.
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
        // A voice call's last EOU/STT/TTS numbers arrive later as a `turn_metrics` signal, so
        // emitting here would publish half a waterfall.
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
          extend_away_ms: r.extendAwayMs ?? SILENCE_WINDOW_MS,
          ...(t2.bias === null
            ? {}
            : {
                bias_terms: {
                  keyterms: t2.bias.keyterms,
                  keywords: t2.bias.keywords.map(([w, b]) => `${w}:${String(b)}`),
                  numerals: t2.bias.numerals,
                },
              }),
        });
        return r;
      }).pipe(
        Effect.annotateLogs({ conversation_id: params.conversationId, turn_id: params.turnId }),
      );

    /**
     * Every path that ends a call must release the turns the tracer is still holding, or they stay
     * buffered until the process exits and the trace is never written.
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
            yield* finalizer.finalize({ row, ctx, currentState: row.currentState, outcome: "NO_ANSWER", metadata: { reason: "no_input_timeout" }, at });
            return { turnId: `no-input-${strike}`, decider: "none", disposition: "respond", resolution: "none", agentText: text, newState: "COMPLETED", toolCalled: null, callControlAction: { action: "NO_INPUT_CLOSE", action_id: logged.action_id }, outcome: "NO_ANSWER", endCall: true, degraded: false, ttftMs: null } satisfies TurnResult;
          }
          yield* append(row.id, { type: "AGENT_TURN", payload: { text, state: row.currentState, speak_mode: "interruptible" } }, at);
          // The nudge carries the deadline for its own answer: the worker's clock is armed from this
          // and nothing else, so without it the strike that closes the attempt would never come.
          return { turnId: `no-input-${strike}`, decider: "none", disposition: "respond", resolution: "none", agentText: text, newState: row.currentState, toolCalled: null, callControlAction: null, outcome: null, endCall: false, degraded: false, ttftMs: null, extendAwayMs: NUDGE_WINDOW_MS } satisfies TurnResult;
        }),
      ).pipe(Effect.tap(finalizeTracingIfEnded(conversationId)), Effect.annotateLogs({ conversation_id: conversationId, path: "no_input" }));

    /**
     * Pure telemetry: no row lock, no ledger, no transaction. The worker posts this a few hundred
     * milliseconds after a turn's audio finishes, which on a barge-in is exactly when the next
     * turn's T1 holds that lock, so taking it would put telemetry on the live path.
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
        const ttsShape = {
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
        const done: TurnResult = {
          turnId: `signal-${signal.kind}`,
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

    const unreportedNonInterruptible = (conversationId: string) => conv.unreportedNonInterruptible(conversationId);

    const processSignal = (conversationId: string, signal: Signal) =>
      (signal.kind === "turn_metrics"
        ? recordTurnMetrics(conversationId, signal)
        : sql.withTransaction(
        Effect.gen(function* () {
          const at = DateTime.toDateUtc(yield* DateTime.now);
          const row = yield* lockOrFail(conversationId);
          const events = yield* conv.listEvents(row.id);
          const done = (r: Partial<TurnResult> & { agentText: string; newState: ConversationState }): TurnResult => ({
            turnId: `signal-${signal.kind}`,
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
              yield* finalizer.finalize({ row, ctx, currentState: "VOICEMAIL", outcome: "VOICEMAIL_LEFT", metadata: { amd: result }, at });
              return done({ agentText: text, newState: "COMPLETED", callControlAction: { action: "VOICEMAIL_DROP", action_id: logged.action_id }, outcome: "VOICEMAIL_LEFT", endCall: true });
            }
            if (result === "NO_ANSWER") {
              const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "NO_ANSWER", actionId: signal.actionId ?? null, now: at });
              yield* finalizer.finalize({ row, ctx, currentState: row.currentState, outcome: "NO_ANSWER", metadata: { amd: result }, at });
              return done({ agentText: "", newState: "COMPLETED", callControlAction: { action: "NO_ANSWER", action_id: logged.action_id }, outcome: "NO_ANSWER", endCall: true });
            }
            yield* conv.setAttemptStatus(row.callAttemptId, "ANSWERED", null);
            return done({ agentText: "", newState: row.currentState });
          }
          if (signal.kind === "no_answer") {
            const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "NO_ANSWER", actionId: signal.actionId ?? null, now: at });
            yield* finalizer.finalize({ row, ctx, currentState: row.currentState, outcome: "NO_ANSWER", metadata: { reason: "no_answer" }, at });
            return done({ agentText: "", newState: "COMPLETED", callControlAction: { action: "NO_ANSWER", action_id: logged.action_id }, outcome: "NO_ANSWER", endCall: true });
          }
          const logged = yield* callControl.logAction({ conversationId: row.id, events, action: "HANGUP", actionId: signal.actionId ?? null, payload: { reason: signal.reason ?? "participant_disconnected" }, now: at });
          // The sweeper's two reasons are not NO_ANSWER: nobody ended anything, the worker died
          // mid-call or never claimed it. Calling either NO_ANSWER would schedule a polite retry.
          const sweptByUs = signal.reason === ORPHANED_REASON || signal.reason === NEVER_SERVED_REASON;
          const outcome: Outcome = sweptByUs || row.protectedContextUnlocked ? "FAILED" : "NO_ANSWER";
          yield* finalizer.finalize({ row, ctx, currentState: row.currentState, outcome, metadata: { reason: signal.reason ?? "hangup" }, at });
          return done({ agentText: "", newState: "COMPLETED", callControlAction: { action: "HANGUP", action_id: logged.action_id }, outcome, endCall: true });
        }),
      )).pipe(Effect.tap(finalizeTracingIfEnded(conversationId)), Effect.annotateLogs({ conversation_id: conversationId, path: `signal:${signal.kind}` }));

    const releaseStrandedTurn = (conversationId: string, turnId: string): Effect.Effect<void> =>
      // Errors are swallowed on purpose: this runs inside a shutdown finalizer, and a database that
      // is already going away must not turn a clean stop into a failed one.
      conv.releaseTurn(conversationId, turnId).pipe(Effect.ignore);

    return { processTurn, processNoInput, processSignal, unreportedNonInterruptible, releaseStrandedTurn } as const;
  }),
  dependencies: [ConversationRepo.Default, CrmRepo.Default, IdGen.Default, ContextBuilder.Default, CallControl.Default, SchedulingService.Default, OutboxService.Default, ToolExecutor.Default, CallFinalizer.Default],
}) {}
