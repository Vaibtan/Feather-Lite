export const unknownTurnIds = (knownTurnIds: Iterable<string>, posted: ReadonlyArray<string | null | undefined>): ReadonlyArray<string> => {
  const known = new Set(knownTurnIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of posted) {
    if (t === null || t === undefined || seen.has(t)) continue;
    seen.add(t);
    if (!known.has(t)) out.push(t);
  }
  return out;
};

export const unknownTurnIdMessage = (unknown: ReadonlyArray<string>): string =>
  `unknown turn_id for this conversation: ${unknown.slice(0, 3).map((t) => JSON.stringify(t)).join(", ")}${unknown.length > 3 ? ` (+${String(unknown.length - 3)} more)` : ""}`;
