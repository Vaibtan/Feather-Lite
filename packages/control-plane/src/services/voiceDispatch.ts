/**
 * Kept apart from `VoiceSessions` to break an import cycle: `VoiceSessions` -> `Orchestrator` ->
 * `SchedulingService`, which is what dispatches a scheduled re-dial. Node refuses to boot it.
 */
import { Effect, Redacted } from "effect";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { TelephonyError } from "../errors.js";
import type { AppConfigShape } from "../config.js";

export const roomNameFor = (conversationId: string) => `feather-lite-${conversationId}`;

export const NO_MEDIA_PLANE = "NO_MEDIA_PLANE";

export const hasMediaPlane = (cfg: AppConfigShape): boolean => cfg.livekit !== null;

/**
 * Distinct from `NO_MEDIA_PLANE`: LiveKit is present but has no SIP trunk. Booking this as
 * `NO_ANSWER` makes the scheduler re-dial an unreachable number until the 7-in-7 cap.
 */
export const NO_SIP_TRUNK = "NO_SIP_TRUNK";

export const canDialOut = (cfg: AppConfigShape): boolean => cfg.livekit !== null && cfg.livekit.sipOutboundTrunkId !== null;

export const dispatchAgent = (
  cfg: AppConfigShape,
  input: { readonly roomName: string; readonly metadata: string; readonly emptyTimeoutSeconds: number },
): Effect.Effect<string, TelephonyError> =>
  Effect.gen(function* () {
    const lk = cfg.livekit;
    if (!lk) return yield* Effect.fail(new TelephonyError({ detail: NO_MEDIA_PLANE }));
    const secret = Redacted.value(lk.apiSecret);
    const rooms = new RoomServiceClient(lk.url, lk.apiKey, secret);
    const dispatch = new AgentDispatchClient(lk.url, lk.apiKey, secret);
    return yield* Effect.tryPromise({
      try: async () => {
        await rooms.createRoom({ name: input.roomName, emptyTimeout: input.emptyTimeoutSeconds, metadata: input.metadata });
        const d = await dispatch.createDispatch(input.roomName, lk.agentName, { metadata: input.metadata });
        return d.id;
      },
      catch: (e) => new TelephonyError({ detail: `LiveKit bootstrap failed: ${String(e)}` }),
    }).pipe(Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => new TelephonyError({ detail: "LiveKit bootstrap timed out after 10s" }) }));
  });

export const participantToken = (
  cfg: AppConfigShape,
  input: { readonly identity: string; readonly name: string; readonly roomName: string; readonly metadata: string },
): Effect.Effect<string, TelephonyError> =>
  Effect.gen(function* () {
    const lk = cfg.livekit;
    if (!lk) return yield* Effect.fail(new TelephonyError({ detail: NO_MEDIA_PLANE }));
    const at = new AccessToken(lk.apiKey, Redacted.value(lk.apiSecret), { identity: input.identity, name: input.name, metadata: input.metadata });
    at.addGrant({ roomJoin: true, room: input.roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    return yield* Effect.promise(() => at.toJwt());
  });
