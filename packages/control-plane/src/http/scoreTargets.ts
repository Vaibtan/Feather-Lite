/**
 * Which posted `turn_id`s do not name a turn of this conversation (O8).
 *
 * The handler checked that the conversation existed and never checked the turn, so a score could
 * name anything and be accepted. The voice harness posted the scripted line it had spoken —
 * `"BARGE-IN: I can pay 550 dollars on Friday"` — as a turn id for weeks. The rows landed, joined
 * nothing, and every one of them silently took the session-level fallback in `Tracing.score`:
 * nothing lost, nothing said, which is the worst of both.
 *
 * Pure and separate so the rule is testable without an HTTP harness. Deduplicated because a batch
 * of ten scores against one bad turn is one mistake, not ten.
 */
export const unknownTurnIds = (knownTurnIds: Iterable<string>, posted: ReadonlyArray<string | null | undefined>): ReadonlyArray<string> => {
  const known = new Set(knownTurnIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of posted) {
    // A null turn id is a call-level score, which is legitimate and names no turn.
    if (t === null || t === undefined || seen.has(t)) continue;
    seen.add(t);
    if (!known.has(t)) out.push(t);
  }
  return out;
};

/** The message a caller gets back, naming a few of the offenders rather than all of them. */
export const unknownTurnIdMessage = (unknown: ReadonlyArray<string>): string =>
  `unknown turn_id for this conversation: ${unknown.slice(0, 3).map((t) => JSON.stringify(t)).join(", ")}${unknown.length > 3 ? ` (+${String(unknown.length - 3)} more)` : ""}`;
