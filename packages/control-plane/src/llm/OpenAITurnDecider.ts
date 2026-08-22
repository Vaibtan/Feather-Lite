/**
 * The LLM conversationalist (PRD §5.2.3, Phase 4). Adapts a streaming chat completion into
 * the normalized `TurnChunk` protocol with two-mode streaming (plan rev.2 R1):
 *
 *   - chat mode  : the first delta is content -> stream TextDeltas as they arrive
 *   - tool mode  : the first delta is a tool call -> buffer nothing, emit only the Decision
 *                  (any model text alongside a tool call is discarded; the orchestrator speaks
 *                  deterministic confirmations)
 *
 * Domain tools map to `ToolCall`; pseudo-tools (end_call / request_human / renegotiate) map to
 * `suggestedNextState`. Malformed arguments, unknown tools, empty output and provider failures are
 * distinct, named errors that the orchestrator turns into a safe fallback + event.
 */
import { Effect, Layer, Schedule, Stream } from "effect";
import type { ToolName, TurnChunk, TurnDecision } from "@feather-lite/domain";
import { TOOL_NAMES, decision, textDelta } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { TurnDeciderInvalidOutput, TurnDeciderUnavailable } from "../errors.js";
import type { DeciderInput } from "../services/types.js";
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

export const OpenAITurnDeciderLive: Layer.Layer<TurnDecider, never, AppConfig | LlmClient | Tracing> = Layer.effect(
  TurnDecider,
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const llm = yield* LlmClient;
    const tracing = yield* Tracing;

    const shape: TurnDeciderShape = {
      name: `openai:${llm.name}`,
      decide: (input: DeciderInput) => {
        const request = {
          model: input.model || cfg.llmModelByState[input.state],
          messages: buildMessages(input),
          tools: toolSpecsFor(input.state, input.allowedTools),
          temperature: 0.3,
          maxTokens: 220,
          cacheKey: input.conversationId,
          metadata: { conversation_id: input.conversationId, turn_id: input.turnId, state: input.state },
        };
        const acc: Acc = { content: "", mode: "unknown", toolName: null, toolId: null, toolArgs: "", finished: false, usage: null };
        const startedAt = Date.now();

        const deltas = llm.stream(request).pipe(
          // One retry on transport failure BEFORE any output was produced (never mid-stream).
          Stream.retry(Schedule.recurs(1).pipe(Schedule.whileInput(() => acc.mode === "unknown" && acc.content.length === 0))),
        );

        const chunks: Stream.Stream<TurnChunk, TurnDeciderUnavailable | TurnDeciderInvalidOutput> = deltas.pipe(
          Stream.mapConcat((d: LlmDelta): ReadonlyArray<TurnChunk> => {
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
          // Append the final Decision once the provider stream ends.
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
