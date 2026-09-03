import { Context, Effect, Layer, Redacted } from "effect";
import { RoomServiceClient } from "livekit-server-sdk";
import { AppConfig } from "../config.js";

/**
 * `ParticipantInfo_Kind.AGENT`, written out because `livekit-server-sdk` does not re-export it.
 */
const PARTICIPANT_KIND_AGENT = 4;

export interface MediaPlaneShape {
  readonly name: string;
  /**
   * `null` means "could not find out", not "no agent". Collapsing it into `false` would turn a
   * LiveKit outage into a fleet-wide hangup.
   */
  readonly agentPresent: (roomName: string) => Effect.Effect<boolean | null>;
}

export class MediaPlane extends Context.Tag("@feather-lite/MediaPlane")<MediaPlane, MediaPlaneShape>() {}

export const NoopMediaPlaneLive: Layer.Layer<MediaPlane> = Layer.succeed(MediaPlane, {
  name: "noop",
  agentPresent: () => Effect.succeed(null),
});

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
            participants.some((p) => p.kind === PARTICIPANT_KIND_AGENT || p.identity === lk.agentName || p.identity.startsWith(`${lk.agentName}-`)),
          ),
          Effect.catchAll((e) => Effect.succeed(/not found|404/i.test(String(e)) ? false : null)),
          Effect.timeoutTo({ duration: "5 seconds", onTimeout: () => null, onSuccess: (v: boolean | null) => v }),
        ),
    };
  }),
);
