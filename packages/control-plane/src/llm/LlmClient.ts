/**
 * Provider seam for chat completions. The decider only ever sees this interface, so
 *  - tests can swap in a recording/scripted client and assert on the EXACT request body
 *    (the protected-context leak test lives at this level, plan rev.2 R12), and
 *  - a different provider is a Layer, not a rewrite.
 */
import { Context, Effect, Layer, Redacted, Stream } from "effect";
import OpenAI from "openai";
import { AppConfig, type ReasoningEffort } from "../config.js";
import { LlmCallFailed, TurnDeciderUnavailable } from "../errors.js";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON schema
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools: ReadonlyArray<ToolSpec>;
  readonly temperature: number;
  readonly maxTokens: number;
  /**
   * Groups requests that share a prompt prefix so the provider can route them to the same cache.
   * One call's turns share everything up to the volatile block, so this is the conversation id.
   */
  readonly cacheKey: string | null;
  /** For tracing only. */
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * A single non-streaming model call. The judge's shape (spec 2026-08-26, D3), and deliberately not
 * `ChatRequest`: there are no tools, nothing is streamed, and above all there is **no sampling
 * parameter** — reasoning models reject `temperature`, and a field that must never be set is better
 * absent than present-and-ignored.
 */
export interface CompletionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  /** Reasoning tokens count against this, so it is an order of magnitude above the visible answer. */
  readonly maxTokens: number;
  /** Omitted for a non-reasoning model, which rejects the parameter as unknown. */
  readonly reasoningEffort: ReasoningEffort | null;
  /** Strict structured output. `schema` must have every property required and no extras. */
  readonly jsonSchema: { readonly name: string; readonly schema: Record<string, unknown> } | null;
  /** For tracing only. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CompletionResult {
  readonly text: string;
  readonly usage: TokenUsage | null;
  readonly latencyMs: number;
  /** `length` here means the answer was truncated — usually reasoning ate the token budget. */
  readonly finishReason: string | null;
}

/**
 * Models that reason before answering, and therefore reject `temperature`, `top_p` and the rest of
 * the sampling family. Matched by prefix rather than by an enumerated list so a new tier of an
 * existing family does not silently fall back to sending parameters that 400.
 */
export const isReasoningModel = (model: string): boolean => /^(o\d|gpt-5)/.test(model);

/** Normalised streaming deltas. Tool-call argument fragments are concatenated by index. */
export type LlmDelta =
  | { readonly _tag: "Content"; readonly text: string }
  | { readonly _tag: "ToolCallStart"; readonly index: number; readonly id: string | null; readonly name: string }
  | { readonly _tag: "ToolCallArgs"; readonly index: number; readonly argsFragment: string }
  | { readonly _tag: "Finish"; readonly reason: string | null; readonly usage: TokenUsage | null };

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * Prompt tokens served from OpenAI's prefix cache. Zero until the prefix exceeds ~1,024 tokens,
   * and reset by anything that changes the prefix -- including `tools`, which change per state.
   * This is the only way to tell whether the cache-aligned message layout in `prompts.ts` is
   * actually paying off, so it is measured rather than assumed.
   */
  readonly cachedTokens: number;
}

export interface LlmClientShape {
  readonly name: string;
  readonly stream: (request: ChatRequest) => Stream.Stream<LlmDelta, TurnDeciderUnavailable>;
  /** One non-streaming call, for callers off the turn path (the judge). */
  readonly complete: (request: CompletionRequest) => Effect.Effect<CompletionResult, LlmCallFailed>;
}

export class LlmClient extends Context.Tag("@feather-lite/LlmClient")<LlmClient, LlmClientShape>() {}

/* ------------------------------ OpenAI ------------------------------ */

export const OpenAILlmClientLive: Layer.Layer<LlmClient, never, AppConfig> = Layer.effect(
  LlmClient,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const apiKey = cfg.openaiApiKey ? Redacted.value(cfg.openaiApiKey) : "";
    const client = new OpenAI({ apiKey, baseURL: cfg.openaiBaseUrl });
    const complete = (request: CompletionRequest): Effect.Effect<CompletionResult, LlmCallFailed> =>
      Effect.gen(function* () {
        if (!apiKey) return yield* Effect.fail(new LlmCallFailed({ detail: "OPENAI_API_KEY is not configured" }));
        const started = Date.now();
        const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
          model: request.model,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          max_completion_tokens: request.maxTokens,
        };
        if (request.reasoningEffort !== null) params.reasoning_effort = request.reasoningEffort;
        if (request.jsonSchema !== null) {
          params.response_format = { type: "json_schema", json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema } };
        }
        // Two minutes, not the turn path's twenty seconds: a reasoning model at medium effort
        // thinks for a while, and nobody is waiting on the other end of this call.
        const res = yield* Effect.tryPromise({
          try: () => client.chat.completions.create(params, { timeout: 120_000 }),
          catch: (e) => new LlmCallFailed({ detail: `openai completion failed: ${String(e).slice(0, 300)}` }),
        });
        const choice = res.choices[0];
        return {
          text: choice?.message.content ?? "",
          finishReason: choice?.finish_reason ?? null,
          latencyMs: Date.now() - started,
          usage: res.usage
            ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, cachedTokens: res.usage.prompt_tokens_details?.cached_tokens ?? 0 }
            : null,
        };
      });

    const shape: LlmClientShape = {
      name: "openai",
      complete,
      stream: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (!apiKey) return yield* Effect.fail(new TurnDeciderUnavailable({ detail: "OPENAI_API_KEY is not configured" }));
            const controller = new AbortController();
            const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
              model: request.model,
              messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
              // A reasoning model rejects sampling parameters outright (400, "unsupported
              // parameter"). The decider runs on gpt-4.1 today, but the seam must not break the
              // day someone points TURN_DECIDER at a reasoning model to try it.
              ...(isReasoningModel(request.model) ? {} : { temperature: request.temperature }),
              max_completion_tokens: request.maxTokens,
              stream: true,
              stream_options: { include_usage: true },
            };
            // Pin every turn of one call to the same prefix cache. Measured on gpt-4.1 with a
            // growing prefix in the shape prompts.ts emits: without the key, cached_tokens stayed 0
            // until the 4th turn (0/0/0/1664/1920); with it, the cache hit from the 2nd
            // (0/1408/1536/1664/1920). A collections call is short enough that the difference is
            // "caching effectively never engages" vs "engages from turn 2".
            if (request.cacheKey) params.prompt_cache_key = request.cacheKey;
            if (request.tools.length > 0) {
              params.tools = request.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
              params.tool_choice = "auto";
              params.parallel_tool_calls = false;
            }
            const completion = yield* Effect.tryPromise({
              try: () => client.chat.completions.create(params, { signal: controller.signal, timeout: 20_000 }),
              catch: (e) => new TurnDeciderUnavailable({ detail: `openai request failed: ${String(e).slice(0, 300)}` }),
            });
            return Stream.fromAsyncIterable(completion as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>, (e) => new TurnDeciderUnavailable({ detail: `openai stream failed: ${String(e).slice(0, 300)}` })).pipe(
              Stream.mapConcat((chunk: OpenAI.Chat.Completions.ChatCompletionChunk): ReadonlyArray<LlmDelta> => {
                const out: LlmDelta[] = [];
                const choice = chunk.choices[0];
                if (choice?.delta.content) out.push({ _tag: "Content", text: choice.delta.content });
                for (const tc of choice?.delta.tool_calls ?? []) {
                  if (tc.function?.name) out.push({ _tag: "ToolCallStart", index: tc.index, id: tc.id ?? null, name: tc.function.name });
                  if (tc.function?.arguments) out.push({ _tag: "ToolCallArgs", index: tc.index, argsFragment: tc.function.arguments });
                }
                if (choice?.finish_reason || chunk.usage) {
                  out.push({
                    _tag: "Finish",
                    reason: choice?.finish_reason ?? null,
                    usage: chunk.usage
                      ? {
                          promptTokens: chunk.usage.prompt_tokens,
                          completionTokens: chunk.usage.completion_tokens,
                          cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                        }
                      : null,
                  });
                }
                return out;
              }),
              Stream.tap((d) =>
                d._tag === "Finish" && d.usage
                  ? Effect.logInfo("openai usage").pipe(
                      Effect.annotateLogs({
                        model: request.model,
                        prompt_tokens: d.usage.promptTokens,
                        cached_tokens: d.usage.cachedTokens,
                        completion_tokens: d.usage.completionTokens,
                        ...request.metadata,
                      }),
                    )
                  : Effect.void,
              ),
              Stream.ensuring(Effect.sync(() => controller.abort())),
            );
          }),
        ),
    };
    return shape;
  }),
);

/**
 * An `LlmClient` that refuses every call.
 *
 * For wiring a service graph whose model path must not be exercised — the DB test harness, where
 * the outbox now needs a client for the judge but no test that has not asked for the judge should
 * be able to reach a model. Failing loudly beats a stub that quietly returns something.
 */
export const NoLlmClientLive: Layer.Layer<LlmClient> = Layer.succeed(LlmClient, {
  name: "none",
  stream: () => Stream.fail(new TurnDeciderUnavailable({ detail: "no LLM client is configured in this environment" })),
  complete: () => Effect.fail(new LlmCallFailed({ detail: "no LLM client is configured in this environment" })),
});

/* ------------------------------ test doubles ------------------------------ */

export interface RecordedRequest {
  readonly request: ChatRequest;
}

export interface RecordedCompletion {
  readonly request: CompletionRequest;
}

/**
 * A client whose replies are scripted per call and which records every request.
 * `script(i, request)` returns the deltas for the i-th call.
 */
export const RecordingLlmClient = (
  script: (callIndex: number, request: ChatRequest) => ReadonlyArray<LlmDelta>,
  /**
   * Canned replies for the non-streaming path, by call index. Returning a string is a reply;
   * returning null fails the call, which is how a judge outage is tested without a network.
   */
  completions?: (callIndex: number, request: CompletionRequest) => string | null,
): { readonly layer: Layer.Layer<LlmClient>; readonly requests: RecordedRequest[]; readonly completions: RecordedCompletion[] } => {
  const requests: RecordedRequest[] = [];
  const recordedCompletions: RecordedCompletion[] = [];
  const layer = Layer.succeed(LlmClient, {
    name: "recording",
    stream: (request) => {
      const i = requests.length;
      requests.push({ request });
      return Stream.fromIterable(script(i, request));
    },
    complete: (request) => {
      const i = recordedCompletions.length;
      recordedCompletions.push({ request });
      const text = completions?.(i, request) ?? null;
      return text === null
        ? Effect.fail(new LlmCallFailed({ detail: "recording client: no canned completion" }))
        : Effect.succeed({ text, usage: null, latencyMs: 0, finishReason: "stop" });
    },
  });
  return { layer, requests, completions: recordedCompletions };
};
