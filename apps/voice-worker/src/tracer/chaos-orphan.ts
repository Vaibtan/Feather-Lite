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
 * which is a machine-specific act; everything after that is asserted. Run it with the stack up
 * (`pnpm db:up`, `pnpm lk:up`, `pnpm dev:server`, `pnpm dev:worker`):
 *
 *   pnpm --filter @feather-lite/voice-worker chaos-orphan
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
 * Kill the worker's job processes — the ones actually serving calls — and leave the main worker
 * alone, which is what a crashed job looks like. On Windows the job processes are `node` children
 * of the worker; matching on the agent entry file is what distinguishes them from this script,
 * from the control-plane server, and from any other node on the box.
 */
const killWorkerJobs = (): number => {
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
  log("no worker process was killed — is `pnpm dev:worker` running? FAIL");
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
