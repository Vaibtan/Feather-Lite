/**
 * The per-IP request budget, as a testable unit (O9).
 *
 * It was six lines inline in the middleware with two defects that a dashboard could never show.
 * The map was never evicted, so on a public address it grew one entry per distinct client IP for
 * the life of the process — small per entry, unbounded in aggregate, and unobservable because
 * nothing reported its size. And a refusal moved no counter, so a tier-1 run that this middleware
 * 429ed 92 times reported "23/50 correct" and left the status page unable to tell "the agent is
 * broken" from "I am shedding my own load".
 *
 * Process-local by design: one Node process, one map. The edge port would use KV or a Durable
 * Object, and the shape here is deliberately the one that ports — a decision per key per window.
 */

/** A fixed-window budget keyed by client IP. Not a sliding window: the edge equivalent is not either. */
export interface RateLimiter {
  /** True to serve, false to refuse. Counts the request either way. */
  readonly check: (key: string, perMinute: number, now?: number) => boolean;
  /** How many keys are currently held. Published on `/status` so unbounded growth is visible. */
  readonly size: () => number;
}

export const WINDOW_MS = 60_000;
/** Entries older than two windows cannot affect any decision, so they are dropped. */
export const STALE_AFTER_MS = WINDOW_MS * 2;

export const makeRateLimiter = (): RateLimiter => {
  const buckets = new Map<string, { count: number; windowStart: number }>();

  /**
   * Swept on write rather than on a timer: a bucket only becomes stale as time passes, and the only
   * thing here that observes time passing is a request — so there is no loop to leak and nothing to
   * shut down.
   *
   * Rate-limited to one sweep per window. Sweeping on every *new* key is O(map size) per new
   * caller, which is O(n²) across n distinct IPs arriving together — and a burst of distinct IPs is
   * exactly the case the eviction exists for, so the fix would have made the attack cheaper to
   * mount than the leak it prevents. Nothing can become stale faster than one window anyway.
   */
  let lastSweptAt = 0;
  const sweep = (now: number): void => {
    if (now - lastSweptAt < WINDOW_MS) return;
    lastSweptAt = now;
    for (const [key, b] of buckets) if (now - b.windowStart > STALE_AFTER_MS) buckets.delete(key);
  };

  return {
    check: (key, perMinute, now = Date.now()) => {
      const b = buckets.get(key);
      if (!b || now - b.windowStart > WINDOW_MS) {
        if (buckets.size > 1) sweep(now);
        buckets.set(key, { count: 1, windowStart: now });
        return true;
      }
      b.count += 1;
      return b.count <= perMinute;
    },
    size: () => buckets.size,
  };
};

/**
 * The process's limiter, and the size accessor the status page reads.
 *
 * The singleton lives here rather than in `app.ts` because `handlers.ts` needs to report its size
 * and `app.ts` already imports `handlers.ts` — putting it there closed an import cycle that
 * TypeScript is happy to compile and Node refuses to run ("Cannot access 'SystemLive' before
 * initialization", at boot, every time).
 */
export const limiter = makeRateLimiter();

/** How many per-IP buckets are held right now; on `/status` so unbounded growth is visible. */
export const rateLimitBucketCount = (): number => limiter.size();
