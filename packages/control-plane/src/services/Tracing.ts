/**
 * LLM tracing (SPEC §17.1). One Langfuse session per conversation, one span per three-phase turn,
 * one nested generation for the model call.
 *
 * Written against the current Langfuse JS SDK generation (`@langfuse/tracing` + `@langfuse/otel`,
 * v5, OpenTelemetry-based). The unscoped `langfuse` v3 package this used to import is the legacy
 * SDK; the vendor's own README steers new integrations to the scoped packages.
 *
 * **Why a turn is buffered and emitted late.** A turn's latency decomposition is not knowable when
 * the turn ends: the control plane knows the decide TTFT and token usage immediately, but the
 * end-of-utterance delay, the transcription delay and the TTS time-to-first-byte are measured by
 * the voice worker and only reported afterwards. Rather than emit a span that is missing half the
 * story, a turn is held until its worker metrics arrive (or until the conversation finalises, for
 * turns that never get any — simulated calls and load tests have no voice worker). Start and end
 * times are recorded explicitly, so deferring emission does not distort any timing.
 *
 * `Langfuse` when configured and enabled, `Noop` otherwise; the orchestrator and the decider are
 * unaware which. Failures to export are logged and never affect the call.
 */
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

/** The model call inside a turn. Absent for the scripted decider, which never calls a model. */
export interface GenerationRecord {
  readonly conversationId: string;
  readonly turnId: string;
  readonly state: string;
  readonly model: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly latencyMs: number;
  /** Time to first token — becomes the generation's completion-start. */
  readonly ttftMs: number | null;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number } | null;
}

/** The half of the latency decomposition only the voice worker can see. */
export interface WorkerTurnLatency {
  /** Time from end of speech (VAD) to the decision that the borrower's turn is over. */
  readonly eouDelayMs: number | null;
  /** Time to obtain the transcript after the end of the borrower's speech. */
  readonly transcriptionDelayMs: number | null;
  /** TTS time to first byte. */
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

/**
 * The judge's model call (spec 2026-08-26, D3). Not a `GenerationRecord`: it belongs to the call,
 * not to any one turn, so it has no turn to nest under and no place in the turn buffer. It gets its
 * own span on the conversation's session, which is what puts the verdict beside the turns it is
 * about rather than in a trace of its own that nothing links to.
 */
export interface JudgeRecord {
  readonly conversationId: string;
  readonly model: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly latencyMs: number;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number } | null;
}

/**
 * One quality measurement mirrored into Langfuse, so quality sits beside the latency and cost the
 * turn spans already carry. The ledger is the source of truth; this is the copy.
 */
export interface ScoreTrace {
  readonly conversationId: string;
  /** When set, the score is about this turn and targets that turn's observation. */
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
  /** Called by the decider when a model call completes. Buffered until the turn is emitted. */
  readonly generation: (g: GenerationRecord) => Effect.Effect<void>;
  /** Called by the orchestrator at the end of every turn, superseded ones included. */
  readonly turn: (t: TurnRecord) => Effect.Effect<void>;
  /** Voice-worker latency numbers for a turn; emits the turn if it was waiting for them. */
  readonly turnLatency: (conversationId: string, turnId: string, latency: WorkerTurnLatency) => Effect.Effect<void>;
  /** Emit every turn of a conversation still waiting on worker metrics that will never arrive. */
  readonly finalize: (conversationId: string) => Effect.Effect<void>;
  /** The post-call judge's model call, as its own span on the conversation's session. */
  readonly judge: (j: JudgeRecord) => Effect.Effect<void>;
  /** Mirror one score onto the conversation's session (or its turn's observation). */
  readonly score: (s: ScoreTrace) => Effect.Effect<void>;
  /**
   * Send the scores buffered so far and read the answer (O7).
   *
   * Separate from `flush` because scores are written after a call has ended — the EVALUATION and
   * JUDGE outbox jobs run post-close — so the conversation's own flush has already happened by the
   * time they exist. This is the seam `Scores.recordMany` calls when its batch is complete.
   */
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

/** In-memory recorder for tests / the console's "last generations" panel. */
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

/* ------------------------------ Langfuse ------------------------------ */

const key = (conversationId: string, turnId: string) => `${conversationId} ${turnId}`;

/**
 * A stable id per (conversation, turn, name, source), matching the identity the ledger's
 * `conversation_scores` unique index uses. Langfuse upserts a score by id, so a re-judge or a
 * re-run of the evaluator corrects the score in Langfuse exactly as it does in Postgres instead of
 * leaving two contradictory ones side by side.
 */
/**
 * Where one score attaches in Langfuse.
 *
 * Extracted from the layer so the rule can be tested without a Langfuse: the ingestion API accepts
 * **exactly one** target and rejects an `observationId` that does not name its `traceId` with a 400
 * the SDK reports only on its own logger — a silent drop, and the reason every per-turn score
 * vanished until 2026-08-27. There is no seam that can catch the real thing without a live server,
 * so what is pinned instead is the shape of the request.
 */
export interface ScoreSpanRef {
  readonly traceId: string;
  readonly observationId: string;
}

export type ScoreTarget = { readonly traceId: string; readonly observationId: string } | { readonly sessionId: string };

export const scoreTarget = (conversationId: string, span: ScoreSpanRef | undefined): ScoreTarget =>
  span === undefined ? { sessionId: conversationId } : { traceId: span.traceId, observationId: span.observationId };

/**
 * What Langfuse said about a batch of scores we sent it (O7).
 *
 * Pure, so the failure path is testable without a Langfuse. The SDK's own
 * `score.create` + `score.flush` cannot report this: `handleFlush` wraps every batch in
 * `.catch(err => this.logger.error(...))` and inspects `res.errors` only to log them, so `flush()`
 * resolves cleanly whatever happened. That is not an oversight to work around with a logger hook —
 * `LoggerConfig` in `@langfuse/core` 5.10.1 accepts a level, a prefix and a timestamp flag, and no
 * sink — so the only way to see an ingestion failure is to make the call ourselves and read the
 * answer.
 *
 * Both shapes matter. A rejected promise is the transport failing; a resolved response carrying
 * `errors` is Langfuse refusing the batch, which is exactly what happened for weeks when every
 * per-turn score named an `observationId` without its `traceId` and came back 400 (ADR 0009).
 */
export const langfuseIngestionProblems = (
  response: { readonly errors?: ReadonlyArray<{ readonly id?: string; readonly status?: number; readonly message?: string | null }> } | null,
  thrown: unknown,
): ReadonlyArray<string> => {
  if (thrown !== null && thrown !== undefined) return [`score ingestion failed: ${String(thrown)}`];
  const errors = response?.errors ?? [];
  return errors.map((e) => `score ${e.id ?? "(no id)"} rejected${e.status === undefined ? "" : ` with ${String(e.status)}`}${e.message ? `: ${e.message}` : ""}`);
};

const scoreId = (s: ScoreTrace): string =>
  createHash("sha256").update(`${s.conversationId}|${s.turnId ?? ""}|${s.name}|${s.source}`).digest("hex").slice(0, 32);

interface Pending {
  readonly conversationId: string;
  turn: TurnRecord | null;
  generation: GenerationRecord | null;
  latency: WorkerTurnLatency | null;
}

/**
 * What this process calls itself on its exported telemetry. The worker is not a second value here
 * — it has no OTel exporter of its own and reports through the control plane (ADR 0009) — but the
 * name is explicit so a future second exporter is not silently `unknown_service:node`.
 */
const serviceName = "feather-lite-server";

/**
 * What the SDK's mask hook runs on every exported span body.
 *
 * The attribute arrives as whatever the tracing layer put there — usually a JSON string, sometimes
 * an object — so the redaction is applied to the parsed structure where it parses and to the raw
 * text where it does not. Exported for its test: a mask that silently stopped masking would look
 * exactly like one that had nothing to mask.
 */
export const spanMask = ({ data }: { data: unknown }): unknown => {
  if (typeof data !== "string") return redactAccountDataDeep(data);
  try {
    // Re-serialised from the parsed form, so a redaction can never leave broken JSON behind.
    return JSON.stringify(redactAccountDataDeep(JSON.parse(data)));
  } catch {
    return redactAccountData(data);
  }
};
/** Kept in step with `/healthz` and the `/metrics` build info by being the same string. */
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
      /**
       * Account facts leave here masked unless someone turned that off (D3).
       *
       * Installed on the processor rather than at each `span.update` call site on purpose. The SDK
       * applies it to every input, output and metadata attribute of every span it exports — the
       * turn span, the nested generation whose prompt carries the whole protected block, the
       * judge's span with the full transcript — so a span added next month is covered by having
       * been added, not by someone remembering. Doing it per call site is how one of the three
       * would eventually be missed.
       */
      ...(cfg.traceRedactAccountData ? { mask: spanMask } : {}),
    });
    // `.register()` is required, not cosmetic: besides publishing the tracer provider it installs
    // the AsyncLocalStorage context manager. Without one, `context.active()` is always ROOT, so
    // `startActiveObservation` has no active span for the generation to nest under and
    // `propagateAttributes` has nowhere to put the session id — both were verified empty against a
    // local Langfuse before this call was added. This process has no other OpenTelemetry consumer.
    /**
     * Who is exporting these spans, said in OTel's own vocabulary (D3). Without a resource the SDK
     * falls back to `unknown_service:node`, which is what every process in a fleet is called.
     *
     * Worth knowing before relying on it: **Langfuse ignores this today.** Its span processor reads
     * `span.resource.attributes` in exactly one place, a debug log line
     * (`@langfuse/otel@5.10.1`) — the identity a Langfuse trace is filed under comes from
     * `environment` and the session id, both already set above. This is here because the resource
     * is the correct place for the answer and any other exporter pointed at this provider (a
     * collector, a second backend) reads it; it is not here because it changes what appears in
     * Langfuse.
     */
    const provider = new NodeTracerProvider({
      spanProcessors: [processor],
      // Literal keys rather than a dependency on `@opentelemetry/semantic-conventions` for two
      // constants; these two are stable in the spec and have never been renamed.
      resource: resourceFromAttributes({ "service.name": serviceName, "service.version": SERVICE_VERSION }),
    });
    provider.register();
    setLangfuseTracerProvider(provider);

    // Scores do not travel on the OTel span pipeline — they are their own ingestion event — so the
    // exporter above cannot carry them and a second client is needed. Verified against the
    // installed `@langfuse/client` 5.10.1 types: `ScoreBody` accepts `sessionId`, so a call-level
    // score can target the conversation's session directly and does not need the
    // score-the-first-turn's-trace fallback the spec allowed for.
    const client = new LangfuseClient({
      publicKey: cfg.langfuse.publicKey,
      secretKey: Redacted.value(cfg.langfuse.secretKey),
      baseUrl: cfg.langfuse.baseUrl,
    });
    const metrics = yield* Metrics;

    /**
     * Scores are batched here rather than in `client.score`, so that sending them is something this
     * process does and can therefore observe (O7). See `langfuseIngestionProblems` for why the
     * SDK's own queue cannot report a failure.
     */
    const pendingScores: Array<{ readonly id: string; readonly name: string; readonly [k: string]: unknown }> = [];

    const flushScores = Effect.gen(function* () {
      if (pendingScores.length === 0) return;
      const batch = pendingScores.splice(0, pendingScores.length).map((body) => ({
        id: randomUUID(),
        type: "score-create" as const,
        timestamp: new Date().toISOString(),
        body,
      }));
      // `catch` passes the cause through: the default wrapper turns "fetch failed" into
      // "An unknown error occurred in Effect.tryPromise", which is a message about Effect rather
      // than about Langfuse and would have made the ring useless for the thing it exists for.
      const result = yield* Effect.tryPromise({ try: () => client.api.ingestion.batch({ batch: batch as never }), catch: (e) => e }).pipe(
        Effect.map((res) => ({ res: res as { errors?: ReadonlyArray<{ id?: string; status?: number; message?: string | null }> }, thrown: null as unknown })),
        Effect.catchAll((e) => Effect.succeed({ res: null, thrown: e as unknown })),
      );
      const problems = langfuseIngestionProblems(result.res, result.thrown);
      for (const message of problems) {
        // Counted *and* kept: a count says how much is failing, the ring says what the failure was,
        // and it was the absence of the second that let a 400 hide for weeks.
        yield* metrics.providerEvent({ provider: "langfuse", kind: "error", stage: "observability", message, conversationId: null });
      }
      if (problems.length > 0) yield* Effect.logWarning(`langfuse rejected ${String(problems.length)} of ${String(batch.length)} score(s): ${problems[0] ?? ""}`);
    });
    // Captured here because the narrowing of `cfg.langfuse` above does not survive into the
    // closures below.
    const environment = cfg.langfuse.environment;

    /**
     * Turns waiting on their worker metrics. Bounded: a call that is abandoned without ending — the
     * worker dies, the participant vanishes — leaves entries nothing will ever claim, and an
     * observability buffer must not be able to grow into a memory leak in the process serving calls.
     * Insertion order is oldest-first, so the overflow is flushed from the front.
     */
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
        // Emits with whatever it has (or drops it, if it never got a turn record).
        emit(oldest.value, pending.get(oldest.value)!);
      }
      return made;
    };

    /**
     * Turn id -> the Langfuse trace *and* observation ids of that turn's span, learned when the span
     * is emitted. A turn-level score (per-turn WER, chars-per-second) targets the observation so it
     * lands on the turn rather than the whole call.
     *
     * **Both ids, not just the observation.** The ingestion API rejects a score carrying an
     * `observationId` with no `traceId` — "ObservationId requires traceId", HTTP 400 — and the SDK
     * reports that on its own logger rather than through the promise, so the first version dropped
     * every per-turn score *silently* and exactly in the case it was written for: a turn whose span
     * was still known. The ones that appeared in Langfuse were the ones that had aged out and taken
     * the session fallback, which is why the gap looked like a flush problem rather than a bug.
     *
     * Bounded for the same reason `pending` is: a long-running server must not accumulate one entry
     * per turn it has ever traced. A score for a turn that has aged out (or whose span was never
     * emitted) still lands, on the conversation's session, with the turn id in its comment —
     * degraded placement, never a dropped measurement.
     */
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

    /** Build the span (+ nested generation) for one turn and drop it from the buffer. */
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
      // startActiveObservation, not startObservation: session id and trace name are trace-level
      // attributes that propagateAttributes attaches to the *active* context, and the nested
      // generation finds its parent the same way. With a detached span both come out empty.
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
              // No parentSpanContext needed: the turn span is the active one inside this callback.
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

    /** Emit whatever is still buffered. A turn held for metrics that never came is still a turn. */
    const emitAllPending = () => {
      for (const [k, p] of [...pending]) emit(k, p);
    };

    const guard = <A>(f: () => A) => Effect.try(f).pipe(Effect.catchAll((e) => Effect.logWarning("langfuse export failed", e)));

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        try {
          emitAllPending();
        } catch {
          /* shutting down; a lost span must not block it */
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
          // A superseded turn never reaches the voice worker's metrics, and a turn that already has
          // them has nothing left to wait for. Everything else waits.
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
          // Same `propagateAttributes` shape as a turn: the session id is what files this span under
          // the call it judged. A judge span in a trace of its own would be unreachable from the
          // conversation, which is the only place anyone would go looking for it.
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
          // A turn-level score whose span has not been emitted (or has aged out) falls back to the
          // session, with the turn named in the comment, so the measurement is never lost.
          const orphanedTurn = s.turnId !== null && span === undefined;
          const comment = orphanedTurn ? `turn ${s.turnId}${s.comment ? ` — ${s.comment}` : ""}` : s.comment;
          pendingScores.push({
            id: scoreId(s),
            ...scoreTarget(s.conversationId, span),
            name: s.name,
            // Langfuse takes the label for a categorical score and the number for everything else;
            // BOOLEAN must be exactly 1 or 0, which the domain vocabulary already guarantees.
            value: s.dataType === "CATEGORICAL" && s.stringValue !== null ? s.stringValue : s.value,
            dataType: s.dataType,
            ...(comment !== null ? { comment } : {}),
            // Langfuse stores score metadata as a string map, so a null turn id would arrive as the
            // literal "null"; omit the key instead.
            metadata: { conversation_id: s.conversationId, source: s.source, ...(s.turnId !== null ? { turn_id: s.turnId } : {}) },
            environment,
          });
        }),
      flush: () =>
        Effect.gen(function* () {
          yield* guard(emitAllPending);
          // A span-export failure was silently ignored here. It is the same class of blindness the
          // scores had: the exporter is the only thing that knows, and nothing asked it (O7).
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
