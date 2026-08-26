/**
 * "Is an agent still in this room?" — the media plane's answer, behind a Layer.
 *
 * This exists for the orphaned-call sweeper (spec 2026-08-26, D6). Worker liveness alone can only
 * say "no heartbeat for 30 seconds", which is also what a blocked-but-alive worker looks like; the
 * media plane can say whether anything is still on the call. That second opinion is what lets the
 * detection window be ~35 s instead of minutes without finalizing live calls.
 *
 * It is a Layer, not a call into `livekit-server-sdk` from the sweeper, so the sweeper's tests can
 * state "the agent is gone" / "the agent is still there" / "LiveKit is unreachable" directly, and
 * never need a media server running.
 */
import { Context, Effect, Layer, Redacted } from "effect";
import { RoomServiceClient } from "livekit-server-sdk";
import { AppConfig } from "../config.js";

/**
 * `ParticipantInfo_Kind.AGENT` from `@livekit/protocol`. Named here rather than imported because
 * `livekit-server-sdk` does not re-export that enum, and adding a direct dependency on the protocol
 * package to read one constant would be a worse trade than writing the constant down.
 */
const PARTICIPANT_KIND_AGENT = 4;

export interface MediaPlaneShape {
  readonly name: string;
  /**
   * `true` an agent participant is still in the room, `false` the room is gone or has no agent,
   * `null` we could not find out (LiveKit unconfigured or unreachable).
   *
   * The three-way answer is the point. Collapsing "cannot tell" into `false` would turn a LiveKit
   * outage into a fleet-wide hangup, which is a far worse failure than leaving an orphan for a few
   * more minutes.
   */
  readonly agentPresent: (roomName: string) => Effect.Effect<boolean | null>;
}

export class MediaPlane extends Context.Tag("@feather-lite/MediaPlane")<MediaPlane, MediaPlaneShape>() {}

/** No media plane configured: every answer is "cannot tell", which the sweeper treats cautiously. */
export const NoopMediaPlaneLive: Layer.Layer<MediaPlane> = Layer.succeed(MediaPlane, {
  name: "noop",
  agentPresent: () => Effect.succeed(null),
});

/** For tests: a fixed answer, or one per room. */
export const StaticMediaPlaneLive = (answer: boolean | null | ((roomName: string) => boolean | null)): Layer.Layer<MediaPlane> =>
  Layer.succeed(MediaPlane, {
    name: "static",
    agentPresent: (roomName) => Effect.succeed(typeof answer === "function" ? answer(roomName) : answer),
  });

export const LiveKitMediaPlaneLive: Layer.Layer<MediaPlane, never, AppConfig> = Layer.effect(
  MediaPlane,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const lk = cfg.livekit;
    if (!lk) return { name: "noop (livekit unconfigured)", agentPresent: () => Effect.succeed(null) };
    const rooms = new RoomServiceClient(lk.url, lk.apiKey, Redacted.value(lk.apiSecret));
    return {
      name: "livekit",
      agentPresent: (roomName) =>
        Effect.tryPromise(() => rooms.listParticipants(roomName)).pipe(
          Effect.map((participants) =>
            // A browser borrower sitting in a room with no agent is precisely an orphan, so only an
            // agent participant counts. The kind is LiveKit's own answer; the
            // identity check is the fallback for a dispatch that joined before the kind was set.
            participants.some((p) => p.kind === PARTICIPANT_KIND_AGENT || p.identity === lk.agentName || p.identity.startsWith(`${lk.agentName}-`)),
          ),
          // A deleted room is a 404, which is a definite "no agent", not an unknown. Anything else
          // (unreachable, auth, timeout) stays unknown so an outage cannot hang up live calls.
          Effect.catchAll((e) => Effect.succeed(/not found|404/i.test(String(e)) ? false : null)),
          Effect.timeoutTo({ duration: "5 seconds", onTimeout: () => null, onSuccess: (v: boolean | null) => v }),
        ),
    };
  }),
);
