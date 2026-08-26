/**
 * Latency waterfall rendering, shared by the conversation detail view (per-turn bars) and Status
 * (fleet p50/p95).
 *
 * The four components are what a reply serially costs: the session deciding the borrower's turn is
 * over, the transcript arriving, the decider's first token, and TTS's first byte. Components are
 * null for turns with no voice worker behind them — a simulated call or a tier-1 load run records
 * only `ttft_ms` — and those segments are simply absent from the bar rather than drawn as zero.
 */
import type { LatencyAggregate, TurnLatencyRow } from "../api.js";
import { h } from "../dom.js";

interface Component {
  readonly key: "eou" | "stt" | "ttft" | "tts";
  readonly label: string;
  readonly of: (t: TurnLatencyRow) => number | null;
}

const COMPONENTS: ReadonlyArray<Component> = [
  { key: "eou", label: "end of turn", of: (t) => t.eou_delay_ms },
  { key: "stt", label: "transcription", of: (t) => t.transcription_delay_ms },
  { key: "ttft", label: "decide TTFT", of: (t) => t.ttft_ms },
  { key: "tts", label: "TTS first byte", of: (t) => t.tts_ttfb_ms },
];

const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)}ms`);

/**
 * What the turn's synthesis produced, for the bar's tooltip. Not a fifth segment: how long a reply
 * took to *say* is not part of how long it took to arrive, and stacking it would inflate every bar
 * by the length of the sentence (spec 2026-08-26, D5).
 */
const ttsNote = (t: TurnLatencyRow): string =>
  t.tts_silent
    ? "\nTTS produced no audio for this turn"
    : t.tts_chars_per_second !== null
      ? `\nspoke ${t.tts_chars} chars in ${ms(t.tts_audio_ms)} (${t.tts_chars_per_second} chars/s)`
      : "";

export const latencyLegend = () =>
  h(
    "div",
    { class: "wf-legend" },
    ...COMPONENTS.map((c) => h("span", {}, h("i", { class: `wf-seg ${c.key}` }), c.label)),
  );

/** Per-turn stacked bars. Bars are scaled against the slowest turn shown, so shape is comparable. */
export const renderWaterfall = (turns: ReadonlyArray<TurnLatencyRow>) => {
  const measured = turns.filter((t) => t.total_ms !== null);
  if (measured.length === 0) {
    return h("div", { class: "muted small" }, "No per-turn latency recorded yet. Voice calls fill in every component; simulated calls record the decide TTFT only.");
  }
  const max = Math.max(...measured.map((t) => t.total_ms ?? 0));
  return h(
    "div",
    {},
    latencyLegend(),
    h(
      "div",
      { class: "waterfall" },
      ...measured.map((t, i) => {
        const segments = COMPONENTS.map((c) => ({ c, value: c.of(t) })).filter((s): s is { c: Component; value: number } => s.value !== null);
        const title = segments.map((s) => `${s.c.label} ${ms(s.value)}`).join("\n");
        return h(
          "div",
          { class: "wf-row", title: `turn ${i + 1}${t.state ? ` → ${t.state}` : ""}\n${title}${ttsNote(t)}` },
          // A turn whose voice produced nothing is marked on the row itself: its TTS-first-byte
          // reading is meaningless, and the bar would otherwise look like a normal fast turn.
          h("div", { class: "wf-label" }, `${i + 1}. ${t.state ?? t.status.toLowerCase()}`, t.tts_silent ? h("span", { class: "err", title: "TTS produced no audio" }, " ⌀") : null),
          h(
            "div",
            { class: "wf-bar" },
            ...segments.map((s) => h("div", { class: `wf-seg ${s.c.key}`, style: `width:${((s.value / max) * 100).toFixed(2)}%` })),
          ),
          h("div", { class: "wf-total" }, ms(t.total_ms)),
        );
      }),
    ),
  );
};

/** Fleet view: p50/p95 per component across the most recent calls. */
export const renderLatencyAggregate = (a: LatencyAggregate) => {
  const rows: Array<{ label: string; p: { n: number; p50: number | null; p95: number | null } }> = [
    ...COMPONENTS.map((c) => ({
      label: c.label,
      p: { eou: a.eou_delay_ms, stt: a.transcription_delay_ms, ttft: a.ttft_ms, tts: a.tts_ttfb_ms }[c.key],
    })),
    { label: "total (complete turns)", p: a.total_ms },
  ];
  return h(
    "div",
    {},
    h(
      "div",
      { class: "muted small", style: "margin-bottom:8px" },
      `${a.turns} turns across the last ${a.conversations} conversations`,
      // Say it out loud rather than letting a filtered reading look like a missing one.
      a.implausible_dropped > 0 ? ` · ${a.implausible_dropped} implausible reading(s) discarded` : "",
    ),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "component"), h("th", {}, "n"), h("th", {}, "p50"), h("th", {}, "p95"))),
      h(
        "tbody",
        {},
        ...rows.map((r) =>
          h(
            "tr",
            {},
            h("td", {}, r.label),
            h("td", { class: "mono small" }, String(r.p.n)),
            h("td", { class: "mono small" }, ms(r.p.p50)),
            h("td", { class: "mono small" }, ms(r.p.p95)),
          ),
        ),
      ),
    ),
  );
};
