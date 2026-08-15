/**
 * Small deterministic parsers used by the scripted decider (and by tests) to turn borrower
 * phrases into tool arguments: relative dates in the borrower's local calendar and money.
 * The real LLM does this itself; these exist so the scenario suite never touches a model.
 */
import { DateTime, Option } from "effect";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

const isoOf = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const addDays = (isoDate: string, days: number): string => {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};

const weekdayOf = (isoDate: string): number => {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * Parse a payment date from free text, relative to the borrower's local `today` (YYYY-MM-DD).
 * Returns null when nothing recognisable is present.
 */
export const parseRelativeDate = (text: string, today: string): string | null => {
  const t = text.toLowerCase();
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso?.[1]) return iso[1];
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  if (/\bday after tomorrow\b/.test(t)) return addDays(today, 2);
  const inDays = /\bin (\d+|[a-z]+) days?\b/.exec(t);
  if (inDays?.[1]) {
    const n = Number.isNaN(Number(inDays[1])) ? NUMBER_WORDS[inDays[1]] : Number(inDays[1]);
    if (n !== undefined) return addDays(today, n);
  }
  if (/\bnext week\b/.test(t)) return addDays(today, 7);
  if (/\bend of (the )?month\b/.test(t)) {
    const [y, m] = today.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return isoOf(y, m, last);
  }
  const ordinal = /\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (ordinal?.[1]) {
    const day = Number(ordinal[1]);
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    if (day > d) return isoOf(y, m, day);
    const next = new Date(Date.UTC(y, m, day)); // next month
    return isoOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const w = WEEKDAYS[i]!;
    if (new RegExp(`\\b${w}\\b`).test(t)) {
      const todayW = weekdayOf(today);
      let delta = (i - todayW + 7) % 7;
      if (delta === 0) delta = 7; // "Friday" said on a Friday means next Friday
      if (/\bnext\b/.test(t) && delta < 7) delta += 7 * 0; // "next friday" is treated as the coming one (collections-friendly)
      return addDays(today, delta);
    }
  }
  return null;
};

/** Parse a money amount: "$1,200", "1200", "550 dollars", "five hundred fifty". Returns "1200.00" or null. */
export const parseAmount = (text: string): string | null => {
  const t = text.toLowerCase().replace(/,/g, "");
  const numeric = /(?:\$\s*)?(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)?\b/.exec(t);
  const wordsMatch = /\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)\s*)+)(?:dollars?|bucks)?\b/.exec(t);
  let value: number | null = null;
  if (numeric?.[1] && !/\b(?:the )?\d{1,2}(?:st|nd|rd|th)\b/.test(numeric[0])) {
    // ignore ordinals like "the 15th" and bare small day numbers followed by "th"
    const n = Number(numeric[1]);
    if (n > 0 && !(n <= 31 && /\b(?:on|by) (?:the )?\d{1,2}\b/.test(t) && !/\$|dollars?/.test(numeric[0]))) value = n;
  }
  if (value === null && wordsMatch?.[1]) {
    let total = 0;
    let current = 0;
    for (const w of wordsMatch[1].trim().split(/\s+/)) {
      if (w === "and") continue;
      const n = NUMBER_WORDS[w];
      if (n === undefined) continue;
      if (n === 100) current = (current || 1) * 100;
      else if (n === 1000) {
        total += (current || 1) * 1000;
        current = 0;
      } else current += n;
    }
    total += current;
    if (total > 0) value = total;
  }
  if (value === null) return null;
  return value.toFixed(2);
};

/** Parse a callback time: "tomorrow at 3pm", "at 10", "in the morning". Returns {isoDate, hour, minute}. */
export const parseCallbackTime = (
  text: string,
  today: string,
): { readonly isoDate: string; readonly hour: number; readonly minute: number } => {
  const t = text.toLowerCase();
  const isoDate = parseRelativeDate(t, today) ?? addDays(today, 1);
  let hour = 10;
  let minute = 0;
  const explicit = /\b(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/.exec(t);
  if (explicit?.[1]) {
    const h = Number(explicit[1]);
    const mer = explicit[3]?.replace(/\./g, "");
    if (h >= 1 && h <= 12 && mer) {
      hour = (h % 12) + (mer === "pm" ? 12 : 0);
      minute = Number(explicit[2] ?? 0);
    } else if (h >= 8 && h <= 20 && /\bat\b/.test(t)) {
      hour = h;
      minute = Number(explicit[2] ?? 0);
    }
  } else if (/\bmorning\b/.test(t)) hour = 10;
  else if (/\bafternoon\b/.test(t)) hour = 15;
  else if (/\bevening\b/.test(t)) hour = 18;
  return { isoDate, hour, minute };
};

/** Combine a local date/time in a zone into an ISO-8601 UTC instant string. */
export const localToUtcIso = (isoDate: string, hour: number, minute: number, timeZone: string): string => {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const zoned = DateTime.makeZoned(
    { year, month, day, hours: hour, minutes: minute, seconds: 0, millis: 0 },
    { timeZone, adjustForTimeZone: true },
  );
  return Option.match(zoned, {
    onNone: () => new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString().replace(/\.\d{3}Z$/, "Z"),
    onSome: (z) => DateTime.formatIso(DateTime.toUtc(z)).replace(/\.\d{3}Z$/, "Z"),
  });
};
