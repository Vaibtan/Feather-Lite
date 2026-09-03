// A gauge nobody registered reads zero, and a supplier that throws reads zero: `/status`
// answering at all outranks any one number in it being present.
import { Effect } from "effect";

export type GaugeName = "live_turns" | "sse_streams" | "rate_limit_buckets";

export class Gauges extends Effect.Service<Gauges>()("@feather-lite/Gauges", {
  sync: () => {
    const sources = new Map<GaugeName, () => number>();
    return {
      set: (name: GaugeName, read: () => number): void => {
        sources.set(name, read);
      },
      read: (name: GaugeName): number => {
        const source = sources.get(name);
        if (source === undefined) return 0;
        try {
          return source();
        } catch {
          return 0;
        }
      },
    };
  },
}) {}
