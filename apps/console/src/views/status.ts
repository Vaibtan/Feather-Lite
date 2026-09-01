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
  const processCard = h("div", { class: "card" });
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
    h("h2", {}, "This process"),
    processCard,
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
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Status"), h("th", {}, "Mode"), h("th", {}, "Calls"), h("th", {}, "RSS"), h("th", {}, "Last seen"), h("th", {}, "Meta"))),
            h(
              "tbody",
              {},
              ...s.agents.map((a) => {
                /**
                 * The heartbeat's `meta` is free-form, and a job process sends a different shape
                 * from the main worker — so every field is read defensively and an absent one shows
                 * as a dash rather than as a zero. "dev" is called out because in that mode
                 * `loadThreshold` is Infinity: the worker can never report itself full, and every
                 * fleet number taken before 2026-08-27 was taken that way without anything saying so.
                 */
                const m = a.meta as Record<string, unknown>;
                const num = (k: string): number | null => (typeof m[k] === "number" ? (m[k] as number) : null);
                const production = typeof m["production"] === "boolean" ? (m["production"] as boolean) : null;
                const active = num("active_jobs");
                const max = num("max_jobs");
                const load = num("load");
                const rss = num("rss_mb");
                return h(
                  "tr",
                  {},
                  h("td", { class: "mono" }, a.agent_name),
                  h("td", {}, h("span", { class: `dot ${a.online ? "on" : "off"}` }), a.online ? "online" : "offline"),
                  h("td", {}, production === null ? h("span", { class: "muted small" }, "—") : badge(production ? "production" : "dev · no load shedding", production ? "good" : "warn")),
                  h("td", { class: "small" }, active === null || max === null ? "—" : `${active}/${max}${load === null ? "" : ` (load ${load.toFixed(2)})`}`),
                  h("td", { class: "small" }, rss === null ? "—" : `${rss} MB`),
                  h("td", {}, ago(a.last_seen_at)),
                  h("td", { class: "small mono" }, JSON.stringify(m)),
                );
              }),
            ),
          ),
        );
      clear(ledger);
      const g = s.ledger.guardrails;
      const caught = (g["TOOL_REJECTED"] ?? 0) + (g["TURN_DECISION_REJECTED"] ?? 0);
      const kv = (o: Record<string, number>, empty: string) =>
        Object.keys(o).length ? h("dl", { class: "kv" }, ...Object.entries(o).flatMap(([k, v]) => [h("dt", { class: "mono" }, k), h("dd", {}, String(v))])) : h("div", { class: "muted small" }, empty);
      ledger.append(
        // "All time" said out loud (O10): these are every call ever made, unlike the Quality page's
        // counts, which describe whatever window is selected there.
        h("div", { class: "card" }, h("h3", {}, `Outcomes · all time · ${s.ledger.conversations_total} conversations`), kv(s.ledger.outcomes, "no conversations yet")),
        h("div", { class: "card" }, h("h3", {}, "Guardrails (all time)"), h("div", { style: "font-size:22px;font-weight:600;margin-bottom:6px" }, String(caught), h("span", { class: "muted small", style: "font-weight:400" }, " model suggestions rejected by the state machine")), kv({ TOOL_REJECTED: g["TOOL_REJECTED"] ?? 0, TURN_DECISION_REJECTED: g["TURN_DECISION_REJECTED"] ?? 0, TURN_SUPERSEDED: g["TURN_SUPERSEDED"] ?? 0 }, "")),
        h("div", { class: "card" }, h("h3", {}, "Volume (all time)"), kv({ USER_TURN_FINAL: g["USER_TURN_FINAL"] ?? 0, TOOL_CALLED: g["TOOL_CALLED"] ?? 0, STATE_TRANSITION: g["STATE_TRANSITION"] ?? 0 }, "")),
        // Load this server shed, apart from load that failed (O9). A tier-1 run 429ed 92 times
        // reported "23/50 correct" and moved nothing on this page, so a self-inflicted refusal was
        // indistinguishable from a broken agent. Zeroes here are the answer to "is it me?".
        h(
          "div",
          { class: "card" },
          h("h3", {}, "Shed by rate limiting"),
          h(
            "div",
            { style: "font-size:22px;font-weight:600;margin-bottom:6px" },
            String(s.rate_limiting.rejected_start + s.rate_limiting.rejected_turn + s.rate_limiting.rejected_daily_cap),
            h("span", { class: "muted small", style: "font-weight:400" }, ` requests refused by this process, not by a vendor`),
          ),
          kv(
            {
              starts: s.rate_limiting.rejected_start,
              turns: s.rate_limiting.rejected_turn,
              "daily cap": s.rate_limiting.rejected_daily_cap,
              "limit/min": s.rate_limiting.per_minute,
              "ip buckets": s.rate_limiting.buckets,
            },
            "",
          ),
        ),
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
      clear(processCard);
      // The operator's half of D3; the scraper's half is the same numbers at GET /metrics. Loop
      // liveness leads because it is the one row that can be *wrong* in a way nothing else shows:
      // a process with a dead outbox serves this page perfectly.
      const p = s.process;
      const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
      const stale = p.loops.filter((l) => l.stale);
      processCard.append(
        h(
          "div",
          { class: "row", style: "align-items:center;gap:10px;margin-bottom:10px" },
          badge(stale.length === 0 ? "LOOPS ALIVE" : "LOOP STOPPED", stale.length === 0 ? "good" : "bad"),
          h(
            "span",
            { class: "muted small" },
            p.loops.length === 0
              ? "no background loop has reported a tick yet"
              : stale.length > 0
                ? `${stale.map((l) => l.name).join(", ")} — /readyz is failing`
                : p.loops.map((l) => `${l.name} ${ago(l.last_tick_at ?? "")}`).join(" · "),
          ),
        ),
        h(
          "div",
          { class: "row", style: "gap:22px;flex-wrap:wrap" },
          // Lateness beyond the 20 ms sampling floor, so 0 means the loop is keeping up rather
          // than meaning the measurement is broken.
          metric("event-loop delay", `${p.event_loop_delay_ms.p99.toFixed(1)} ms`, `p99 over the floor · p50 ${p.event_loop_delay_ms.p50.toFixed(1)} ms`),
          metric("resident memory", mb(p.memory_bytes.rss), `heap ${mb(p.memory_bytes.heap_used)} of ${mb(p.memory_bytes.heap_total)}`),
          metric("CPU", `${(p.cpu_seconds.user + p.cpu_seconds.system).toFixed(1)} s`, `over ${p.uptime_seconds} s up · ${(((p.cpu_seconds.user + p.cpu_seconds.system) / Math.max(1, p.uptime_seconds)) * 100).toFixed(0)}% of one core`),
          metric("GC", `${p.gc.total_pause_ms.toFixed(0)} ms`, `paused over ${p.gc.collections} collection(s)`),
          // Waiting is the number that diagnosed the 2026-08-21 pool experiment; a pool that is
          // never waited on is not the constraint, whatever its size.
          metric("pg pool", p.pg_pool === null ? "—" : `${p.pg_pool.size - p.pg_pool.idle}/${p.pg_pool.size}`, p.pg_pool === null ? "no database in this process" : `in use · ${p.pg_pool.waiting} waiting`),
          metric("in flight", String(p.live_turns), `retained turns · ${p.sse_streams} SSE stream(s) · ${p.rate_limit_buckets} ip bucket(s)`),
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
          // Three states, three badges. "SLO MET" over a window where nothing was measured was the
          // most flattering thing this page could say, and it said it on a fresh database.
          badge(s.slo.verdict === "pass" ? "SLO MET" : s.slo.verdict === "breach" ? "SLO BREACHED" : "NOT ENOUGH DATA", s.slo.verdict === "pass" ? "good" : s.slo.verdict === "breach" ? "bad" : "muted"),
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
