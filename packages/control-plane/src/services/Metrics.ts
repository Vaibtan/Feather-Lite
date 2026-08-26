/**
 * In-process counters/histograms surfaced on `/api/system/status` (SPEC §17.2). Cheap and
 * process-local by design; a Langfuse/OTel exporter is a separate layer.
 *
 * These are the **live** view: they reset when the process does. The durable answer to the same
 * questions is computed from the ledger on the quality endpoint, and the two are shown side by side
 * and labelled, because "no errors" from a process that restarted a minute ago is not the same
 * claim as "no errors" from the record of every call ever made.
 *
 * Lives under `services/` rather than `http/` because the orchestrator counts here too — the
 * failure modes worth watching (a superseded turn, a decider outage, a read-back repeated because
 * the borrower heard silence) happen in the conversation loop, not at the HTTP edge.
 */
import { Effect, Ref } from "effect";

/**
 * A vendor failure the runtime saw and handled (spec 2026-08-26, D6). Deliberately **not** a ledger
 * event: a Deepgram socket retry is not something that happened *on the call* in the sense the
 * replayable event log means, and writing one would consume a `sequence_no` and take the
 * conversation row lock on the very path that is already degraded.
 */
export interface ProviderEvent {
  /** The vendor or plugin that failed, as it labels itself, e.g. `deepgram.STT`. */
  readonly provider: string;
  readonly kind: "error" | "retry" | "timeout";
  readonly stage: "stt" | "tts" | "llm" | "media";
  readonly message: string;
  readonly conversationId: string | null;
}

export interface RecordedProviderEvent extends ProviderEvent {
  readonly at: string;
}

export interface MetricsShape {
  readonly increment: (name: string, by?: number) => Effect.Effect<void>;
  readonly observe: (name: string, value: number) => Effect.Effect<void>;
  /** Count a vendor failure and keep it in the recent-errors ring. */
  readonly providerEvent: (e: ProviderEvent) => Effect.Effect<void>;
  /** Counters plus the last few provider failures, newest first. */
  readonly providerEvents: () => Effect.Effect<{ readonly counters: Record<string, number>; readonly recent: ReadonlyArray<RecordedProviderEvent> }>;
  readonly snapshot: () => Effect.Effect<Record<string, unknown>>;
}

/**
 * How many recent provider failures to keep. Enough to see a pattern during a call or a fleet run,
 * small enough that the ring can never become a memory leak in a long-running server.
 */
const PROVIDER_ERROR_RING = 20;

export class Metrics extends Effect.Service<Metrics>()("@feather-lite/Metrics", {
  effect: Effect.gen(function* () {
    const counters = yield* Ref.make(new Map<string, number>());
    const hist = yield* Ref.make(new Map<string, { count: number; total: number; max: number }>());
    const providerRing = yield* Ref.make<ReadonlyArray<RecordedProviderEvent>>([]);
    const startedAt = Date.now();
    const increment = (name: string, by = 1) => Ref.update(counters, (m) => new Map(m).set(name, (m.get(name) ?? 0) + by));
    const shape: MetricsShape = {
      increment,
      observe: (name, value) =>
        Ref.update(hist, (m) => {
          const cur = m.get(name) ?? { count: 0, total: 0, max: 0 };
          return new Map(m).set(name, { count: cur.count + 1, total: cur.total + value, max: Math.max(cur.max, value) });
        }),
      providerEvent: (e) =>
        Effect.gen(function* () {
          // Two counters per event: by vendor (which one is degrading) and by stage (what broke).
          // Answering "is Deepgram flaky" and "is it STT or TTS" from one number is impossible.
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
          const h = yield* Ref.get(hist);
          return {
            uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
            counters: Object.fromEntries(c),
            histograms: Object.fromEntries([...h].map(([k, v]) => [k, { count: v.count, avg: v.count ? Math.round((v.total / v.count) * 100) / 100 : 0, max: v.max }])),
          };
        }),
    };
    return shape;
  }),
}) {}
