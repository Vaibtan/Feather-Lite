/**
 * Call-control operations (SPEC §10.3): runtime/telephony actions, never LLM tools.
 * Every action carries an idempotency key (`action_id`) because providers retry webhooks.
 * All functions expect to run inside the caller's transaction with the conversation locked.
 */
import { Effect } from "effect";
import type { CallControlAction, EventRecord } from "@feather-lite/domain";
import { replay } from "@feather-lite/domain";
import { ConversationRepo } from "../repos/conversation.js";
import { IdGen } from "./Ids.js";

export interface LoggedAction {
  readonly action: CallControlAction;
  readonly action_id: string;
  readonly duplicate: boolean;
}

export class CallControl extends Effect.Service<CallControl>()("@feather-lite/CallControl", {
  effect: Effect.gen(function* () {
    const conv = yield* ConversationRepo;
    const ids = yield* IdGen;

    /** Append CALL_CONTROL unless an event with the same action_id already exists. */
    const logAction = (params: {
      conversationId: string;
      events: ReadonlyArray<EventRecord>;
      action: CallControlAction;
      actionId: string | null;
      payload?: Record<string, unknown>;
      now: Date;
    }) =>
      Effect.gen(function* () {
        const actionId = params.actionId ?? (yield* ids.next());
        const snapshot = replay(params.events);
        if (snapshot.actionIds.has(actionId)) {
          return { action: params.action, action_id: actionId, duplicate: true } satisfies LoggedAction;
        }
        yield* conv.appendEvent({
          id: yield* ids.next(),
          conversationId: params.conversationId,
          event: { type: "CALL_CONTROL", payload: { action: params.action, action_id: actionId, ...(params.payload ?? {}) } },
          createdAt: params.now,
        });
        return { action: params.action, action_id: actionId, duplicate: false } satisfies LoggedAction;
      });

    /**
     * Warm-transfer stub (SPEC §13.3): logs WARM_TRANSFER + TRANSFER_REQUESTED + TRANSFER_COMPLETED
     * with a `handoff_stubbed` status. A SIP bridge transfer plugs in here later.
     */
    const warmTransfer = (params: {
      conversationId: string;
      events: ReadonlyArray<EventRecord>;
      target: string;
      reason: string;
      actionId: string | null;
      now: Date;
    }) =>
      Effect.gen(function* () {
        const logged = yield* logAction({
          conversationId: params.conversationId,
          events: params.events,
          action: "WARM_TRANSFER",
          actionId: params.actionId,
          payload: { target: params.target, reason: params.reason },
          now: params.now,
        });
        if (!logged.duplicate) {
          yield* conv.appendEvent({
            id: yield* ids.next(),
            conversationId: params.conversationId,
            event: { type: "TRANSFER_REQUESTED", payload: { target: params.target, reason: params.reason, action_id: logged.action_id } },
            createdAt: params.now,
          });
          yield* conv.appendEvent({
            id: yield* ids.next(),
            conversationId: params.conversationId,
            event: {
              type: "TRANSFER_COMPLETED",
              payload: { target: params.target, reason: params.reason, action_id: logged.action_id, status: "handoff_stubbed" },
            },
            createdAt: params.now,
          });
        }
        return logged;
      });

    return { logAction, warmTransfer } as const;
  }),
  dependencies: [ConversationRepo.Default, IdGen.Default],
}) {}
