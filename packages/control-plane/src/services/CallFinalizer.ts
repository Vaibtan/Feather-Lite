import { Effect } from "effect";
import type { CallAttemptStatus, ConversationState, Outcome, WorkflowExecutionStatus } from "@feather-lite/domain";
import { closingPath } from "@feather-lite/domain";
import type { ConversationRow } from "../db/rows.js";
import { ConversationRepo } from "../repos/conversation.js";
import type { ConversationContext } from "./ContextBuilder.js";
import { IdGen } from "./Ids.js";
import { OutboxService } from "./Outbox.js";
import { SchedulingService } from "./Scheduling.js";

const attemptStatusFor = (o: Outcome): CallAttemptStatus =>
  o === "NO_ANSWER" ? "NO_ANSWER" : o === "VOICEMAIL_LEFT" ? "VOICEMAIL" : o === "FAILED" ? "FAILED" : "COMPLETED";
const workflowStatusFor = (o: Outcome): WorkflowExecutionStatus =>
  o === "CALLBACK_SCHEDULED" || o === "NO_ANSWER" || o === "VOICEMAIL_LEFT" || o === "THIRD_PARTY_CONTACT" || o === "FAILED" ? "RUNNING" : "COMPLETED";

export class CallFinalizer extends Effect.Service<CallFinalizer>()("@feather-lite/CallFinalizer", {
  effect: Effect.gen(function* () {
    const conv = yield* ConversationRepo;
    const ids = yield* IdGen;
    const scheduling = yield* SchedulingService;
    const outbox = yield* OutboxService;

    const append = (conversationId: string, event: Parameters<typeof conv.appendEvent>[0]["event"], at: Date) =>
      Effect.gen(function* () {
        return yield* conv.appendEvent({ id: yield* ids.next(), conversationId, event, createdAt: at });
      });

    /** Must run inside the caller's transaction with the row locked. */
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

        // A call that only ever existed as a browser tab has no number to re-dial, so it must not
        // schedule a RETRY_CALL; a null `origin` is not treated as browser-originated.
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

    return { finalize } as const;
  }),
  dependencies: [ConversationRepo.Default, IdGen.Default, SchedulingService.Default, OutboxService.Default],
}) {}
