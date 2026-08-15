/**
 * The conversationalist seam (SPEC §9.4). Implementations stream `TurnChunk`s:
 * zero or more `TextDelta`s and exactly one final `Decision`.
 *
 *  - `ScriptedTurnDecider`  deterministic; drives the scenario suite and CI (no network).
 *  - `OpenAITurnDecider`    (Phase 4) real model with tool calling.
 *
 * Both are constrained by the same allowlist and validated by the same orchestrator.
 */
import { Context, Layer, Stream } from "effect";
import type { TurnChunk } from "@feather-lite/domain";
import { decision, textDelta } from "@feather-lite/domain";
import type { TurnDeciderInvalidOutput, TurnDeciderUnavailable } from "../errors.js";
import type { DeciderInput } from "./types.js";
import { scriptedDecide } from "./scripted/decide.js";

export interface TurnDeciderShape {
  readonly name: string;
  readonly decide: (input: DeciderInput) => Stream.Stream<TurnChunk, TurnDeciderUnavailable | TurnDeciderInvalidOutput>;
}

export class TurnDecider extends Context.Tag("@feather-lite/TurnDecider")<TurnDecider, TurnDeciderShape>() {}

/** Deterministic decider: emits the message as a few deltas, then the decision. */
export const scriptedTurnDecider: TurnDeciderShape = {
  name: "scripted",
  decide: (input) => {
    const d = scriptedDecide(input);
    // Tool-mode turns carry no model text (the orchestrator speaks the confirmation);
    // chat-mode turns stream the message in word groups to exercise the streaming path.
    if (d.toolCall !== null) return Stream.make(decision(d));
    const words = d.message.split(" ");
    const chunks: TurnChunk[] = [];
    for (let i = 0; i < words.length; i += 4) {
      chunks.push(textDelta((i === 0 ? "" : " ") + words.slice(i, i + 4).join(" ")));
    }
    chunks.push(decision(d));
    return Stream.fromIterable(chunks);
  },
};
export const ScriptedTurnDeciderLive: Layer.Layer<TurnDecider> = Layer.succeed(TurnDecider, scriptedTurnDecider);

/** A decider that always fails — for the degraded-path tests. */
export const FailingTurnDeciderLive = (error: TurnDeciderUnavailable | TurnDeciderInvalidOutput): Layer.Layer<TurnDecider> =>
  Layer.succeed(TurnDecider, { name: "failing", decide: () => Stream.fail(error) });

/** A decider scripted per test: a function from input to a fixed decision (or a stream). */
export const StaticTurnDeciderLive = (
  fn: (input: DeciderInput) => Stream.Stream<TurnChunk, TurnDeciderUnavailable | TurnDeciderInvalidOutput>,
): Layer.Layer<TurnDecider> => Layer.succeed(TurnDecider, { name: "static", decide: fn });

