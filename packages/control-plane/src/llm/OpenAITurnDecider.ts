import { Effect, Layer, Schedule, Stream } from "effect";
import type { ToolName, TurnChunk, TurnDecision } from "@feather-lite/domain";
import { TOOL_NAMES, decision, textDelta } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { TurnDeciderInvalidOutput, TurnDeciderUnavailable } from "../errors.js";
import type { DeciderInput } from "../services/types.js";
import { Metrics } from "../services/Metrics.js";
import { Tracing } from "../services/Tracing.js";
import { TurnDecider, type TurnDeciderShape } from "../services/TurnDecider.js";
import { LlmClient, type LlmDelta, type TokenUsage } from "./LlmClient.js";
import { PSEUDO_TOOLS, buildMessages, toolSpecsFor, type PseudoToolName } from "./prompts.js";

const isDomainTool = (name: string): name is ToolName => (TOOL_NAMES as ReadonlyArray<string>).includes(name);
const isPseudoTool = (name: string): name is PseudoToolName => name in PSEUDO_TOOLS;

interface Acc {
  content: string;
  mode: "unknown" | "chat" | "tool";
  toolName: string | null;
  toolId: string | null;
  toolArgs: string;
  finished: boolean;
  usage: TokenUsage | null;
}

export const OpenAITurnDeciderLive: Layer.Layer<TurnDecider, never, AppConfig | LlmClient | Tracing | Metrics> = Layer.effect(
  TurnDecider,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const llm = yield* LlmClient;
    const tracing = yield* Tracing;
    const metrics = yield* Metrics;

    const shape: TurnDeciderShape = {
      name: `openai:${llm.name}`,
      decide: (input: DeciderInput) => {
        const request = {
          model: input.model || cfg.llmModelByState[input.state],
          messages: buildMessages(input),
          tools: toolSpecsFor(input.state, input.allowedTools),
          temperature: 0.3,
          maxTokens: 220,
          // Keyed by state, not conversation: the key only routes to a cache shard, the match is
          // by prefix, and same-state requests share their prefix up to where transcripts diverge.
          cacheKey: `decider:${input.state}`,
          metadata: { conversation_id: input.conversationId, turn_id: input.turnId, state: input.state },
        };
        const acc: Acc = { content: "", mode: "unknown", toolName: null, toolId: null, toolArgs: "", finished: false, usage: null };
        const startedAt = Date.now();
        let firstChunkAt: number | null = null;

        const beforeAnyOutput = () => acc.mode === "unknown" && acc.content.length === 0;

        const deltas = llm.stream(request).pipe(
          Stream.tapError((e) =>
            metrics.providerEvent({
              provider: `openai:${llm.name}`,
              kind: beforeAnyOutput() ? "retry" : "error",
              stage: "llm",
              message: `${e._tag}: ${e.detail}`.slice(0, 300),
              conversationId: input.conversationId,
            }),
          ),
          // One retry on transport failure BEFORE any output was produced, never mid-stream.
          Stream.retry(Schedule.recurs(1).pipe(Schedule.whileInput(beforeAnyOutput))),
        );

        const chunks: Stream.Stream<TurnChunk, TurnDeciderUnavailable | TurnDeciderInvalidOutput> = deltas.pipe(
          Stream.mapConcat((d: LlmDelta): ReadonlyArray<TurnChunk> => {
            if (firstChunkAt === null && d._tag !== "Finish") firstChunkAt = Date.now();
            switch (d._tag) {
              case "Content": {
                if (d.text.length === 0) return [];
                if (acc.mode === "unknown") acc.mode = "chat";
                if (acc.mode === "tool") return []; // discard model prose alongside a tool call
                acc.content += d.text;
                return [textDelta(d.text)];
              }
              case "ToolCallStart": {
                if (acc.mode === "unknown") acc.mode = "tool";
                if (acc.toolName === null) {
                  acc.toolName = d.name;
                  acc.toolId = d.id;
                }
                return [];
              }
              case "ToolCallArgs": {
                acc.toolArgs += d.argsFragment;
                return [];
              }
              case "Finish": {
                acc.finished = true;
                if (d.usage) acc.usage = d.usage;
                return [];
              }
            }
          }),
          Stream.concat(
            Stream.unwrap(
              Effect.gen(function* () {
                const latencyMs = Date.now() - startedAt;
                let dec: TurnDecision;
                if (acc.toolName !== null) {
                  let args: Record<string, unknown> = {};
                  if (acc.toolArgs.trim().length > 0) {
                    try {
                      const parsed = JSON.parse(acc.toolArgs) as unknown;
                      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
                    } catch {
                      return yield* Effect.fail(new TurnDeciderInvalidOutput({ detail: `malformed tool arguments for ${acc.toolName}: ${acc.toolArgs.slice(0, 120)}` }));
                    }
                  }
                  if (isDomainTool(acc.toolName)) {
                    dec = { message: acc.content, toolCall: { name: acc.toolName, args, ...(acc.toolId ? { toolCallId: acc.toolId as never } : {}) }, intentSatisfied: true, suggestedNextState: null };
                  } else if (isPseudoTool(acc.toolName)) {
                    dec = { message: acc.content, toolCall: null, intentSatisfied: true, suggestedNextState: PSEUDO_TOOLS[acc.toolName].nextState };
                  } else {
                    return yield* Effect.fail(new TurnDeciderInvalidOutput({ detail: `unknown tool ${acc.toolName}` }));
                  }
                } else {
                  if (acc.content.trim().length === 0) {
                    return yield* Effect.fail(new TurnDeciderInvalidOutput({ detail: "empty completion" }));
                  }
                  dec = { message: acc.content, toolCall: null, intentSatisfied: false, suggestedNextState: null };
                }
                yield* tracing.generation({
                  conversationId: input.conversationId,
                  turnId: input.turnId,
                  state: input.state,
                  model: request.model,
                  input: request.messages,
                  output: dec,
                  latencyMs,
                  ttftMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
                  usage: acc.usage,
                });
                return Stream.make(decision(dec));
              }),
            ),
          ),
        );
        return chunks;
      },
    };
    return shape;
  }),
);
