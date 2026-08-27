/**
 * Quality: is the agent closing accounts, is it doing so compliantly, and is anything degrading
 * (spec 2026-08-26, D8). One request — `GET /api/system/quality` — answers all of it, so the page
 * cannot show a funnel from one window beside an SLO from another.
 *
 * Two presentation rules run through everything here:
 *
 *  - **A missing measurement is never drawn as a zero.** The API returns null for a rate whose
 *    denominator is 0, and this page prints "—" for it. "No call reached a person" and "every call
 *    that reached a person failed" are different findings, and a dashboard that renders both as 0%
 *    teaches an operator to stop trusting it.
 *  - **A heuristic says so where it is shown.** The TTS card is an outlier flag, not a measure of
 *    how the speech sounded, and the label is on the card rather than in the documentation nobody
 *    has open while looking at it.
 */
import { isVerdictScore } from "@feather-lite/domain";
import { api, type QualityReport } from "../api.js";
import { badge, clear, h } from "../dom.js";

const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, suffix = ""): string => (v === null ? "—" : `${v}${suffix}`);

/** The funnel as stages, each rated against the one above it — how a collections funnel is read. */
const renderFunnel = (q: QualityReport) => {
  const f = q.funnel;
  const stages: Array<{ label: string; n: number; of: string; rate: number | null }> = [
    { label: "attempts", n: f.attempts, of: "", rate: null },
    { label: "connected (a person answered)", n: f.connected, of: "of attempts", rate: f.rates.contact },
    { label: "right party verified", n: f.right_party, of: "of connected", rate: f.rates.right_party },
    { label: "promise to pay", n: f.promise_to_pay, of: "of right party", rate: f.rates.promise },
  ];
  const widest = Math.max(1, f.attempts);
  return h(
    "div",
    {},
    h(
      "div",
      { class: "funnel" },
      ...stages.map((s) =>
        h(
          "div",
          { class: "fn-row" },
          h("div", { class: "fn-label" }, s.label),
          h("div", { class: "fn-bar" }, h("div", { class: "fn-fill", style: `width:${((s.n / widest) * 100).toFixed(1)}%` })),
          h("div", { class: "fn-n mono" }, String(s.n)),
          h("div", { class: "fn-rate mono small muted" }, s.rate === null && s.of === "" ? "" : `${pct(s.rate)} ${s.of}`),
        ),
      ),
    ),
    h(
      "div",
      { class: "row small muted", style: "margin-top:10px;gap:14px;flex-wrap:wrap" },
      // Voicemail sits outside the funnel rather than inside it: leaving a compliant voicemail is a
      // different outcome from talking to someone, not a lesser version of one.
      h("span", {}, `voicemail ${f.voicemail} (${pct(f.rates.voicemail)} of attempts)`),
      h("span", {}, `callback ${f.callback_scheduled}`),
      h("span", {}, `failed ${f.failed}`),
      h("span", {}, `orphaned ${f.orphaned}`),
    ),
  );
};

/**
 * The SLO card. Three things are on it that were not before, and each one exists because the
 * verdict alone was misreadable (O2): which population it was computed over, how many observations
 * each component's p95 rests on, and whether a component had too few to judge at all.
 *
 * "MEETING TARGET" with three components at `insufficient_sample` is not the same claim as
 * "MEETING TARGET" with all five judged, and the badge cannot tell them apart on its own.
 */
const renderSlo = (q: QualityReport) => {
  const rows = Object.entries(q.slo.targets);
  const seg = q.slo.segment;
  const facets = [seg.channel === null ? null : `channel ${seg.channel}`, seg.decider === null ? null : `decider ${seg.decider}`].filter((v): v is string => v !== null);
  const shortfall = q.slo.insufficient.length;
  return h(
    "div",
    {},
    h(
      "div",
      { class: "row", style: "align-items:center;gap:10px" },
      badge(q.slo.pass ? "MEETING TARGET" : "BREACHED", q.slo.pass ? "good" : "bad"),
      // A green badge over a window nobody could judge is the failure mode this line prevents.
      shortfall > 0 ? badge(`${shortfall} UNJUDGED`, "warn") : null,
      h("span", { class: "muted small" }, `${facets.length > 0 ? facets.join(", ") : "all calls"} — ${q.window.conversations} call(s) in window`),
    ),
    h(
      "table",
      { style: "margin-top:10px" },
      h("thead", {}, h("tr", {}, h("th", {}, "component"), h("th", {}, "p95"), h("th", {}, "target"), h("th", {}, "n"))),
      h(
        "tbody",
        {},
        ...rows.map(([k, target]) => {
          const c = q.slo.components[k];
          const measured = c?.measured_ms ?? null;
          const status = c?.status ?? "not_measured";
          // A component with no reading cannot breach — a window of simulated calls has no
          // end-of-utterance delay, and painting that red would train people to ignore the page.
          // Too few readings is a third state: the number exists but must not be read as a tail.
          const shown = status === "insufficient_sample" ? `n<${String(q.slo.min_sample)}` : status === "not_measured" ? "—" : num(measured, "ms");
          return h(
            "tr",
            {},
            h("td", { class: "mono small" }, k),
            h("td", { class: `mono small ${status === "breach" ? "err" : status === "pass" ? "" : "muted"}` }, shown),
            h("td", { class: "mono small muted" }, `${target}ms`),
            h("td", { class: "mono small muted" }, String(c?.n ?? 0)),
          );
        }),
      ),
    ),
    shortfall > 0
      ? h("p", { class: "muted small", style: "margin-top:8px" }, `${String(shortfall)} component(s) had fewer than ${String(q.slo.min_sample)} turns carrying them. Below that a p95 is close to the maximum, so no verdict is offered rather than a flattering one.`)
      : null,
  );
};

const renderTts = (q: QualityReport) => {
  const t = q.tts;
  if (t.turns === 0) {
    return h("div", { class: "muted small" }, "No turn in this window had a voice runtime. Simulated calls synthesise nothing, so there is nothing to check — which is not the same as the voice having worked.");
  }
  return h(
    "div",
    {},
    h("div", { class: "notice small" }, "Heuristics, not a quality score. There is no MOS model here: these answer “did any audio come out” and “was this turn spoken at a rate unlike the rest”, and nothing about how the speech sounded."),
    h(
      "dl",
      { class: "kv", style: "margin-top:10px" },
      h("dt", {}, "silent playouts"),
      h("dd", { class: `mono ${t.silent_playouts > 0 ? "err" : ""}` }, `${t.silent_playouts} / ${t.turns} (${pct(t.silent_playout_rate)})`),
      h("dt", {}, "TTS first byte"),
      h("dd", { class: "mono" }, `p50 ${num(t.ttfb_ms.p50, "ms")} · p95 ${num(t.ttfb_ms.p95, "ms")}`),
      h("dt", {}, "chars/second"),
      h("dd", { class: "mono" }, `median ${num(t.chars_per_second.median)} over ${t.chars_per_second.n} turn(s)`),
      h("dt", {}, `outliers (±${(t.outlier_band * 100).toFixed(0)}%)`),
      h("dd", { class: "mono" }, t.chars_per_second.n < t.baseline_readings ? `— (needs ${t.baseline_readings} readings for a baseline)` : String(t.outlier_count)),
    ),
    ...t.outliers.map((o) =>
      h("div", { class: "small muted mono" }, `turn ${o.turn_id}: ${o.chars_per_second} chars/s (${o.deviation > 0 ? "+" : ""}${(o.deviation * 100).toFixed(0)}% of median)`),
    ),
  );
};

const renderAgreement = (q: QualityReport) => {
  const a = q.judge_agreement;
  return h(
    "div",
    {},
    h("div", { style: "font-size:26px;font-weight:600" }, a.rate === null ? "—" : pct(a.rate)),
    h(
      "div",
      { class: "muted small" },
      a.rate === null
        ? `${a.judged} call(s) judged, none labelled by hand yet. Open a call and record your own verdict to start calibrating.`
        : `agreed on ${a.agreed} of ${a.both} call(s) carrying both a judge verdict and a human label (${a.judged} judged, ${a.human_labelled} labelled)`,
    ),
  );
};

const renderScores = (q: QualityReport) =>
  q.scores.length === 0
    ? h("div", { class: "muted small" }, "No call-level scores in this window yet.")
    : h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "score"), h("th", {}, "source"), h("th", {}, "n"), h("th", {}, "rate"), h("th", {}, "mean"))),
        h(
          "tbody",
          {},
          ...q.scores.map((s) =>
            h(
              "tr",
              {},
              h("td", { class: "mono small" }, s.name),
              h("td", { class: "small muted" }, s.source),
              h("td", { class: "mono small" }, String(s.n)),
              // Booleans have a rate and numerics have a mean; neither has both.
              h("td", { class: `mono small ${s.pass_rate !== null && s.pass_rate < 1 && isVerdictScore(s.name) ? "err" : ""}` }, pct(s.pass_rate)),
              h("td", { class: "mono small" }, s.mean === null ? "—" : String(Math.round(s.mean * 1000) / 1000)),
            ),
          ),
        ),
      );

const PROMISE_CLASS: Record<string, string> = { PENDING: "neutral", DUE_TODAY: "warn", OVERDUE: "bad" };

const renderPromises = (q: QualityReport) =>
  q.promises.length === 0
    ? h("div", { class: "muted small" }, "No promises recorded in this window.")
    : h(
        "div",
        {},
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "borrower"), h("th", {}, "amount"), h("th", {}, "promised for"), h("th", {}, "status"))),
          h(
            "tbody",
            {},
            ...q.promises.map((p) =>
              h(
                "tr",
                {},
                h("td", {}, h("a", { href: `#/conversations/${p.conversation_id}` }, p.borrower_name)),
                h("td", { class: "mono small" }, p.amount),
                h("td", { class: "mono small" }, p.date),
                h("td", {}, badge(p.status.replace("_", " "), PROMISE_CLASS[p.status] ?? "neutral")),
              ),
            ),
          ),
        ),
        // Named rather than approximated: a "promise kept" rate computed without payment data would
        // be a guess wearing a percentage sign.
        h("div", { class: "muted small", style: "margin-top:8px" }, "Whether a promise was actually kept needs payment data this system does not ingest. A record_payment tool is the missing input."),
      );

const renderReliability = (q: QualityReport) => {
  const durable = Object.entries(q.reliability.counts);
  const live = Object.entries(q.reliability.provider_counters);
  const kv = (entries: Array<[string, number]>, empty: string) =>
    entries.length === 0
      ? h("div", { class: "muted small" }, empty)
      : h("dl", { class: "kv" }, ...entries.flatMap(([k, v]) => [h("dt", { class: "mono small" }, k), h("dd", { class: `mono ${v > 0 && k !== "conversations_total" ? "warn" : ""}` }, String(v))]));
  return h(
    "div",
    {},
    h("h3", {}, "From the ledger (durable)"),
    kv(durable, "nothing counted yet"),
    h("h3", { style: "margin-top:12px" }, "Vendor failures (this process, since restart)"),
    // Labelled separately because these reset on restart: an empty list here is not a healthy week.
    kv(live, "no provider errors or retries since this server started"),
    q.reliability.orphan_detect_ms.n > 0
      ? h("div", { class: "small muted", style: "margin-top:10px" }, `orphan detection: p50 ${num(q.reliability.orphan_detect_ms.p50, "ms")} over ${q.reliability.orphan_detect_ms.n} sweep(s)`)
      : null,
  );
};

export const qualityView = (root: HTMLElement, onStop: (fn: () => void) => void) => {
  clear(root);
  const windowSelect = h("select", {}, ...[10, 25, 50, 100, 250].map((n) => h("option", { value: String(n), selected: n === 50 }, `last ${n} calls`))) as HTMLSelectElement;
  const funnel = h("div", { class: "card" });
  const slo = h("div", { class: "card" });
  const agreement = h("div", { class: "card" });
  const tts = h("div", { class: "card" });
  const wer = h("div", { class: "card" });
  const promises = h("div", { class: "card" });
  const scores = h("div", { class: "card" });
  const reliability = h("div", { class: "card" });

  root.append(
    h("div", { class: "row", style: "justify-content:space-between;align-items:center" }, h("h1", {}, "Quality"), windowSelect),
    h("h2", {}, "Outcome funnel"),
    funnel,
    h("div", { class: "grid3", style: "margin-top:12px" }, h("div", {}, h("h2", {}, "Latency SLO"), slo), h("div", {}, h("h2", {}, "Judge vs human"), agreement), h("div", {}, h("h2", {}, "Transcription (harness only)"), wer)),
    h("div", { class: "grid2", style: "margin-top:12px" }, h("div", {}, h("h2", {}, "Speech (heuristics)"), tts), h("div", {}, h("h2", {}, "Promises"), promises)),
    h("h2", {}, "Scores"),
    h("div", { class: "muted small", style: "margin:-4px 0 8px" }, "Rate is the share that passed for a verdict (compliance, judge, human) and the share that was true for a call fact — a 0% voicemail rate is not a failure."),
    scores,
    h("h2", {}, "Reliability"),
    reliability,
  );

  const load = async () => {
    try {
      const q = await api.quality(Number(windowSelect.value));
      clear(funnel);
      funnel.append(renderFunnel(q));
      clear(slo);
      slo.append(renderSlo(q));
      clear(agreement);
      agreement.append(renderAgreement(q));
      clear(tts);
      tts.append(renderTts(q));
      clear(wer);
      wer.append(
        q.stt_wer.n === 0
          ? // Production calls have no ground truth to compare a transcript against, so word error
            // rate is a harness number and the page says so rather than showing an empty chart.
            h("div", { class: "muted small" }, "No word error rate in this window. WER needs ground truth, so it only exists for calls the voice harness placed — a production call has nothing to compare its transcript against.")
          : h(
              "div",
              {},
              h("div", { style: "font-size:26px;font-weight:600" }, q.stt_wer.p50 === null ? "—" : q.stt_wer.p50.toFixed(3)),
              h("div", { class: "muted small" }, `p50 · p95 ${q.stt_wer.p95 === null ? "—" : q.stt_wer.p95.toFixed(3)} over ${q.stt_wer.n} borrower line(s)`),
            ),
      );
      clear(promises);
      promises.append(renderPromises(q));
      clear(scores);
      scores.append(renderScores(q));
      clear(reliability);
      reliability.append(renderReliability(q));
    } catch (e) {
      clear(funnel);
      funnel.append(h("div", { class: "err" }, `Quality unavailable: ${String(e)}`));
    }
  };

  windowSelect.addEventListener("change", () => void load());
  void load();
  const timer = setInterval(() => void load(), 10_000);
  onStop(() => clearInterval(timer));
};
