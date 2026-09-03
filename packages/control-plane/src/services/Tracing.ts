import { Context, Effect, Layer, Redacted } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, setLangfuseTracerProvider, startActiveObservation, startObservation } from "@langfuse/tracing";
import { redactAccountData, redactAccountDataDeep, type ScoreDataType } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { Metrics } from "./Metrics.js";

export interface GenerationRecord {
  readonly conversationId: string;
  readonly turnId: string;
  readonly state: string;
  readonly model: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly latencyMs: number;
  readonly ttftMs: number | null;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number } | null;
}

export interface WorkerTurnLatency {
  readonly eouDelayMs: number | null;
  readonly transcriptionDelayMs: number | null;
  readonly ttsTtfbMs: number | null;
}

export interface TurnRecord {
  readonly conversationId: string;
  readonly turnId: string;
  readonly state: string;
  readonly newState: string | null;
  readonly userText: string;
  readonly agentText: string | null;
  readonly tool: string | null;
  readonly outcome: string | null;
  readonly superseded: boolean;
  readonly degraded: string | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly ttftMs: number | null;
}

export interface JudgeRecord {
  readonly conversationId: string;
  readonly model: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly latencyMs: number;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number } | null;
}

export interface ScoreTrace {
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly name: string;
  readonly value: number;
  readonly dataType: ScoreDataType;
  readonly stringValue: string | null;
  readonly source: string;
  readonly comment: string | null;
}

export interface TracingShape {
  readonly name: string;
  readonly generation: (g: GenerationRecord) => Effect.Effect<void>;
  readonly turn: (t: TurnRecord) => Effect.Effect<void>;
  readonly turnLatency: (conversationId: string, turnId: string, latency: WorkerTurnLatency) => Effect.Effect<void>;
  readonly finalize: (conversationId: string) => Effect.Effect<void>;
  readonly judge: (j: JudgeRecord) => Effect.Effect<void>;
  readonly score: (s: ScoreTrace) => Effect.Effect<void>;
  readonly flushScores: () => Effect.Effect<void>;
  readonly flush: () => Effect.Effect<void>;
}

export class Tracing extends Context.Tag("@feather-lite/Tracing")<Tracing, TracingShape>() {}

const noop: TracingShape = {
  name: "noop",
  generation: () => Effect.void,
  judge: () => Effect.void,
  turn: () => Effect.void,
  turnLatency: () => Effect.void,
  finalize: () => Effect.void,
  score: () => Effect.void,
  flushScores: () => Effect.void,
  flush: () => Effect.void,
};

export const NoopTracingLive: Layer.Layer<Tracing> = Layer.succeed(Tracing, noop);

export const RecordingTracing = (): {
  readonly layer: Layer.Layer<Tracing>;
  readonly records: GenerationRecord[];
  readonly turns: TurnRecord[];
  readonly scores: ScoreTrace[];
  readonly judges: JudgeRecord[];
} => {
  const records: GenerationRecord[] = [];
  const turns: TurnRecord[] = [];
  const scores: ScoreTrace[] = [];
  const judges: JudgeRecord[] = [];
  return {
    records,
    turns,
    scores,
    judges,
    layer: Layer.succeed(Tracing, {
      ...noop,
      name: "recording",
      generation: (g) => Effect.sync(() => void records.push(g)),
      judge: (j) => Effect.sync(() => void judges.push(j)),
      turn: (t) => Effect.sync(() => void turns.push(t)),
      score: (s) => Effect.sync(() => void scores.push(s)),
    }),
  };
};

const key = (conversationId: string, turnId: string) => `${conversationId} ${turnId}`;

/**
 * The ingestion API accepts exactly one target, and rejects an `observationId` that does not name
 * its `traceId` with a 400 the SDK reports only on its own logger — a silent drop.
 */
export interface ScoreSpanRef {
  readonly traceId: string;
  readonly observationId: string;
}

export type ScoreTarget = { readonly traceId: string; readonly observationId: string } | { readonly sessionId: string };

export const scoreTarget = (conversationId: string, span: ScoreSpanRef | undefined): ScoreTarget =>
  span === undefined ? { sessionId: conversationId } : { traceId: span.traceId, observationId: span.observationId };

/**
 * The SDK's own `score.flush` swallows batch rejections into its private logger and resolves
 * cleanly whatever happened, so ingestion is called directly here in order to read the answer.
 */
export const langfuseIngestionProblems = (
  response: { readonly errors?: ReadonlyArray<{ readonly id?: string; readonly status?: number; readonly message?: string | null }> } | null,
  thrown: unknown,
): ReadonlyArray<string> => {
  if (thrown !== null && thrown !== undefined) return [`score ingestion failed: ${String(thrown)}`];
  const errors = response?.errors ?? [];
  return errors.map((e) => `score ${e.id ?? "(no id)"} rejected${e.status === undefined ? "" : ` with ${String(e.status)}`}${e.message ? `: ${e.message}` : ""}`);
};

// Stable per (conversation, turn, name, source), matching the ledger's `conversation_scores`
// unique index, so a re-judge upserts the Langfuse score instead of adding a contradictory one.
const scoreId = (s: ScoreTrace): string =>
  createHash("sha256").update(`${s.conversationId}|${s.turnId ?? ""}|${s.name}|${s.source}`).digest("hex").slice(0, 32);

interface Pending {
  readonly conversationId: string;
  turn: TurnRecord | null;
  generation: GenerationRecord | null;
  latency: WorkerTurnLatency | null;
}

const serviceName = "feather-lite-server";

export const spanMask = ({ data }: { data: unknown }): unknown => {
  if (typeof data !== "string") return redactAccountDataDeep(data);
  try {
    return JSON.stringify(redactAccountDataDeep(JSON.parse(data)));
  } catch {
    return redactAccountData(data);
  }
};
const SERVICE_VERSION = "2.0.0";

export const LangfuseTracingLive: Layer.Layer<Tracing, never, AppConfig | Metrics> = Layer.scoped(
  Tracing,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    if (!cfg.langfuse || !cfg.langfuseEnabled) return noop;

    const processor = new LangfuseSpanProcessor({
      publicKey: cfg.langfuse.publicKey,
      secretKey: Redacted.value(cfg.langfuse.secretKey),
      baseUrl: cfg.langfuse.baseUrl,
      environment: cfg.langfuse.environment,
      ...(cfg.traceRedactAccountData ? { mask: spanMask } : {}),
    });
    // `provider.register()` below also installs the AsyncLocalStorage context manager; without it
    // `context.active()` is always ROOT, so nested generations and propagated session ids are lost.
    const provider = new NodeTracerProvider({
      spanProcessors: [processor],
      resource: resourceFromAttributes({ "service.name": serviceName, "service.version": SERVICE_VERSION }),
    });
    provider.register();
    setLangfuseTracerProvider(provider);

    // Scores are their own ingestion event and do not travel on the OTel span pipeline, so the
    // exporter above cannot carry them and a second client is needed.
    const client = new LangfuseClient({
      publicKey: cfg.langfuse.publicKey,
      secretKey: Redacted.value(cfg.langfuse.secretKey),
      baseUrl: cfg.langfuse.baseUrl,
    });
    const metrics = yield* Metrics;

    const pendingScores: Array<{ readonly id: string; readonly name: string; readonly [k: string]: unknown }> = [];

    const flushScores = Effect.gen(function* () {
      if (pendingScores.length === 0) return;
      const batch = pendingScores.splice(0, pendingScores.length).map((body) => ({
        id: randomUUID(),
        type: "score-create" as const,
        timestamp: new Date().toISOString(),
        body,
      }));
      // `catch` passes the raw cause through: Effect's default wrapper would replace the provider's
      // message with one about Effect.
      const result = yield* Effect.tryPromise({ try: () => client.api.ingestion.batch({ batch: batch as never }), catch: (e) => e }).pipe(
        Effect.map((res) => ({ res: res as { errors?: ReadonlyArray<{ id?: string; status?: number; message?: string | null }> }, thrown: null as unknown })),
        Effect.catchAll((e) => Effect.succeed({ res: null, thrown: e as unknown })),
      );
      const problems = langfuseIngestionProblems(result.res, result.thrown);
      for (const message of problems) {
        yield* metrics.providerEvent({ provider: "langfuse", kind: "error", stage: "observability", message, conversationId: null });
      }
      if (problems.length > 0) yield* Effect.logWarning(`langfuse rejected ${String(problems.length)} of ${String(batch.length)} score(s): ${problems[0] ?? ""}`);
    });
    const environment = cfg.langfuse.environment;

    const MAX_PENDING_TURNS = 500;
    const pending = new Map<string, Pending>();
    const slot = (conversationId: string, turnId: string): Pending => {
      const k = key(conversationId, turnId);
      const found = pending.get(k);
      if (found) return found;
      const made: Pending = { conversationId, turn: null, generation: null, latency: null };
      pending.set(k, made);
      while (pending.size > MAX_PENDING_TURNS) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        emit(oldest.value, pending.get(oldest.value)!);
      }
      return made;
    };

    const MAX_OBSERVATION_IDS = 2_000;
    const observationIds = new Map<string, ScoreSpanRef>();
    const rememberObservation = (k: string, ref: ScoreSpanRef): void => {
      observationIds.set(k, ref);
      while (observationIds.size > MAX_OBSERVATION_IDS) {
        const oldest = observationIds.keys().next();
        if (oldest.done) break;
        observationIds.delete(oldest.value);
      }
    };

    const emit = (k: string, p: Pending): void => {
      pending.delete(k);
      const t = p.turn;
      if (!t) return; // a generation with no turn: the turn failed before T2, nothing to hang it on
      const g = p.generation;
      const latency = {
        eouDelayMs: p.latency?.eouDelayMs ?? null,
        transcriptionDelayMs: p.latency?.transcriptionDelayMs ?? null,
        decideTtftMs: t.ttftMs,
        ttsTtfbMs: p.latency?.ttsTtfbMs ?? null,
      };
      // `startActiveObservation`, not `startObservation`: `propagateAttributes` attaches the session
      // id and trace name to the *active* context, and the nested generation finds its parent the
      // same way. A detached span leaves both empty.
      propagateAttributes({ sessionId: t.conversationId, traceName: "collections-call" }, () => {
        startActiveObservation(
          `turn:${t.state}`,
          (span) => {
            rememberObservation(key(t.conversationId, t.turnId), { traceId: span.traceId, observationId: span.id });
            span.update({
              input: { user_text: t.userText },
              output: { agent_text: t.agentText, tool: t.tool, outcome: t.outcome, new_state: t.newState },
              metadata: {
                conversation_id: t.conversationId,
                turn_id: t.turnId,
                state: t.state,
                new_state: t.newState,
                tool: t.tool,
                outcome: t.outcome,
                superseded: t.superseded,
                degraded: t.degraded,
                latency_eou_delay_ms: latency.eouDelayMs,
                latency_transcription_delay_ms: latency.transcriptionDelayMs,
                latency_decide_ttft_ms: latency.decideTtftMs,
                latency_tts_ttfb_ms: latency.ttsTtfbMs,
              },
              ...(t.degraded ? { level: "WARNING" as const, statusMessage: t.degraded } : {}),
            });
            if (g) {
              const generation = startObservation(
                `decide:${g.model}`,
                {
                  model: g.model,
                  input: g.input,
                  output: g.output,
                  ...(g.ttftMs !== null ? { completionStartTime: new Date(t.startedAtMs + g.ttftMs) } : {}),
                  ...(g.usage
                    ? {
                        usageDetails: {
                          input: g.usage.promptTokens,
                          output: g.usage.completionTokens,
                          input_cached_tokens: g.usage.cachedTokens,
                          total: g.usage.promptTokens + g.usage.completionTokens,
                        },
                      }
                    : {}),
                },
                { asType: "generation", startTime: new Date(t.startedAtMs) },
              );
              generation.end(new Date(t.startedAtMs + g.latencyMs));
            }
            span.end(new Date(t.endedAtMs));
          },
          { startTime: new Date(t.startedAtMs), endOnExit: false },
        );
      });
    };

    const emitAllPending = () => {
      for (const [k, p] of [...pending]) emit(k, p);
    };

    const guard = <A>(f: () => A) => Effect.try(f).pipe(Effect.catchAll((e) => Effect.logWarning("langfuse export failed", e)));

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        try {
          emitAllPending();
        } catch {
        }
        await processor.forceFlush();
        await client.score.shutdown();
        await provider.shutdown();
        setLangfuseTracerProvider(null);
      }).pipe(Effect.ignore),
    );

    const shape: TracingShape = {
      name: "langfuse",
      generation: (g) =>
        guard(() => {
          slot(g.conversationId, g.turnId).generation = g;
        }),
      turn: (t) =>
        guard(() => {
          const p = slot(t.conversationId, t.turnId);
          p.turn = t;
          if (t.superseded || p.latency) emit(key(t.conversationId, t.turnId), p);
        }),
      turnLatency: (conversationId, turnId, latency) =>
        guard(() => {
          const p = slot(conversationId, turnId);
          p.latency = latency;
          if (p.turn) emit(key(conversationId, turnId), p);
        }),
      finalize: (conversationId) =>
        guard(() => {
          for (const [k, p] of [...pending]) if (p.conversationId === conversationId) emit(k, p);
        }),
      judge: (j) =>
        guard(() => {
          const started = new Date(Date.now() - j.latencyMs);
          propagateAttributes({ sessionId: j.conversationId, traceName: "collections-call" }, () => {
            startActiveObservation(
              "judge",
              () => {
                startObservation(
                  `judge:${j.model}`,
                  {
                    model: j.model,
                    input: j.input,
                    output: j.output,
                    ...(j.usage
                      ? {
                          usageDetails: {
                            input: j.usage.promptTokens,
                            output: j.usage.completionTokens,
                            input_cached_tokens: j.usage.cachedTokens,
                            total: j.usage.promptTokens + j.usage.completionTokens,
                          },
                        }
                      : {}),
                    metadata: { conversation_id: j.conversationId },
                  },
                  { asType: "generation", startTime: started },
                ).end();
              },
              { startTime: started },
            );
          });
        }),
      score: (s) =>
        guard(() => {
          const span = s.turnId === null ? undefined : observationIds.get(key(s.conversationId, s.turnId));
          const orphanedTurn = s.turnId !== null && span === undefined;
          const comment = orphanedTurn ? `turn ${s.turnId}${s.comment ? ` — ${s.comment}` : ""}` : s.comment;
          pendingScores.push({
            id: scoreId(s),
            ...scoreTarget(s.conversationId, span),
            name: s.name,
            value: s.dataType === "CATEGORICAL" && s.stringValue !== null ? s.stringValue : s.value,
            dataType: s.dataType,
            ...(comment !== null ? { comment } : {}),
            // Langfuse stores score metadata as a string map, so a null turn id would arrive as the
            // literal "null"; the key is omitted instead.
            metadata: { conversation_id: s.conversationId, source: s.source, ...(s.turnId !== null ? { turn_id: s.turnId } : {}) },
            environment,
          });
        }),
      flush: () =>
        Effect.gen(function* () {
          yield* guard(emitAllPending);
          yield* Effect.tryPromise({ try: () => processor.forceFlush(), catch: (e) => e }).pipe(
            Effect.catchAll((e) =>
              Effect.logWarning(`langfuse span flush failed: ${String(e)}`).pipe(
                Effect.zipRight(metrics.providerEvent({ provider: "langfuse", kind: "error", stage: "observability", message: `span flush failed: ${String(e)}`, conversationId: null })),
              ),
            ),
          );
          yield* flushScores;
        }),
      flushScores: () => flushScores,
    };
    return shape;
  }),
);
