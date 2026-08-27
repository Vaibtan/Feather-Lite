/**
 * Status: API/DB/agent-worker health, decider mode, counters, plus the console's own settings
 * (API base URL, bearer token) and the demo seed/reset controls.
 */
import { api, apiBase, apiToken, setApiBase, setApiToken, type SystemStatus } from "../api.js";
import { ago, badge, clear, h, pre } from "../dom.js";
import { renderLatencyAggregate } from "./latency.js";

export const statusView = (root: HTMLElement, onStop: (fn: () => void) => void) => {
  clear(root);
  const health = h("div", { class: "grid3" });
  const counters = h("div", { class: "card" });
  const ledger = h("div", { class: "grid3" });
  const agents = h("div", { class: "card" });
  const latency = h("div", { class: "card" });
  const quality = h("div", { class: "card" });
  const providers = h("div", { class: "card" });
  const seedOut = h("div", { class: "small muted", style: "margin-top:8px" });

  const baseInput = h("input", { value: apiBase(), placeholder: "https://api.example.com (empty = same origin)", style: "min-width:340px" }) as HTMLInputElement;
  const tokenInput = h("input", { value: apiToken() ?? "", placeholder: "bearer token (if the API requires one)", type: "password", style: "min-width:340px" }) as HTMLInputElement;
  const save = () => {
    setApiBase(baseInput.value.trim());
    setApiToken(tokenInput.value.trim());
    void load();
  };

  const seedBtn = h("button", { class: "btn", onClick: () => void seed(false) }, "Seed demo data");
  const resetBtn = h("button", { class: "btn danger", onClick: () => void seed(true) }, "Reset demo data");

  root.append(
    h("h1", {}, "Status"),
    health,
    h("h2", {}, "Agent workers"),
    agents,
    h("h2", {}, "Ledger (durable)"),
    ledger,
    h("h2", {}, "Turn latency (recent calls)"),
    latency,
    h("h2", {}, "Quality (recent calls)"),
    quality,
    h("h2", {}, "Vendor failures (most recent)"),
    providers,
    h("h2", {}, "Process counters (since start)"),
    counters,
    h("h2", {}, "Demo data"),
    h("div", { class: "card" }, h("div", { class: "row" }, seedBtn, resetBtn), h("div", { class: "muted small", style: "margin-top:6px" }, "Seed creates the five demo borrowers and a short call history. Reset wipes conversations, actions and outbox jobs for those borrowers and re-seeds."), seedOut),
    h("h2", {}, "Console settings"),
    h("div", { class: "card" }, h("div", { class: "kv" }, h("dt", {}, "API base"), h("dd", {}, baseInput), h("dt", {}, "Token"), h("dd", {}, tokenInput)), h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "btn primary", onClick: save }, "Save & reconnect"), h("span", { class: "muted small" }, "Also settable via ?api=<url> and #token=<token> in the URL."))),
  );

  /** One headline number with its unit spelled out, because a bare percentage is not a finding. */
  const metric = (label: string, value: string, sub: string) =>
    h("div", {}, h("div", { class: "muted small" }, label), h("div", { style: "font-size:22px;font-weight:600" }, value), h("div", { class: "muted small" }, sub));

  const rateOf = (q: { scores: Array<{ name: string; pass_rate: number | null }> }, name: string): string => {
    const row = q.scores.find((x) => x.name === name);
    return row?.pass_rate === null || row === undefined ? "—" : `${(row.pass_rate * 100).toFixed(0)}%`;
  };

  const card = (title: string, on: boolean | null, text: string) => h("div", { class: "card" }, h("h3", {}, title), h("div", { class: "row" }, h("span", { class: `dot ${on === null ? "" : on ? "on" : "off"}` }), text));

  const load = async () => {
    try {
      const s: SystemStatus = await api.status();
      clear(health);
      health.append(
        card("API", true, `reachable at ${apiBase() || window.location.origin}`),
        card("Database", s.database === "ok", s.database),
        card("Turn decider", null, `${s.turn_decider}${s.demo_mode ? " · demo mode (auth + rate limits on)" : ""}`),
      );
      clear(agents);
      if (!s.agents.length) agents.append(h("div", { class: "muted" }, "No agent worker has ever reported. Start apps/voice-worker to enable live calls; Simulate and Scenarios work without it."));
      else
        agents.append(
          h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Status"), h("th", {}, "Last seen"), h("th", {}, "Meta"))), h("tbody", {}, ...s.agents.map((a) => h("tr", {}, h("td", { class: "mono" }, a.agent_name), h("td", {}, h("span", { class: `dot ${a.online ? "on" : "off"}` }), a.online ? "online" : "offline"), h("td", {}, ago(a.last_seen_at)), h("td", { class: "small mono" }, JSON.stringify(a.meta)))))),
        );
      clear(ledger);
      const g = s.ledger.guardrails;
      const caught = (g["TOOL_REJECTED"] ?? 0) + (g["TURN_DECISION_REJECTED"] ?? 0);
      const kv = (o: Record<string, number>, empty: string) =>
        Object.keys(o).length ? h("dl", { class: "kv" }, ...Object.entries(o).flatMap(([k, v]) => [h("dt", { class: "mono" }, k), h("dd", {}, String(v))])) : h("div", { class: "muted small" }, empty);
      ledger.append(
        h("div", { class: "card" }, h("h3", {}, `Outcomes · ${s.ledger.conversations_total} conversations`), kv(s.ledger.outcomes, "no conversations yet")),
        h("div", { class: "card" }, h("h3", {}, "Guardrails"), h("div", { style: "font-size:22px;font-weight:600;margin-bottom:6px" }, String(caught), h("span", { class: "muted small", style: "font-weight:400" }, " model suggestions rejected by the state machine")), kv({ TOOL_REJECTED: g["TOOL_REJECTED"] ?? 0, TURN_DECISION_REJECTED: g["TURN_DECISION_REJECTED"] ?? 0, TURN_SUPERSEDED: g["TURN_SUPERSEDED"] ?? 0 }, "")),
        h("div", { class: "card" }, h("h3", {}, "Volume"), kv({ USER_TURN_FINAL: g["USER_TURN_FINAL"] ?? 0, TOOL_CALLED: g["TOOL_CALLED"] ?? 0, STATE_TRANSITION: g["STATE_TRANSITION"] ?? 0 }, "")),
      );
      clear(providers);
      // The ring D6 asked for: counters say how much is failing, this says what the failure was.
      // A count alone cannot distinguish a Deepgram socket that reconnected from one that did not.
      providers.append(
        s.provider_events.recent.length === 0
          ? h("div", { class: "muted small" }, "No provider error, retry or timeout since this server started. These are live counts, not history — a restart empties this.")
          : h(
              "table",
              {},
              h("thead", {}, h("tr", {}, h("th", {}, "when"), h("th", {}, "provider"), h("th", {}, "stage"), h("th", {}, "kind"), h("th", {}, "message"))),
              h(
                "tbody",
                {},
                ...s.provider_events.recent.map((e) =>
                  h(
                    "tr",
                    {},
                    h("td", { class: "small muted" }, ago(e.at)),
                    h("td", { class: "mono small" }, e.provider),
                    h("td", { class: "small" }, e.stage),
                    h("td", {}, badge(e.kind, e.kind === "error" ? "bad" : "warn")),
                    h("td", { class: "small muted" }, e.message),
                  ),
                ),
              ),
            ),
      );
      clear(counters);
      counters.append(pre(s.counters));
      clear(latency);
      // Its own request and its own failure mode: an empty ledger is not an unhealthy API.
      latency.append(
        // The SLO verdict sits with the numbers it judges: an operator glancing at latency should
        // not have to work out from five percentiles whether any of them missed their target.
        h(
          "div",
          { class: "row", style: "align-items:center;gap:10px;margin-bottom:10px" },
          badge(s.slo.pass ? "SLO MET" : "SLO BREACHED", s.slo.pass ? "good" : "bad"),
          // The segment and its size, because "SLO MET over 0 calls" and "SLO MET over 50" are the
          // same badge and very different claims (O2).
          h(
            "span",
            { class: "muted small" },
            s.slo.breaches.length
              ? `over target: ${s.slo.breaches.join(", ")}`
              : s.slo.insufficient.length
                ? `too few turns to judge: ${s.slo.insufficient.join(", ")}`
                : `every measured component within target`,
          ),
          h(
            "span",
            { class: "muted small" },
            `${[s.slo.segment.channel, s.slo.segment.decider].filter((v) => v !== null).join(" / ") || "all calls"} — ${String(s.slo.segment.calls_found)}/${String(s.slo.segment.calls_requested)} call(s)`,
          ),
        ),
        await api.latencyAggregate(20).then(renderLatencyAggregate, (e: unknown) => h("div", { class: "err small" }, `latency unavailable: ${String(e)}`)),
      );
      clear(quality);
      // A strip, not a second Quality page: enough to see whether anything wants looking at, with
      // the link to the page that explains it. Its own request, so an empty score table cannot
      // blank the health cards above.
      quality.append(
        await api.quality(20).then(
          (q) =>
            h(
              "div",
              {},
              h(
                "div",
                { class: "row", style: "gap:22px;flex-wrap:wrap" },
                metric("promise rate", q.funnel.rates.promise === null ? "—" : `${(q.funnel.rates.promise * 100).toFixed(0)}%`, "of right-party calls"),
                metric("judge pass", rateOf(q, "judge.overall_pass"), "calls the judge passed"),
                metric("compliance", rateOf(q, "compliance.mini_miranda_first"), "disclosure first"),
                metric("judge vs human", q.judge_agreement.rate === null ? "—" : `${(q.judge_agreement.rate * 100).toFixed(0)}%`, q.judge_agreement.both === 0 ? "no human labels yet" : `over ${q.judge_agreement.both} labelled call(s)`),
              ),
              h("div", { style: "margin-top:10px" }, h("a", { href: "#/quality" }, "full quality report →")),
            ),
          (e: unknown) => h("div", { class: "err small" }, `quality unavailable: ${String(e)}`),
        ),
      );
    } catch (e) {
      clear(health);
      health.append(card("API", false, `unreachable: ${(e as Error).message}`));
    }
  };

  const seed = async (reset: boolean) => {
    seedBtn.disabled = resetBtn.disabled = true;
    seedOut.textContent = reset ? "resetting…" : "seeding…";
    try {
      const r = reset ? await api.reset() : await api.seed();
      seedOut.textContent = `${reset ? "reset" : "seeded"}: ${r.map((x) => `${x.name}${x.created ? " (new)" : ""}`).join(", ")}`;
      await load();
    } catch (e) {
      seedOut.textContent = "";
      seedOut.append(h("span", { class: "err" }, (e as Error).message));
    } finally {
      seedBtn.disabled = resetBtn.disabled = false;
    }
  };

  void load();
  const timer = setInterval(() => void load(), 5000);
  onStop(() => clearInterval(timer));
};
