import { Effect, Ref } from "effect";

/** Not a ledger event: it would consume a `sequence_no` and take the conversation row lock on the
 * path that is already degraded. */
export interface ProviderEvent {
  readonly provider: string;
  readonly kind: "error" | "retry" | "timeout";
  readonly stage: "stt" | "tts" | "llm" | "media" | "observability";
  readonly message: string;
  readonly conversationId: string | null;
}

export interface RecordedProviderEvent extends ProviderEvent {
  readonly at: string;
}

export interface MetricsShape {
  readonly increment: (name: string, by?: number) => Effect.Effect<void>;
  readonly providerEvent: (e: ProviderEvent) => Effect.Effect<void>;
  readonly providerEvents: () => Effect.Effect<{ readonly counters: Record<string, number>; readonly recent: ReadonlyArray<RecordedProviderEvent> }>;
  readonly snapshot: () => Effect.Effect<Record<string, unknown>>;
}

const PROVIDER_ERROR_RING = 20;

export class Metrics extends Effect.Service<Metrics>()("@feather-lite/Metrics", {
  effect: Effect.gen(function* () {
    const counters = yield* Ref.make(new Map<string, number>());
    const providerRing = yield* Ref.make<ReadonlyArray<RecordedProviderEvent>>([]);
    const startedAt = Date.now();
    const increment = (name: string, by = 1) => Ref.update(counters, (m) => new Map(m).set(name, (m.get(name) ?? 0) + by));
    const shape: MetricsShape = {
      increment,
      providerEvent: (e) =>
        Effect.gen(function* () {
          yield* increment(`provider_${e.provider}_${e.kind}`);
          yield* increment(`provider_stage_${e.stage}_${e.kind}`);
          const at = new Date().toISOString();
          yield* Ref.update(providerRing, (ring) => [{ ...e, at }, ...ring].slice(0, PROVIDER_ERROR_RING));
        }),
      providerEvents: () =>
        Effect.gen(function* () {
          const c = yield* Ref.get(counters);
          return {
            counters: Object.fromEntries([...c].filter(([k]) => k.startsWith("provider_"))),
            recent: yield* Ref.get(providerRing),
          };
        }),
      snapshot: () =>
        Effect.gen(function* () {
          const c = yield* Ref.get(counters);
          return {
            uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
            counters: Object.fromEntries(c),
          };
        }),
    };
    return shape;
  }),
}) {}
