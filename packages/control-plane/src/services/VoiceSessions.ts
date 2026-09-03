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
  readonly workflowExecutionId?: string | undefined;
  readonly workflowType?: WorkflowType | undefined;
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
        // Checked before `startCall`, or a system with no media plane leaves a conversation row
        // no worker will serve. The detail string is matched by the scheduled-action worker.
        if (!lk) return yield* Effect.fail(new TelephonyError({ detail: NO_MEDIA_PLANE }));
        const call = yield* workflow.startCall({
          borrowerId: input.borrowerId,
          contactPointId: input.contactPointId,
          channel: "voice",
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
