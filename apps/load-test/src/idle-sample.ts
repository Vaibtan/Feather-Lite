/**
 * Idle-tree sample: what the server and the worker cost with nothing happening.
 *
 * This is the "before" every memory change in the spec is measured against (D1/D4), and it is the
 * `idle_rss_tree` term in `mb_per_call`. It is its own script rather than a mode of a harness
 * because taking it must not place a call: the number is only meaningful if the worker has warmed
 * its pool and then been left alone.
 *
 * Run (with the server and the worker already up, and the box quiet):
 *   pnpm loadtest:idle -- --seconds 30 --label start-mode
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatResourceReport, startResourceSampler } from "./resources.js";

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};

const SECONDS = Number(flag("seconds", "30"));
const LABEL = flag("label", "");
const REPORT_DIR = fileURLToPath(new URL("../../../docs/loadtest/", import.meta.url));

console.log(`[idle] sampling the idle tree for ${SECONDS}s${LABEL ? ` (label ${LABEL})` : ""}...`);

const sampler = startResourceSampler({ log: (m) => console.log(m) });
// The whole sample *is* the window here: an idle tree has no load phase to mark off.
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const resources = await sampler.stop();

console.log("");
console.log(formatResourceReport(resources));
console.log("");

const report = { kind: "idle-tree", label: LABEL || null, seconds: SECONDS, taken_at: new Date().toISOString(), resources };
mkdirSync(REPORT_DIR, { recursive: true });
const path = `${REPORT_DIR}${new Date().toISOString().slice(0, 10)}-idle-tree${LABEL ? `-${LABEL}` : ""}.json`;
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[idle] report written: ${path}`);

if (resources.samples === 0) {
  console.error("[idle] no samples were taken — the report is empty, not zero");
  process.exit(1);
}
