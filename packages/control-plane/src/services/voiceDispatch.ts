/**
 * Putting an agent in a room: the media-plane half of starting a voice call, with no knowledge of
 * conversations, workflows or the orchestrator.
 *
 * It lives apart from `VoiceSessions` because two callers need it and they cannot both import that
 * service. `VoiceSessions` depends on `Orchestrator`, `Orchestrator` depends on
 * `SchedulingService`, and the scheduled-action worker *is* `SchedulingService` — so a scheduled
 * re-dial reaching for `VoiceSessions` closes an import cycle that TypeScript compiles and Node
 * refuses to boot. (The same shape as the `handlers.ts` -> `app.ts` cycle that took the server down
 * earlier in this work; the lesson was cheaper the second time.)
 *
 * Everything here is a function of config and strings.
 */
import { Effect, Redacted } from "effect";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { TelephonyError } from "../errors.js";
import type { AppConfigShape } from "../config.js";

/** One room per conversation, named from it, so a room can always be traced back to a call. */
export const roomNameFor = (conversationId: string) => `feather-lite-${conversationId}`;

/**
 * Why a voice call could not be placed at all: nothing is configured to carry it.
 *
 * Distinct from a bootstrap failure, where the media plane exists and did not answer, and distinct
 * again from a call that started and later lost its worker. A caller that cannot tell these apart
 * will book the first as the third — which is exactly what happened: a scheduled re-dial with no
 * media plane created a conversation nobody could serve, and the sweeper later recorded it as an
 * orphan detected after five minutes (O4).
 */
export const NO_MEDIA_PLANE = "NO_MEDIA_PLANE";

/** Is there a media plane at all? Checked *before* a conversation row is written. */
export const hasMediaPlane = (cfg: AppConfigShape): boolean => cfg.livekit !== null;

/**
 * Why an outbound voice call could not be placed: there is a media plane, and nothing to dial out
 * *through* (C4).
 *
 * A third distinct answer, and the distinction is the finding. `NO_MEDIA_PLANE` means no LiveKit;
 * this means LiveKit is there but has no SIP trunk, which is the self-hosted profile — the one this
 * repo runs. Booking that as `NO_ANSWER`, which is what happened while only the worker knew, made
 * the scheduler re-dial a number it could never reach until the 7-in-7 cap, taking a room, a
 * dispatch and a worker job slot on every lap.
 */
export const NO_SIP_TRUNK = "NO_SIP_TRUNK";

/**
 * Can this deployment place an outbound call? The SIP trunk is provisioned on LiveKit Cloud; the
 * self-hosted profile has none, so this is `false` on the box this is developed on and in CI.
 */
export const canDialOut = (cfg: AppConfigShape): boolean => cfg.livekit !== null && cfg.livekit.sipOutboundTrunkId !== null;

/**
 * Create the room and dispatch the agent to it. Returns the dispatch id.
 *
 * The 10-second timeout is not arbitrary: without it a LiveKit that accepts the connection and then
 * stalls leaves the caller hanging with a conversation row already written.
 */
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

/** A join token for a human participant. Not needed for an outbound call nobody watches. */
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
