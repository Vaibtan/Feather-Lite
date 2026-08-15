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
}

export interface VoiceSession extends StartCallResult {
  readonly roomName: string;
  readonly participantIdentity: string;
  readonly participantToken: string;
  readonly livekitUrl: string;
  readonly agentName: string;
  readonly dispatchId: string;
}

export const roomNameFor = (conversationId: string) => `feather-lite-${conversationId}`;

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
        if (!lk) return yield* Effect.fail(new TelephonyError({ detail: "LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET)" }));
        const call = yield* workflow.startCall({ borrowerId: input.borrowerId, contactPointId: input.contactPointId, channel: "voice", now: input.now });
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
        const secret = Redacted.value(lk.apiSecret);
        const rooms = new RoomServiceClient(lk.url, lk.apiKey, secret);
        const dispatch = new AgentDispatchClient(lk.url, lk.apiKey, secret);

        const bootstrap = Effect.tryPromise({
          try: async () => {
            await rooms.createRoom({ name: roomName, emptyTimeout: 300, metadata });
            const d = await dispatch.createDispatch(roomName, lk.agentName, { metadata });
            return d.id;
          },
          catch: (e) => new TelephonyError({ detail: `LiveKit bootstrap failed: ${String(e)}` }),
        });
        const dispatchId = yield* bootstrap.pipe(
          Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => new TelephonyError({ detail: "LiveKit bootstrap timed out after 10s" }) }),
          Effect.tapError(() =>
            // Close the phantom conversation so the ledger stays truthful.
            orch.processSignal(call.conversationId, { kind: "hangup", reason: "livekit_bootstrap_failed" }).pipe(Effect.ignore),
          ),
        );
        yield* conv.setAttemptProviderCallId(call.callAttemptId, `${roomName}/${dispatchId}`);

        const participantIdentity = input.participantIdentity ?? `borrower-${input.borrowerId.slice(0, 8)}`;
        const at = new AccessToken(lk.apiKey, secret, { identity: participantIdentity, name: input.participantName ?? participantIdentity, metadata });
        at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
        const token = yield* Effect.promise(() => at.toJwt());
        const session: VoiceSession = { ...call, roomName, participantIdentity, participantToken: token, livekitUrl: lk.url, agentName: lk.agentName, dispatchId };
        return session;
      });

    return { create } as const;
  }),
  dependencies: [WorkflowService.Default, Orchestrator.Default, ConversationRepo.Default, CrmRepo.Default],
}) {}
