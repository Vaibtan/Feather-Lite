/**
 * LLM tracing (SPEC §17.1): one trace per conversation, one generation per turn, with model,
 * state, latency and token usage. `Langfuse` when configured, `Noop` otherwise; the decider is
 * unaware which. Failures to export are logged and never affect the call.
 */
import { Context, Effect, Layer, Redacted } from "effect";
import { Langfuse } from "langfuse";
import { AppConfig } from "../config.js";

export interface GenerationRecord {
  readonly conversationId: string;
  readonly turnId: string;
  readonly state: string;
  readonly model: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly latencyMs: number;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null;
}

export interface TracingShape {
  readonly name: string;
  readonly generation: (g: GenerationRecord) => Effect.Effect<void>;
  readonly flush: () => Effect.Effect<void>;
}

export class Tracing extends Context.Tag("@feather-lite/Tracing")<Tracing, TracingShape>() {}

export const NoopTracingLive: Layer.Layer<Tracing> = Layer.succeed(Tracing, {
  name: "noop",
  generation: () => Effect.void,
  flush: () => Effect.void,
});

/** In-memory recorder for tests / the console's "last generations" panel. */
export const RecordingTracing = (): { readonly layer: Layer.Layer<Tracing>; readonly records: GenerationRecord[] } => {
  const records: GenerationRecord[] = [];
  return {
    records,
    layer: Layer.succeed(Tracing, {
      name: "recording",
      generation: (g) => Effect.sync(() => void records.push(g)),
      flush: () => Effect.void,
    }),
  };
};

export const LangfuseTracingLive: Layer.Layer<Tracing, never, AppConfig> = Layer.scoped(
  Tracing,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    if (!cfg.langfuse) return { name: "noop", generation: () => Effect.void, flush: () => Effect.void } satisfies TracingShape;
    const lf = new Langfuse({ publicKey: cfg.langfuse.publicKey, secretKey: Redacted.value(cfg.langfuse.secretKey), baseUrl: cfg.langfuse.baseUrl });
    yield* Effect.addFinalizer(() => Effect.promise(() => lf.shutdownAsync()).pipe(Effect.ignore));
    const shape: TracingShape = {
      name: "langfuse",
      generation: (g) =>
        Effect.try(() => {
          const trace = lf.trace({ id: g.conversationId, name: "collections-call", metadata: { state: g.state } });
          trace.generation({
            name: `turn:${g.state}`,
            model: g.model,
            input: g.input,
            output: g.output,
            metadata: { turn_id: g.turnId, state: g.state, latency_ms: g.latencyMs },
            ...(g.usage ? { usage: { input: g.usage.promptTokens, output: g.usage.completionTokens } } : {}),
          }).end();
        }).pipe(Effect.catchAll((e) => Effect.logWarning("langfuse export failed", e))),
      flush: () => Effect.promise(() => lf.flushAsync()).pipe(Effect.ignore),
    };
    return shape;
  }),
);
