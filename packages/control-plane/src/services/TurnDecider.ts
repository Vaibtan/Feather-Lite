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

export const scriptedTurnDecider: TurnDeciderShape = {
  name: "scripted",
  decide: (input) => {
    const d = scriptedDecide(input);
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

export const FailingTurnDeciderLive = (error: TurnDeciderUnavailable | TurnDeciderInvalidOutput): Layer.Layer<TurnDecider> =>
  Layer.succeed(TurnDecider, { name: "failing", decide: () => Stream.fail(error) });

export const StaticTurnDeciderLive = (
  fn: (input: DeciderInput) => Stream.Stream<TurnChunk, TurnDeciderUnavailable | TurnDeciderInvalidOutput>,
): Layer.Layer<TurnDecider> => Layer.succeed(TurnDecider, { name: "static", decide: fn });

