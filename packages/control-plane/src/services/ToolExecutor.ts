import { Effect, Either, Option } from "effect";
import type { ConversationState, EventRecord, Outcome, ToolCall } from "@feather-lite/domain";
import {
  callbackScheduledConfirmation,
  NO_PENDING_PROPOSAL_DETAIL,
  optOutConfirmation,
  playoutMatchesSegment,
  promiseReadback,
  promiseRecordedConfirmation,
  READBACK_INTERRUPTED_DETAIL,
  READBACK_UNCONFIRMED_DETAIL,
  replay,
  spokenIsoDate,
  spokenMoney,
  thirdPartyClose,
  triggerFor,
  validateToolCall,
  wrongNumberClose,
} from "@feather-lite/domain";
import type { ConversationRow, PendingProposalJson } from "../db/rows.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import type { ConversationContext } from "./ContextBuilder.js";
import { IdGen } from "./Ids.js";
import { SchedulingService } from "./Scheduling.js";

export interface SaySegment {
  /** Minted here, carried on the `say` frame, and reported back on this segment's playout. */
  readonly segmentId: string;
  readonly text: string;
  readonly allowInterruptions: boolean;
}

/**
 * On a voice call the guard requires a playout report that positively says the read-back was
 * heard; `simulated` keeps a vacuous pass, having no playout reporter. Residual risk: the report
 * is posted fire-and-forget, so losing that race costs one repeated read-back.
 */
type ReadBackVerdict = "heard" | "interrupted" | "unconfirmed";

/**
 * The read-back's own segment, not the turn's concatenated parts: a turn can speak several times and
 * only one of those segments is the read-back the borrower had to hear.
 */
const readBackVerdict = (events: ReadonlyArray<EventRecord>, readBack: { readonly segmentId: string; readonly turnId: string } | null, channel: string): ReadBackVerdict => {
  const reported = (pred: (p: { readonly interrupted: boolean; readonly heard_text: string }) => boolean) =>
    readBack !== null && events.some((e) => e.type === "AGENT_TURN_PLAYOUT" && playoutMatchesSegment(e.payload, readBack) && pred(e.payload));
  if (reported((p) => p.interrupted)) return "interrupted";
  if (reported((p) => p.heard_text.trim().length > 0)) return "heard";
  return channel === "voice" ? "unconfirmed" : "heard";
};

const unheardDetail = (v: ReadBackVerdict): string => (v === "interrupted" ? READBACK_INTERRUPTED_DETAIL : READBACK_UNCONFIRMED_DETAIL);

const derivedToolCallId = (turnId: string, call: ToolCall): string =>
  `${turnId}:${call.name}:${JSON.stringify(call.args)}`.slice(0, 200);

export class ToolExecutor extends Effect.Service<ToolExecutor>()("@feather-lite/ToolExecutor", {
  effect: Effect.gen(function* () {
    const conv = yield* ConversationRepo;
    const crm = yield* CrmRepo;
    const ids = yield* IdGen;
    const scheduling = yield* SchedulingService;

    const append = (conversationId: string, event: Parameters<typeof conv.appendEvent>[0]["event"], at: Date) =>
      Effect.gen(function* () {
        return yield* conv.appendEvent({ id: yield* ids.next(), conversationId, event, createdAt: at });
      });

    const execute = (params: {
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
              // Amounts and dates are read from the ledger, never generated by the model.
              const pc = ctx.bundle.protectedContext;
              says.push({
                segmentId: yield* ids.next(),
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
              says.push({ segmentId: yield* ids.next(), text: thirdPartyClose(), allowInterruptions: false });
              result = { confirmed: false, outcome };
            }
            break;
          }
          case "propose_promise_to_pay": {
            const readBackSegmentId = yield* ids.next();
            const proposal: PendingProposalJson = {
              kind: "PROMISE_TO_PAY",
              amount: String(args["amount"]),
              date: String(args["date"]),
              proposed_at_seq: snapshot.lastSequenceNo + 1,
              read_back_turn_id: params.turnId,
              read_back_segment_id: readBackSegmentId,
            };
            pendingProposal = proposal;
            if (state !== "CONFIRMING_OUTCOME") {
              yield* append(row.id, { type: "STATE_TRANSITION", payload: { from: state, to: "CONFIRMING_OUTCOME", triggered_by: "PROPOSAL" } }, at);
              nextState = "CONFIRMING_OUTCOME";
            }
            yield* conv.updateConversation(row.id, { currentState: nextState, pendingProposal: proposal });
            // A "yes" spoken over the read-back commits a turn the fully-heard guard then refuses,
            // replaying the read-back; the worker still lets those words reach the ledger.
            says.push({ segmentId: readBackSegmentId, text: promiseReadback({ amount: proposal.amount, date: proposal.date }), allowInterruptions: false });
            result = { amount: proposal.amount, date: proposal.date };
            break;
          }
          case "record_promise_to_pay": {
            const proposal = row.pendingProposal;
            const verdict = proposal && proposal.read_back_turn_id !== null ? readBackVerdict(params.events, { segmentId: proposal.read_back_segment_id ?? proposal.read_back_turn_id, turnId: proposal.read_back_turn_id }, row.channel) : "unconfirmed";
            if (!proposal || verdict !== "heard") {
              rejected = { reason: "INVALID_ARGS", detail: proposal ? unheardDetail(verdict) : NO_PENDING_PROPOSAL_DETAIL };
              yield* append(row.id, { type: "TOOL_REJECTED", payload: { name: call.name, tool_call_id: toolCallId, state, reason: rejected.reason, detail: rejected.detail } }, at);
              if (proposal) {
                const repeatSegmentId = yield* ids.next();
                pendingProposal = { ...proposal, read_back_turn_id: params.turnId, read_back_segment_id: repeatSegmentId };
                yield* conv.updateConversation(row.id, { pendingProposal });
                says.push({ segmentId: repeatSegmentId, text: `Let me repeat that. ${promiseReadback({ amount: proposal.amount, date: proposal.date })}`, allowInterruptions: false });
              } else {
                says.push({ segmentId: yield* ids.next(), text: "I don't have a payment amount and date to record yet. What amount and date work for you?", allowInterruptions: true });
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
            says.push({ segmentId: yield* ids.next(), text: promiseRecordedConfirmation({ amount: proposal.amount, date: proposal.date }), allowInterruptions: false });
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
            says.push({ segmentId: yield* ids.next(), text: callbackScheduledConfirmation({ datetime: dueAtIso, timeZone: ctx.borrowerTimeZone }), allowInterruptions: false });
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
            says.push({ segmentId: yield* ids.next(), text: optOutConfirmation(), allowInterruptions: false });
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
              says.push({ segmentId: yield* ids.next(), text: wrongNumberClose(), allowInterruptions: false });
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
              says.push({ segmentId: yield* ids.next(), text: thirdPartyClose(), allowInterruptions: false });
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


    return { execute } as const;
  }),
  dependencies: [ConversationRepo.Default, CrmRepo.Default, IdGen.Default, SchedulingService.Default],
}) {}
