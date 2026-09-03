export interface RateLimiter {
  readonly check: (key: string, perMinute: number, now?: number) => boolean;
  readonly size: () => number;
}

export const WINDOW_MS = 60_000;
export const STALE_AFTER_MS = WINDOW_MS * 2;

// Ten thousand entries bound the map to roughly a megabyte. At the ceiling the oldest entries go,
// not the new caller: refusing new buckets would let invented addresses shut out real ones.
export const MAX_BUCKETS = 10_000;

export const makeRateLimiter = (): RateLimiter => {
  const buckets = new Map<string, { count: number; windowStart: number }>();

  // Rate-limited to one sweep per window: sweeping on every new key is O(n²) across n distinct IPs
  // arriving together, which is the very burst eviction exists for.
  let lastSweptAt = 0;
  const sweep = (now: number): void => {
    if (now - lastSweptAt < WINDOW_MS) return;
    lastSweptAt = now;
    for (const [key, b] of buckets) if (now - b.windowStart > STALE_AFTER_MS) buckets.delete(key);
  };

  const evictOldest = (now: number): void => {
    lastSweptAt = 0;
    sweep(now);
    if (buckets.size < MAX_BUCKETS) return;
    const target = Math.floor(MAX_BUCKETS * 0.9);
    for (const key of buckets.keys()) {
      if (buckets.size <= target) break;
      buckets.delete(key);
    }
  };

  return {
    check: (key, perMinute, now = Date.now()) => {
      const b = buckets.get(key);
      if (!b || now - b.windowStart > WINDOW_MS) {
        if (buckets.size > 1) sweep(now);
        if (buckets.size >= MAX_BUCKETS) evictOldest(now);
        buckets.set(key, { count: 1, windowStart: now });
        return true;
      }
      b.count += 1;
      return b.count <= perMinute;
    },
    size: () => buckets.size,
  };
};

// The singleton lives here rather than in `app.ts`: `handlers.ts` reports its size and `app.ts`
// already imports `handlers.ts`, so owning it there closes an import cycle Node refuses to run.
export const limiter = makeRateLimiter();

export const rateLimitBucketCount = (): number => limiter.size();
