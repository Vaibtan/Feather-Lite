/** Tiny DOM helpers — enough for an operator console without a framework. */

type Child = Node | string | number | null | undefined | false | Child[];

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
};

const append = (el: Node, children: Child[]) => {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
};

export const clear = (el: Element) => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

export const fmtTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) : "—");
export const fmtDur = (s: number | null | undefined): string => (s === null || s === undefined ? "—" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
export const ago = (iso: string): string => {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  return d < 60 ? `${Math.round(d)}s ago` : d < 3600 ? `${Math.round(d / 60)}m ago` : `${Math.round(d / 3600)}h ago`;
};

export const OUTCOME_CLASS: Record<string, string> = {
  PROMISE_TO_PAY: "good",
  CALLBACK_SCHEDULED: "good",
  VOICEMAIL_LEFT: "neutral",
  NO_ANSWER: "neutral",
  THIRD_PARTY_CONTACT: "neutral",
  WRONG_NUMBER: "warn",
  OPT_OUT: "warn",
  ESCALATED: "warn",
  DISPUTED: "warn",
  FAILED: "bad",
};

/**
 * The SLO window's verdict, as a badge. Two pages render it and both used to render only two of
 * the three states — `insufficient` is neither a pass nor a failure, and a green badge over a
 * window nobody could judge was the most flattering thing either page could say (review #12).
 *
 * A lookup rather than a ternary chain at each site, for the same reason `OUTCOME_CLASS` is one:
 * a fourth state, or a wording change, should be one edit and not four.
 */
export const SLO_VERDICT_BADGE: Record<"pass" | "breach" | "insufficient", { readonly text: string; readonly headline: string; readonly kind: string }> = {
  pass: { text: "MEETING TARGET", headline: "SLO MET", kind: "good" },
  breach: { text: "BREACHED", headline: "SLO BREACHED", kind: "bad" },
  insufficient: { text: "NOT ENOUGH DATA", headline: "NOT ENOUGH DATA", kind: "muted" },
};

export const badge = (text: string | null | undefined, kind?: string) =>
  h("span", { class: `badge ${kind ?? (text ? (OUTCOME_CLASS[text] ?? "neutral") : "muted")}` }, text ?? "IN PROGRESS");

export const stateBadge = (state: string) => h("span", { class: `state s-${state.toLowerCase()}` }, state);

export const pre = (v: unknown) => h("pre", { class: "json" }, typeof v === "string" ? v : JSON.stringify(v, null, 2));
