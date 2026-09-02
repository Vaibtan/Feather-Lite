/**
 * Voice session bootstrap: pre-call policy + conversation rows (via `startCall`), then a LiveKit
 * room, an explicit agent dispatch, and a participant token for the browser. SIP dial-out is
 * performed by the worker itself once it has joined (it needs the room to exist first).
 * If LiveKit bootstrap fails after the rows are written, the attempt is marked FAILED and the
 * conversation closed, so the ledger never shows a phantom in-progress call.
 */
import { DateTime, Effect, Option, Redacted } from "effect";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { AppConfig } from "../config.js";
import type { WorkflowType } from "@feather-lite/domain";
import { NO_MEDIA_PLANE, dispatchAgent, participantToken, roomNameFor } from "./voiceDispatch.js";
import { TelephonyError } from "../errors.js";
import { ConversationRepo } from "../repos/conversation.js";
import { CrmRepo } from "../repos/crm.js";
import { Orchestrator } from "./Orchestrator.js";
import { WorkflowService, type StartCallResult } from "./Workflow.js";

export interface VoiceSessionInput {
  readonly borrowerId: string;
  readonly contactPointId: string;
  readonly participantIdentity?: string | undefined;
  readonly participantName?: string | undefined;
  readonly mode: "browser" | "sip";
  readonly now?: DateTime.Utc | undefined;
  /**
   * Attach to an existing workflow execution rather than opening a new one. A scheduled re-dial is
   * the same workflow's next attempt, not a fresh piece of work (O4).
   */
  readonly workflowExecutionId?: string | undefined;
  readonly workflowType?: WorkflowType | undefined;
  /**
   * Which harness placed this call (issue #1, D4). `"sim"` is the tier-3 simulator.
   *
   * Passed through untouched rather than inferred: a tier-3 call is `channel: "voice"` served by the
   * real decider, so nothing on this side of the wire can tell it from the calls the product's
   * latency claim is made from.
   */
  readonly harness?: string | undefined;
}

export interface VoiceSession extends StartCallResult {
  readonly roomName: string;
  readonly participantIdentity: string;
  readonly participantToken: string;
  readonly livekitUrl: string;
  readonly agentName: string;
  readonly dispatchId: string;
}

// Re-exported: callers elsewhere (the sweeper, the scheduled-action worker) import these from
// here historically, and the split into `voiceDispatch.ts` is an implementation detail of the cycle.
export { roomNameFor, NO_MEDIA_PLANE } from "./voiceDispatch.js";

export class VoiceSessions extends Effect.Service<VoiceSessions>()("@feather-lite/VoiceSessions", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const workflow = yield* WorkflowService;
    const orch = yield* Orchestrator;
    const conv = yield* ConversationRepo;
    const crm = yield* CrmRepo;

    const create = (input: VoiceSessionInput) =>
      Effect.gen(function* () {
        const lk = cfg.livekit;
        // Checked before `startCall`, so a system with no media plane does not leave a conversation
        // row behind that no worker will ever serve (O4). The detail string is matched by the
        // scheduled-action worker, so it is a constant rather than prose.
        if (!lk) return yield* Effect.fail(new TelephonyError({ detail: NO_MEDIA_PLANE }));
        const call = yield* workflow.startCall({
          borrowerId: input.borrowerId,
          contactPointId: input.contactPointId,
          channel: "voice",
          // The session's own mode, so a call that only ever existed in a browser tab is never
          // re-dialled over a trunk it has no leg on (C4).
          origin: input.mode,
          now: input.now,
          ...(input.workflowExecutionId === undefined ? {} : { workflowExecutionId: input.workflowExecutionId }),
          ...(input.workflowType === undefined ? {} : { workflowType: input.workflowType }),
          ...(input.harness === undefined ? {} : { harness: input.harness }),
        });
        const contactPoint = yield* crm.findContactPoint(input.contactPointId);
        const roomName = roomNameFor(call.conversationId);
        const metadata = JSON.stringify({
          conversation_id: call.conversationId,
          workflow_execution_id: call.workflowExecutionId,
          call_attempt_id: call.callAttemptId,
          borrower_id: input.borrowerId,
          contact_point_id: input.contactPointId,
          contact_point_value: Option.isSome(contactPoint) ? contactPoint.value.value : null,
          mode: input.mode,
          channel: "voice",
          opening_text: call.openingText,
        });
        const dispatchId = yield* dispatchAgent(cfg, { roomName, metadata, emptyTimeoutSeconds: 300 }).pipe(
          Effect.tapError(() =>
            // Close the phantom conversation so the ledger stays truthful.
            orch.processSignal(call.conversationId, { kind: "hangup", reason: "livekit_bootstrap_failed" }).pipe(Effect.ignore),
          ),
        );
        yield* conv.setAttemptProviderCallId(call.callAttemptId, `${roomName}/${dispatchId}`);

        const participantIdentity = input.participantIdentity ?? `borrower-${input.borrowerId.slice(0, 8)}`;
        const token = yield* participantToken(cfg, { identity: participantIdentity, name: input.participantName ?? participantIdentity, roomName, metadata });
        const session: VoiceSession = { ...call, roomName, participantIdentity, participantToken: token, livekitUrl: lk.url, agentName: lk.agentName, dispatchId };
        return session;
      });

    return { create } as const;
  }),
  dependencies: [WorkflowService.Default, Orchestrator.Default, ConversationRepo.Default, CrmRepo.Default],
}) {}
