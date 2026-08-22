/**
 * Provider seam for chat completions. The decider only ever sees this interface, so
 *  - tests can swap in a recording/scripted client and assert on the EXACT request body
 *    (the protected-context leak test lives at this level, plan rev.2 R12), and
 *  - a different provider is a Layer, not a rewrite.
 */
import { Context, Effect, Layer, Redacted, Stream } from "effect";
import OpenAI from "openai";
import { AppConfig } from "../config.js";
import { TurnDeciderUnavailable } from "../errors.js";

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
}

export class LlmClient extends Context.Tag("@feather-lite/LlmClient")<LlmClient, LlmClientShape>() {}

/* ------------------------------ OpenAI ------------------------------ */

export const OpenAILlmClientLive: Layer.Layer<LlmClient, never, AppConfig> = Layer.effect(
  LlmClient,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const apiKey = cfg.openaiApiKey ? Redacted.value(cfg.openaiApiKey) : "";
    const client = new OpenAI({ apiKey, baseURL: cfg.openaiBaseUrl });
    const shape: LlmClientShape = {
      name: "openai",
      stream: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (!apiKey) return yield* Effect.fail(new TurnDeciderUnavailable({ detail: "OPENAI_API_KEY is not configured" }));
            const controller = new AbortController();
            const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
              model: request.model,
              messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
              temperature: request.temperature,
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

/* ------------------------------ test doubles ------------------------------ */

export interface RecordedRequest {
  readonly request: ChatRequest;
}

/**
 * A client whose replies are scripted per call and which records every request.
 * `script(i, request)` returns the deltas for the i-th call.
 */
export const RecordingLlmClient = (
  script: (callIndex: number, request: ChatRequest) => ReadonlyArray<LlmDelta>,
): { readonly layer: Layer.Layer<LlmClient>; readonly requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  const layer = Layer.succeed(LlmClient, {
    name: "recording",
    stream: (request) => {
      const i = requests.length;
      requests.push({ request });
      return Stream.fromIterable(script(i, request));
    },
  });
  return { layer, requests };
};
