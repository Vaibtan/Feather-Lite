/**
 * In-process counters/histograms surfaced on `/api/system/status` (SPEC §17.2). Cheap and
 * process-local by design; a Langfuse/OTel exporter is a separate layer (Phase 4).
 */
import { Effect, Ref } from "effect";

export interface MetricsShape {
  readonly increment: (name: string, by?: number) => Effect.Effect<void>;
  readonly observe: (name: string, value: number) => Effect.Effect<void>;
  readonly snapshot: () => Effect.Effect<Record<string, unknown>>;
}

export class Metrics extends Effect.Service<Metrics>()("@feather-lite/Metrics", {
  effect: Effect.gen(function* () {
    const counters = yield* Ref.make(new Map<string, number>());
    const hist = yield* Ref.make(new Map<string, { count: number; total: number; max: number }>());
    const startedAt = Date.now();
    const shape: MetricsShape = {
      increment: (name, by = 1) => Ref.update(counters, (m) => new Map(m).set(name, (m.get(name) ?? 0) + by)),
      observe: (name, value) =>
        Ref.update(hist, (m) => {
          const cur = m.get(name) ?? { count: 0, total: 0, max: 0 };
          return new Map(m).set(name, { count: cur.count + 1, total: cur.total + value, max: Math.max(cur.max, value) });
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
