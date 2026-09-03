import { Effect, Layer } from "effect";

export class IdGen extends Effect.Service<IdGen>()("@feather-lite/IdGen", {
  succeed: { next: () => Effect.sync(() => crypto.randomUUID()) } as const,
}) {}

export const IdGenSequential = (prefix = "00000000"): Layer.Layer<IdGen> => {
  let n = 0;
  return Layer.succeed(IdGen, {
    next: () =>
      Effect.sync(() => {
        n += 1;
        return `${prefix.padStart(8, "0").slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
      }),
  } as unknown as IdGen);
};
