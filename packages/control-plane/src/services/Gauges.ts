/**
 * The process's gauges: one registry, a zero default, and no module-level mutable state (F5).
 *
 * `/status` and the Prometheus endpoint report on things the metrics layer does not own — the live
 * turn map, the SSE subscriber count, the pg pool, the rate-limit buckets. Those live in the modules
 * that manage them, and correctly so: a module must not have to depend on a metrics service in order
 * to be observable.
 *
 * The old shape got that right and paid for it with `export let liveTurnCount = () => 0`, reassigned
 * when `TurnRunner` was built. Two problems, one of them live in the test suite:
 *
 *   - Two `TurnRunner`s in one process share one slot, so the second silently replaces the first's
 *     closure. Every test file that builds one does this.
 *   - A torn-down `TurnRunner` leaves its closure pointing at a map nobody is maintaining, and the
 *     gauge keeps reporting from it.
 *
 * A supplier registry fixes both without inverting the dependency: the owner still owns the state
 * and hands over a *function that reads it*, and each `Gauges` instance has its own registry, so one
 * build cannot reach into another's.
 *
 * **A gauge nobody registered reads zero, and a supplier that throws reads zero.** `/status` is what
 * an operator opens when something is already wrong; it answering at all outranks any one number in
 * it being present.
 */
import { Effect } from "effect";

/** The gauges this process reports. A closed set, so a typo is a compile error rather than a zero. */
export type GaugeName = "live_turns" | "sse_streams" | "rate_limit_buckets";

export class Gauges extends Effect.Service<Gauges>()("@feather-lite/Gauges", {
  sync: () => {
    const sources = new Map<GaugeName, () => number>();
    return {
      /** Registered by whoever owns the state, at the time they start owning it. */
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
