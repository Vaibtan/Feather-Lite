/**
 * Small value types with validation at the boundary. LLM tool arguments and
 * HTTP payloads decode through these so the rest of the domain can trust them.
 */
import { ParseResult, Schema } from "effect";

const isValidCalendarDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
  );
};

/** `YYYY-MM-DD`, validated as a real calendar date. */
export const IsoDate = Schema.String.pipe(
  Schema.filter(isValidCalendarDate, { message: () => "expected a calendar date in YYYY-MM-DD form" }),
  Schema.brand("IsoDate"),
);
export type IsoDate = typeof IsoDate.Type;

const ISO_DATETIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * ISO-8601 date-time *with an explicit zone* (Z or ±HH:MM). Callback times must
 * be unambiguous — a borrower's "3pm" is meaningless without a zone.
 * Normalised to UTC `YYYY-MM-DDTHH:MM:SSZ` on decode.
 */
export const IsoDateTime = Schema.transformOrFail(Schema.String, Schema.String.pipe(Schema.brand("IsoDateTime")), {
  strict: true,
  decode: (input, _, ast) => {
    if (!ISO_DATETIME_WITH_ZONE.test(input) || Number.isNaN(Date.parse(input))) {
      return ParseResult.fail(
        new ParseResult.Type(ast, input, "expected an ISO-8601 date-time with a timezone (e.g. 2026-03-25T15:00:00+05:30)"),
      );
    }
    return ParseResult.succeed(new Date(input).toISOString().replace(/\.\d{3}Z$/, "Z"));
  },
  encode: (value) => ParseResult.succeed(value as string),
});
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * A positive money amount, normalised to a fixed 2-decimal string ("550.00").
 * Accepts numbers or numeric strings (with optional `$` and thousands separators).
 * Stored and compared as strings to avoid binary-float drift in a ledger.
 */
export const MoneyAmount = Schema.transformOrFail(
  Schema.Union(Schema.Number, Schema.String),
  Schema.String.pipe(Schema.brand("MoneyAmount")),
  {
    strict: true,
    decode: (input, _, ast) => {
      const raw = typeof input === "number" ? String(input) : input.replace(/[$,\s]/g, "");
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
        return ParseResult.fail(new ParseResult.Type(ast, input, "expected a positive amount with at most 2 decimals"));
      }
      const [whole, frac = ""] = raw.split(".");
      const normalised = `${Number(whole)}.${(frac + "00").slice(0, 2)}`;
      if (Number(normalised) <= 0) {
        return ParseResult.fail(new ParseResult.Type(ast, input, "amount must be greater than zero"));
      }
      return ParseResult.succeed(normalised);
    },
    encode: (value) => ParseResult.succeed(value as string),
  },
);
export type MoneyAmount = typeof MoneyAmount.Type;

/** E.164 phone number. */
export const E164 = Schema.String.pipe(Schema.pattern(/^\+[1-9]\d{6,14}$/), Schema.brand("E164"));
export type E164 = typeof E164.Type;

/** IANA timezone name, validated with the runtime's Intl data. */
export const TimeZone = Schema.String.pipe(
  Schema.filter(
    (tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: () => "expected an IANA timezone name" },
  ),
  Schema.brand("TimeZone"),
);
export type TimeZone = typeof TimeZone.Type;
