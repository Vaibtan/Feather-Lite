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
  readonly cacheKey: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly maxTokens: number;
  /** Omitted for a non-reasoning model, which rejects the parameter as unknown. */
  readonly reasoningEffort: ReasoningEffort | null;
  readonly jsonSchema: { readonly name: string; readonly schema: Record<string, unknown> } | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CompletionResult {
  readonly text: string;
  readonly usage: TokenUsage | null;
  readonly latencyMs: number;
  readonly finishReason: string | null;
}

export const isReasoningModel = (model: string): boolean => /^(o\d|gpt-5)/.test(model);

export type LlmDelta =
  | { readonly _tag: "Content"; readonly text: string }
  | { readonly _tag: "ToolCallStart"; readonly index: number; readonly id: string | null; readonly name: string }
  | { readonly _tag: "ToolCallArgs"; readonly index: number; readonly argsFragment: string }
  | { readonly _tag: "Finish"; readonly reason: string | null; readonly usage: TokenUsage | null };

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
}

export interface LlmClientShape {
  readonly name: string;
  readonly stream: (request: ChatRequest) => Stream.Stream<LlmDelta, TurnDeciderUnavailable>;
  readonly complete: (request: CompletionRequest) => Effect.Effect<CompletionResult, LlmCallFailed>;
}

export class LlmClient extends Context.Tag("@feather-lite/LlmClient")<LlmClient, LlmClientShape>() {}

export const OpenAILlmClientLive: Layer.Layer<LlmClient, never, AppConfig> = Layer.effect(
  LlmClient,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const apiKey = cfg.openaiApiKey ? Redacted.value(cfg.openaiApiKey) : "";
    /**
     * Built lazily: `openai@6`'s constructor throws `Missing credentials` on an empty key, which
     * would stop the server booting with `TURN_DECIDER=scripted` and the judge off. Both call
     * sites below already fail properly on a missing key.
     */
    let openai: OpenAI | null = null;
    const client = (): OpenAI => (openai ??= new OpenAI({ apiKey, baseURL: cfg.openaiBaseUrl }));
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
        const res = yield* Effect.tryPromise({
          try: () => client().chat.completions.create(params, { timeout: 120_000 }),
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
              // parameter"), so they are omitted rather than sent and ignored.
              ...(isReasoningModel(request.model) ? {} : { temperature: request.temperature }),
              max_completion_tokens: request.maxTokens,
              stream: true,
              stream_options: { include_usage: true },
            };
            // Pin every turn of one call to the same prefix cache. Measured on gpt-4.1 with the
            // prefix prompts.ts emits: without the key cached_tokens first became non-zero on the
            // 4th turn, with it on the 2nd.
            if (request.cacheKey) params.prompt_cache_key = request.cacheKey;
            if (request.tools.length > 0) {
              params.tools = request.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
              params.tool_choice = "auto";
              params.parallel_tool_calls = false;
            }
            const completion = yield* Effect.tryPromise({
              try: () => client().chat.completions.create(params, { signal: controller.signal, timeout: 20_000 }),
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

export const NoLlmClientLive: Layer.Layer<LlmClient> = Layer.succeed(LlmClient, {
  name: "none",
  stream: () => Stream.fail(new TurnDeciderUnavailable({ detail: "no LLM client is configured in this environment" })),
  complete: () => Effect.fail(new LlmCallFailed({ detail: "no LLM client is configured in this environment" })),
});

export interface RecordedRequest {
  readonly request: ChatRequest;
}

export interface RecordedCompletion {
  readonly request: CompletionRequest;
}

export const RecordingLlmClient = (
  script: (callIndex: number, request: ChatRequest) => ReadonlyArray<LlmDelta>,
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
