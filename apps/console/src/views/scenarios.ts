/**
 * Scenarios: the SPEC §10 regression matrix, runnable from the browser (scripted decider, no LLM).
 * Each row shows the expected vs actual state path, tools and call-control actions.
 */
import { api, type ScenarioRun, type ScenarioSummary } from "../api.js";
import { badge, clear, h } from "../dom.js";

export const scenariosView = (root: HTMLElement, onStop: (fn: () => void) => void) => {
  clear(root);
  const tbody = h("tbody");
  const summary = h("span", { class: "muted small" });
  const runAllBtn = h("button", { class: "btn primary", onClick: () => void runAll() }, "Run all");
  root.append(
    h("h1", {}, "Scenario regression matrix"),
    h("p", { class: "muted small", style: "margin:-6px 0 12px" }, "Deterministic replays through the real orchestrator (scripted decider, frozen clock). Each run writes a real conversation you can open."),
    h("div", { class: "row", style: "margin-bottom:10px" }, runAllBtn, summary),
    h("div", { class: "card" }, h("table", { class: "matrix" }, h("thead", {}, h("tr", {}, h("th", {}, "Scenario"), h("th", {}, "Result"), h("th", {}, "State path"), h("th", {}, "Tools / call control"), h("th", {}, "Outcome"), h("th", {}, ""))), tbody)),
  );

  const results = new Map<string, ScenarioRun>();
  const rows = new Map<string, HTMLTableRowElement>();
  let list: ScenarioSummary[] = [];

  const pathCell = (r: ScenarioRun | undefined) => {
    if (!r) return h("span", { class: "muted small" }, "—");
    const same = JSON.stringify(r.expected_state_path) === JSON.stringify(r.actual_state_path);
    return h("div", { class: "small mono" }, h("div", {}, r.actual_state_path.join(" → ")), same ? null : h("div", { class: "err" }, `expected ${r.expected_state_path.join(" → ")}`));
  };
  const toolsCell = (r: ScenarioRun | undefined) => {
    if (!r) return h("span", { class: "muted small" }, "—");
    const parts = [r.actual_tools.length ? `tools: ${r.actual_tools.join(", ")}` : "tools: none"];
    if (r.actual_call_control_actions.length) parts.push(`call control: ${r.actual_call_control_actions.join(", ")}`);
    return h("div", { class: "small mono" }, ...parts.map((p) => h("div", {}, p)), ...r.assertion_failures.map((f) => h("div", { class: "err" }, f)));
  };

  const render = (s: ScenarioSummary) => {
    const r = results.get(s.scenario_id);
    const tr = h(
      "tr",
      {},
      h("td", {}, h("div", { class: "mono" }, s.scenario_id), h("div", { class: "muted small" }, s.description)),
      h("td", { class: r ? (r.passed ? "pass" : "fail") : "" }, r ? (r.passed ? "PASS" : "FAIL") : h("span", { class: "muted" }, "not run"), r ? h("div", { class: "muted small" }, `${r.duration_ms} ms`) : null),
      h("td", {}, pathCell(r)),
      h("td", {}, toolsCell(r)),
      h("td", {}, r ? badge(r.final_outcome) : h("span", { class: "muted" }, "—"), r && r.final_outcome !== r.expected_final_outcome ? h("div", { class: "err small" }, `expected ${String(r.expected_final_outcome)}`) : null),
      h("td", {}, h("div", { class: "row" }, h("button", { class: "btn", onClick: () => void runOne(s.scenario_id) }, "Run"), r ? h("a", { href: `#/conversations/${r.conversation_id}` }, "open") : null)),
    );
    const prev = rows.get(s.scenario_id);
    if (prev) prev.replaceWith(tr);
    else tbody.append(tr);
    rows.set(s.scenario_id, tr);
  };

  const updateSummary = () => {
    const runs = [...results.values()];
    if (!runs.length) {
      summary.textContent = `${list.length} scenarios`;
      return;
    }
    const passed = runs.filter((r) => r.passed).length;
    summary.textContent = `${passed}/${runs.length} passed · ${runs.length}/${list.length} run`;
    summary.className = passed === runs.length ? "small" : "small err";
  };

  const runOne = async (id: string) => {
    const s = list.find((x) => x.scenario_id === id);
    if (!s) return;
    try {
      const r = await api.runScenario(id);
      results.set(id, r);
      render(s);
      updateSummary();
    } catch (e) {
      const tr = rows.get(id);
      if (tr) tr.append(h("td", { class: "err small", colspan: "6" }, (e as Error).message));
    }
  };

  const runAll = async () => {
    runAllBtn.disabled = true;
    summary.textContent = "running…";
    try {
      const rs = await api.runAll();
      for (const r of rs) results.set(r.scenario_id, r);
      for (const s of list) render(s);
      updateSummary();
    } catch (e) {
      summary.textContent = `run-all failed: ${(e as Error).message}`;
      summary.className = "small err";
    } finally {
      runAllBtn.disabled = false;
    }
  };

  void (async () => {
    try {
      list = await api.scenarios();
      for (const s of list) render(s);
      updateSummary();
    } catch (e) {
      tbody.append(h("tr", {}, h("td", { colspan: "6", class: "err" }, `Failed to load scenarios: ${(e as Error).message}`)));
    }
  })();
  onStop(() => undefined);
};
