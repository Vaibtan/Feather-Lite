/** Feather-Lite operator console — hash router + nav; no framework, no build-time state. */
import { api } from "./api.js";
import { clear, h } from "./dom.js";
import { callView } from "./views/call.js";
import { conversationsView, detailView } from "./views/conversations.js";
import { scenariosView } from "./views/scenarios.js";
import { qualityView } from "./views/quality.js";
import { simulateView } from "./views/simulate.js";
import { statusView } from "./views/status.js";

type View = (root: HTMLElement, onStop: (fn: () => void) => void) => void;

const ROUTES: Array<{ pattern: RegExp; view: (m: RegExpMatchArray) => View; nav?: string }> = [
  { pattern: /^#\/conversations\/([0-9a-f-]{36})$/i, view: (m) => (root, onStop) => detailView(root, m[1]!, onStop), nav: "#/conversations" },
  { pattern: /^#\/conversations$/, view: () => conversationsView, nav: "#/conversations" },
  { pattern: /^#\/simulate$/, view: () => simulateView, nav: "#/simulate" },
  { pattern: /^#\/call$/, view: () => callView, nav: "#/call" },
  { pattern: /^#\/quality$/, view: () => qualityView, nav: "#/quality" },
  { pattern: /^#\/scenarios$/, view: () => scenariosView, nav: "#/scenarios" },
  { pattern: /^#\/status$/, view: () => statusView, nav: "#/status" },
];

const NAV: Array<[string, string]> = [
  ["#/conversations", "Conversations"],
  ["#/simulate", "Simulate"],
  ["#/call", "Live call"],
  ["#/quality", "Quality"],
  ["#/scenarios", "Scenarios"],
  ["#/status", "Status"],
];

const app = document.getElementById("app")!;
const navLinks = NAV.map(([href, label]) => h("a", { href }, label));
const pills = h("div", { class: "status" });
const main = h("main");
app.append(
  h("nav", { class: "side" }, h("div", { class: "brand" }, "Feather-Lite", h("small", {}, "console")), ...navLinks, pills),
  main,
);

let stop: (() => void) | null = null;

const route = () => {
  const hash = location.hash || "#/conversations";
  const match = ROUTES.map((r) => ({ r, m: hash.match(r.pattern) })).find((x) => x.m);
  if (!match || !match.m) {
    location.hash = "#/conversations";
    return;
  }
  stop?.();
  stop = null;
  for (const a of navLinks) a.classList.toggle("active", a.getAttribute("href") === match.r.nav);
  clear(main);
  const view = match.r.view(match.m);
  view(main, (fn) => (stop = fn));
};

const refreshPills = async () => {
  try {
    const s = await api.status();
    const online = s.agents.filter((a) => a.online).length;
    clear(pills);
    pills.append(
      h("div", {}, h("span", { class: "dot on" }), "API up"),
      h("div", {}, h("span", { class: `dot ${s.database === "ok" ? "on" : "off"}` }), `DB ${s.database}`),
      h("div", {}, h("span", { class: `dot ${online ? "on" : "off"}` }), online ? `${online} agent worker${online > 1 ? "s" : ""}` : "no agent worker"),
      h("div", { class: "mono" }, `decider: ${s.turn_decider}`),
    );
  } catch {
    clear(pills);
    pills.append(h("div", {}, h("span", { class: "dot off" }), "API unreachable"), h("a", { href: "#/status" }, "configure →"));
  }
};

window.addEventListener("hashchange", route);
route();
void refreshPills();
setInterval(() => void refreshPills(), 7000);
