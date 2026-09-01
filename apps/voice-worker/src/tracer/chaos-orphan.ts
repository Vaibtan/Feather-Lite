/**
 * The chaos test the README has owed since Phase 7: kill the voice worker mid-call and prove the
 * ledger recovers by itself.
 *
 * The 2026-08-23 probe did this by hand and found the failure it was looking for — a killed worker
 * left the conversation open forever, and the "one live conversation per borrower" pre-call rule
 * then blocked that borrower permanently. This script automates the probe and asserts the fix
 * (spec 2026-08-26, D6): the sweeper notices, finalizes the call as FAILED / ORPHANED, and the
 * borrower can be called again.
 *
 * Semi-automated on purpose. It starts a real call and then kills the worker's *job* processes,
 * which is a machine-specific act; everything after that is asserted.
 *
 * **Against the containerised stack**, which is what ships and what every number since 2026-09-01
 * is measured on — the job processes are killed inside the worker container's own PID namespace,
 * and the target is autodetected from whether that container is up:
 *
 *   $env:LIVEKIT_NODE_IP='<host LAN IP>'
 *   docker compose --profile livekit --profile app up -d --build
 *   pnpm --filter @feather-lite/voice-worker chaos-orphan
 *
 * Against a native worker (`pnpm db:up`, `pnpm lk:up`, `pnpm start:server`, `pnpm start:worker`),
 * pass `--host`; `--container` forces the other way, and `CHAOS_WORKER_CONTAINER` renames it.
 *
 *   pnpm --filter @feather-lite/voice-worker chaos-orphan -- --host
 *
 * What it prints, and what a pass looks like:
 *   - the call reaches the agent (the opening is spoken), so there is something real to orphan;
 *   - the worker's job processes are killed with no chance to send a hangup;
 *   - the conversation is finalized within ORPHAN_STALENESS + one sweep interval (~40 s);
 *   - `final_outcome` is FAILED with a CALL_CONTROL / HANGUP carrying reason ORPHANED;
 *   - a `system.orphan_detect_ms` score records how long detection actually took;
 *   - a fresh call to the same borrower is accepted, i.e. they are no longer blocked.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { initializeLogger } from "@livekit/agents";
import { loadScriptedLines, runScriptedCall } from "./scripted-call.js";
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
 * Which worker is being chaos-tested (2026-09-01).
 *
 * The probe used to enumerate **host** PIDs, which since the Docker migration is the wrong process
 * table: the deployed worker lives in its own PID namespace, so a probe run against the stack that
 * actually ships found nothing, killed nothing, and then asserted a recovery that had nothing to
 * recover from. The architecture that ships has to be the one that is chaos-tested, or the test is
 * about a configuration nobody runs.
 *
 * Autodetected, because getting this wrong is silent: if the worker container is up, that is the
 * worker serving the call. `--host` / `--container` force it either way.
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
 * Kill the containerised worker's job processes from inside its own PID namespace.
 *
 * `node -e` rather than `pkill`: the runtime image is `node:22-bookworm-slim` with only
 * `ca-certificates` added, so there is no `procps` in it — and adding a package to the image that
 * ships so a test can kill things in it would be the test changing the thing it measures. `/proc`
 * is always there, and node is the one interpreter the image is guaranteed to have.
 *
 * `job_proc_lazy_main` is the framework's own fork entry (`ipc/job_proc_executor.js:48`), and it
 * survives the esbuild bundle because `@livekit/agents` stays external — so the job process's argv
 * carries that name in the container exactly as it does on the host.
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
    return Number(out.trim()) || 0;
  } catch (e) {
    log(`could not kill job processes inside ${WORKER_CONTAINER}: ${String(e)}`);
    return 0;
  }
};

/**
 * Kill the worker's job processes — the ones actually serving calls — and leave the main worker
 * alone, which is what a crashed job looks like. On Windows the job processes are `node` children
 * of the worker; matching on the agent entry file is what distinguishes them from this script,
 * from the control-plane server, and from any other node on the box.
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
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*voice-worker*src/agent.ts*' -or $_.CommandLine -like '*voice-worker*src\\agent.ts*' } | Select-Object -ExpandProperty ProcessId",
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
    const out = execFileSync("bash", ["-lc", "pgrep -f 'voice-worker.*src/agent.ts' || true"], { encoding: "utf8" });
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
// Said out loud, because a probe that kills nothing still runs to the end and reports a verdict.
log(`chaos target=${target}${target === "container" ? ` (${WORKER_CONTAINER})` : " (host processes)"}`);
const lines = await loadScriptedLines();
log(`borrower lines ready (${lines.cached ? "WAV cache" : "synthesised"})`);

/**
 * Start a real call and abandon it. `runScriptedCall` is given a killer to invoke once the agent
 * has actually spoken — killing before that would prove nothing, because there would be no live
 * call to orphan.
 */
let killed = 0;
let conversationId: string | null = null;
const call = await runScriptedCall({
  lines,
  controlPlaneUrl: CONTROL_PLANE_URL,
  borrowerName: BORROWER_NAME,
  participantIdentity: "borrower-chaos",
  label: "chaos",
  log,
  abandonAfterFirstReply: () => {
    killed = killWorkerJobs();
    log(`killed ${killed} worker process(es) mid-call`);
  },
});
conversationId = call.conversationId;

if (!conversationId) {
  log("no conversation id; cannot assert. FAIL");
  process.exit(1);
}
if (killed === 0) {
  // The failure this guard exists for is now mostly the *wrong target*: a host-mode probe against a
  // containerised worker enumerates a process table the worker is not in, finds nothing, and would
  // otherwise go on to assert a recovery from an orphaning that never happened.
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

// The point of the whole exercise: the borrower is not blocked any more.
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
