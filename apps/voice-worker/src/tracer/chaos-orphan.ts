/**
 * Kill the voice worker mid-call and assert the ledger recovers by itself: the sweeper finalizes
 * the call as FAILED / ORPHANED and the borrower is callable again.
 *
 * Semi-automated on purpose — killing the job processes is a machine-specific act; everything
 * after it is asserted. The target is autodetected; `--host` and `--container` force it.
 *
 *   pnpm --filter @feather-lite/voice-worker chaos-orphan
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { initializeLogger } from "@livekit/agents";
import { abandonAfterFirstReplyScript, loadScriptedLines, runScriptedCall } from "./scripted-call.js";
import { harnessJsonHeaders } from "@feather-lite/load-test/harness-http";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
initializeLogger({ pretty: true, level: "warn" });

const t0 = Date.now();
const log = (m: string) => console.log(`[chaos] +${String(Date.now() - t0).padStart(6)}ms ${m}`);

const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const BORROWER_NAME = process.env["TRACER_BORROWER"] ?? "Jordan Avery";
/** ORPHAN_MISSED_HEARTBEATS x interval (30 s) + one sweep (10 s), plus slack for a busy laptop. */
const WAIT_FOR_SWEEP_MS = Number(process.env["CHAOS_WAIT_MS"] ?? 90_000);

const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, { headers: harnessJsonHeaders() });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
};

/**
 * Autodetected, because the deployed worker lives in its own PID namespace: a probe that
 * enumerates host PIDs against the containerised stack finds nothing, kills nothing, and then
 * asserts a recovery from an orphaning that never happened.
 */
const WORKER_CONTAINER = process.env["CHAOS_WORKER_CONTAINER"] ?? "feather-lite-worker";
const containerIsUp = (): boolean => {
  try {
    return execFileSync("docker", ["ps", "--filter", `name=^/${WORKER_CONTAINER}$`, "--format", "{{.Names}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === WORKER_CONTAINER;
  } catch {
    return false; // no docker on the box: there is nothing to be in a container
  }
};
const target: "host" | "container" = process.argv.includes("--host") ? "host" : process.argv.includes("--container") || containerIsUp() ? "container" : "host";

/**
 * `node -e` rather than `pkill`: the runtime image has no `procps`, and adding a package so a test
 * can kill things in it would be the test changing what it measures. `job_proc_lazy_main` is the
 * framework's own fork entry, and it survives the bundle because `@livekit/agents` stays external.
 */
const killContainerJobs = (): number => {
  const script = [
    "const fs = require('node:fs');",
    "let n = 0;",
    "for (const p of fs.readdirSync('/proc')) {",
    "  if (!/^[0-9]+$/.test(p) || Number(p) === process.pid) continue;",
    "  try {",
    "    if (!fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').includes('job_proc_lazy_main')) continue;",
    "    process.kill(Number(p), 'SIGKILL');",
    "    n++;",
    "  } catch { /* gone, or not ours */ }",
    "}",
    "console.log(n);",
  ].join("");
  try {
    const out = execFileSync("docker", ["exec", WORKER_CONTAINER, "node", "--input-type=commonjs", "-e", script], { encoding: "utf8" });
    /**
     * The last line, not the whole of stdout: any banner or warning printed before the count makes
     * `Number(out.trim())` `NaN`, so the probe reports killing nothing and then asserts a recovery.
     */
    const lastLine = out.trim().split(/\r?\n/).at(-1) ?? "";
    const killed = Number(lastLine.trim());
    if (!Number.isInteger(killed)) {
      log(`could not read the kill count from ${WORKER_CONTAINER}; stdout ended with ${JSON.stringify(lastLine.slice(0, 80))}`);
      return 0;
    }
    return killed;
  } catch (e) {
    log(`could not kill job processes inside ${WORKER_CONTAINER}: ${String(e)}`);
    return 0;
  }
};

/**
 * Only the job processes — the ones serving calls — which is what a crashed job looks like.
 * Matching on the agent entry file is what distinguishes them from this script and every other node.
 */
const killWorkerJobs = (): number => {
  if (target === "container") return killContainerJobs();
  const isWindows = process.platform === "win32";
  try {
    if (isWindows) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          // `job_proc_lazy_main`, not `src/agent.ts`: that is the dev-mode entry, and under `start`
          // the worker runs `dist/agent.js` with job children re-executing the framework's fork entry.
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*job_proc_lazy_main*' } | Select-Object -ExpandProperty ProcessId",
        ],
        { encoding: "utf8" },
      );
      const pids = out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      return pids.length;
    }
    const out = execFileSync("bash", ["-lc", "pgrep -f 'job_proc_lazy_main' || true"], { encoding: "utf8" });
    const pids = out.split(/\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return pids.length;
  } catch (e) {
    log(`could not enumerate worker processes: ${String(e)}`);
    return 0;
  }
};

interface Detail {
  conversation: { id: string; final_outcome: string | null; ended_at: string | null; borrower_id: string };
  event_timeline: Array<{ type: string; payload: Record<string, unknown> }>;
}

log(`control plane=${CONTROL_PLANE_URL} livekit=${process.env["LIVEKIT_URL"] ?? "(unset)"}`);
log(`chaos target=${target}${target === "container" ? ` (${WORKER_CONTAINER})` : " (host processes)"}`);
const lines = await loadScriptedLines();
log(`borrower lines ready (${lines.cached ? "WAV cache" : "synthesised"})`);

// The killer runs only once the agent has spoken: killing before that orphans nothing.
let killed = 0;
let conversationId: string | null = null;
const call = await runScriptedCall({
  lines,
  controlPlaneUrl: CONTROL_PLANE_URL,
  borrowerName: BORROWER_NAME,
  participantIdentity: "borrower-chaos",
  label: "chaos",
  log,
  script: abandonAfterFirstReplyScript(() => {
    killed = killWorkerJobs();
    log(`killed ${killed} worker process(es) mid-call`);
  }),
});
conversationId = call.conversationId;

if (!conversationId) {
  log("no conversation id; cannot assert. FAIL");
  process.exit(1);
}
if (killed === 0) {
  log(
    target === "container"
      ? `no job process was killed inside ${WORKER_CONTAINER} — is the worker container serving this call? FAIL`
      : "no host worker process was killed — is a native worker running, or is it in a container (drop --host)? FAIL",
  );
  process.exit(1);
}

log(`conversation ${conversationId} abandoned; waiting up to ${Math.round(WAIT_FOR_SWEEP_MS / 1000)}s for the sweeper...`);
const abandonedAt = Date.now();
let detail: Detail | null = null;
for (;;) {
  detail = await getJson<Detail>(`/api/conversations/${conversationId}`);
  if (detail.conversation.final_outcome !== null) break;
  if (Date.now() - abandonedAt > WAIT_FOR_SWEEP_MS) {
    log(`still open after ${Math.round((Date.now() - abandonedAt) / 1000)}s: the sweeper did not finalize it. FAIL`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

const finalisedInMs = Date.now() - abandonedAt;
const hangup = detail.event_timeline.find((e) => e.type === "CALL_CONTROL" && e.payload["action"] === "HANGUP");
const scores = await getJson<Array<{ name: string; value: number }>>(`/api/conversations/${conversationId}/scores`);
const detect = scores.find((s) => s.name === "system.orphan_detect_ms");

log(`finalized after ${Math.round(finalisedInMs / 1000)}s (wall clock from the kill)`);
log(`  final_outcome   ${String(detail.conversation.final_outcome)}`);
log(`  hangup reason   ${String(hangup?.payload["reason"] ?? "(no HANGUP event)")}`);
log(`  detect score    ${detect ? `${Math.round(detect.value)}ms` : "(missing)"}`);

const failures: string[] = [];
if (detail.conversation.final_outcome !== "FAILED") failures.push(`expected FAILED, got ${String(detail.conversation.final_outcome)}`);
if (hangup?.payload["reason"] !== "ORPHANED") failures.push(`expected hangup reason ORPHANED, got ${String(hangup?.payload["reason"])}`);
if (!detect) failures.push("no system.orphan_detect_ms score was written");

const retry = await fetch(`${CONTROL_PLANE_URL}/api/calls/start`, {
  method: "POST",
  headers: harnessJsonHeaders(),
  body: JSON.stringify({ borrower_id: detail.conversation.borrower_id, contact_point_id: undefined, channel: "simulated" }),
}).catch(() => null);
if (retry && retry.status === 422) {
  const body = (await retry.text()).slice(0, 200);
  if (/ACTIVE_CONVERSATION/i.test(body)) failures.push("borrower is still blocked by an active conversation");
}
log(`  borrower re-callable  ${failures.some((f) => f.includes("blocked")) ? "no" : "yes"}`);

if (failures.length > 0) {
  for (const f of failures) log(`  MISMATCH: ${f}`);
  log("chaos (orphaned call): FAIL");
  process.exit(1);
}
log("chaos (orphaned call): PASS");
process.exit(0);
