import { Clock, DateTime, Duration, Effect } from "effect";

const realClock = Clock.make();

const make = (currentMillis: () => number): Clock.Clock => ({
  [Clock.ClockTypeId]: Clock.ClockTypeId,
  unsafeCurrentTimeMillis: currentMillis,
  currentTimeMillis: Effect.sync(currentMillis),
  unsafeCurrentTimeNanos: () => BigInt(currentMillis()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(currentMillis()) * 1_000_000n),
  sleep: (d: Duration.Duration) => realClock.sleep(d),
});

export const frozenClock = (at: DateTime.Utc): Clock.Clock => {
  const ms = DateTime.toEpochMillis(at);
  return make(() => ms);
};

export interface ShiftedClock extends Clock.Clock {
  readonly advance: (by: Duration.DurationInput) => Effect.Effect<void>;
}

export const shiftedClock = (at: DateTime.Utc): ShiftedClock => {
  let delta = DateTime.toEpochMillis(at) - realClock.unsafeCurrentTimeMillis();
  return {
    ...make(() => realClock.unsafeCurrentTimeMillis() + delta),
    advance: (by) =>
      Effect.sync(() => {
        delta += Duration.toMillis(Duration.decode(by));
      }),
  };
};

export const withFrozenClock =
  (at: DateTime.Utc) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withClock(self, frozenClock(at));

export const withShiftedClock =
  (at: DateTime.Utc) =>
  <A, E, R>(f: (clock: ShiftedClock) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const clock = shiftedClock(at);
      return Effect.withClock(f(clock), clock);
    });
