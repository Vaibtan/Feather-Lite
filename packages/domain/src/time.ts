/**
 * Time helpers on top of Effect `DateTime`. Every function takes `now`
 * explicitly — the domain never reads the wall clock (plan rev.2 R13).
 */
import { DateTime, Option } from "effect";

/** Local wall-clock parts of `now` in an IANA zone. `None` if the zone is unknown. */
export const localParts = (
  now: DateTime.Utc,
  timeZone: string,
): Option.Option<DateTime.DateTime.PartsWithWeekday> =>
  DateTime.setZoneNamed(now, timeZone).pipe(Option.map((zoned) => DateTime.toParts(zoned)));

/**
 * The next instant at or after `now` whose local time in `timeZone` is exactly
 * `hour:00`. Used to reschedule an action that fell outside the contact window
 * to the start of the next window (e.g. 08:00 local tomorrow).
 * Falls back to `now + 24h` if the zone is unknown.
 */
export const nextLocalHour = (now: DateTime.Utc, timeZone: string, hour: number): DateTime.Utc =>
  DateTime.setZoneNamed(now, timeZone).pipe(
    Option.map((zoned) => {
      const today = DateTime.setParts(zoned, { hours: hour, minutes: 0, seconds: 0, millis: 0 });
      const candidate = DateTime.greaterThan(today, zoned) ? today : DateTime.add(today, { days: 1 });
      // Re-normalise through parts to survive DST shifts (setParts is zone-adjusted).
      return DateTime.toUtc(DateTime.setParts(candidate, { hours: hour, minutes: 0, seconds: 0, millis: 0 }));
    }),
    Option.getOrElse(() => DateTime.add(now, { hours: 24 })),
  );

export const isoUtc = (dt: DateTime.DateTime): string => DateTime.formatIso(DateTime.toUtc(dt));

/** Parse an ISO-8601 instant (with zone) into `DateTime.Utc`; `None` if invalid. */
export const parseUtc = (iso: string): Option.Option<DateTime.Utc> =>
  DateTime.make(iso).pipe(Option.map(DateTime.toUtc));

/** `YYYY-MM-DD` of `now` in a zone (the borrower's "today"). */
export const localIsoDate = (now: DateTime.Utc, timeZone: string): Option.Option<string> =>
  localParts(now, timeZone).pipe(
    Option.map((p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`),
  );
