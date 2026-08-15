/**
 * Status: API/DB/agent-worker health, decider mode, counters, plus the console's own settings
 * (API base URL, bearer token) and the demo seed/reset controls.
 */
import { api, apiBase, apiToken, setApiBase, setApiToken, type SystemStatus } from "../api.js";
import { ago, clear, h, pre } from "../dom.js";

export const statusView = (root: HTMLElement, onStop: (fn: () => void) => void) => {
  clear(root);
  const health = h("div", { class: "grid3" });
  const counters = h("div", { class: "card" });
  const agents = h("div", { class: "card" });
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
    h("h2", {}, "Counters"),
    counters,
    h("h2", {}, "Demo data"),
    h("div", { class: "card" }, h("div", { class: "row" }, seedBtn, resetBtn), h("div", { class: "muted small", style: "margin-top:6px" }, "Seed creates the five demo borrowers and a short call history. Reset wipes conversations, actions and outbox jobs for those borrowers and re-seeds."), seedOut),
    h("h2", {}, "Console settings"),
    h("div", { class: "card" }, h("div", { class: "kv" }, h("dt", {}, "API base"), h("dd", {}, baseInput), h("dt", {}, "Token"), h("dd", {}, tokenInput)), h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "btn primary", onClick: save }, "Save & reconnect"), h("span", { class: "muted small" }, "Also settable via ?api=<url> and #token=<token> in the URL."))),
  );

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
      clear(counters);
      counters.append(pre(s.counters));
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
