/**
 * Does the worker actually refuse the call past its ceiling? (ADR 0010 D2, review #1.)
 *
 * **The previous probe could not tell.** It created its rooms over separate HTTP calls, so the
 * first job had already reached `activeJobs` before the second request arrived — and "one served,
 * two refused" follows from the stale `activeJobs` count alone, with the admission window deleted.
 * The window this probe exists to measure is the ~1.8 s between the accept and `launchJob`, and the
 * only way to be inside it for all three requests is to make all three requests at once.
 *
 * So: N sessions created in **one batch** (`Promise.all`, no awaits between them) against a worker
 * started with `WORKER_MAX_JOBS=1`. Expected: one call served, the rest never claimed by any worker
 * and finalized `NEVER_SERVED` by the sweeper about 38 seconds later — the O4 distinction (a call
 * that never had a worker, as against one that lost hers) firing on real shed load.
 *
 * A refused call is not a lost call and not a bug: it is the honest record of a worker saying no.
 *
 * Run it against the **containerised** worker, which is the stack that ships and is measured. The
 * ceiling has to be set when the container is created, because `.env` is read once at boot and does
 * not reach a container the way it reaches a native process:
 *
 *   $env:LIVEKIT_NODE_IP='<host LAN IP>'; $env:WORKER_MAX_JOBS='1'
 *   docker compose --profile livekit --profile app up -d
 *   pnpm --filter @feather-lite/voice-worker shed-probe -- --calls 3
 *
 * Against a native worker instead: `WORKER_MAX_JOBS=1 pnpm start:worker`, then the same probe.
 *
 * One caveat either way: `WORKER_MAX_JOBS` is the **denominator of the load** the worker reports,
 * and the SFU stops assigning at `WORKER_LOAD_THRESHOLD` — so the concurrency actually served is
 * lower than the ceiling, and at `--calls 3` against a ceiling of 1 that difference does not matter
 * but at ten calls it decides the run (docs/loadtest/README.md, 2026-09-01).
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { harnessJsonHeaders } from "@feather-lite/load-test/harness-http";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const flag = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
};

const CALLS = Number(flag("calls", "3"));
/** The sweeper finalizes an unclaimed call about 38 s in; a little past that is the whole wait. */
const WAIT_MS = Number(flag("wait", "75000"));
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");

const t0 = Date.now();
const log = (m: string) => console.log(`[shed] +${String(Date.now() - t0).padStart(6)}ms ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const status = (await (await fetch(`${CONTROL_PLANE_URL}/api/system/status`, { headers: harnessJsonHeaders() })).json()) as {
  agents: Array<{ online: boolean; meta: Record<string, unknown> }>;
};
const worker = status.agents.filter((a) => a.online).map((a) => a.meta).find((m) => typeof m["production"] === "boolean");
log(`worker: max_jobs=${String(worker?.["max_jobs"] ?? "?")} production=${String(worker?.["production"] ?? "?")} idle=${String(worker?.["idle_processes"] ?? "?")}`);
if (worker === undefined) {
  console.error("[shed] no online worker is reporting. Start one with `WORKER_MAX_JOBS=1 pnpm start:worker`.");
  process.exit(1);
}
if (worker["max_jobs"] !== 1) log(`note: max_jobs is ${String(worker["max_jobs"])}, so expect ${String(worker["max_jobs"])} served rather than 1`);

const fixturesRes = await fetch(`${CONTROL_PLANE_URL}/api/demo/load-fixtures`, {
  method: "POST",
  headers: harnessJsonHeaders(),
  body: JSON.stringify({ count: CALLS, prefix: `shed-${Date.now().toString(36)}` }),
});
if (!fixturesRes.ok) throw new Error(`load-fixtures ${String(fixturesRes.status)}: ${await fixturesRes.text()}`);
const fixtures = (await fixturesRes.json()) as Array<{ borrower_id: string; contact_point_id: string }>;
log(`minted ${String(fixtures.length)} fixture(s)`);

/**
 * One batch. No `await` between the requests, which is the entire point: the requests have to
 * reach the worker inside one another's admission window, and a loop with an await in it cannot
 * produce that however fast the loop is.
 */
const started = await Promise.all(
  fixtures.map(async (f) => {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/voice/sessions`, {
      method: "POST",
      headers: harnessJsonHeaders(),
      body: JSON.stringify({ borrower_id: f.borrower_id, contact_point_id: f.contact_point_id, participant_identity: `shed-${f.borrower_id.slice(0, 8)}`, mode: "browser" }),
    });
    if (!res.ok) return { conversationId: null as string | null, error: `${String(res.status)}: ${(await res.text()).slice(0, 200)}` };
    return { conversationId: ((await res.json()) as { conversation_id: string }).conversation_id, error: null as string | null };
  }),
);
log(`created ${String(started.filter((s) => s.conversationId).length)} session(s) in one batch`);

log(`waiting ${String(Math.round(WAIT_MS / 1000))}s for the sweeper to finalize whatever nobody claimed...`);
await sleep(WAIT_MS);

const outcomes = await Promise.all(
  started.map(async (s) => {
    if (!s.conversationId) return { conversationId: null, outcome: "NOT_STARTED", reason: s.error };
    const res = await fetch(`${CONTROL_PLANE_URL}/api/conversations/${s.conversationId}`, { headers: harnessJsonHeaders() });
    if (!res.ok) return { conversationId: s.conversationId, outcome: `HTTP_${String(res.status)}`, reason: null };
    const detail = (await res.json()) as {
      conversation: { final_outcome: string | null; current_state: string };
      event_timeline: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    // The sweeper's verdict rides the hangup it issues, not a separate event.
    const finalized = detail.event_timeline.findLast((e) => e.type === "CALL_CONTROL" && e.payload["action"] === "HANGUP");
    return {
      conversationId: s.conversationId,
      outcome: detail.conversation.final_outcome ?? detail.conversation.current_state,
      reason: (finalized?.payload["reason"] as string | undefined) ?? null,
    };
  }),
);

const neverServed = outcomes.filter((o) => o.reason === "NEVER_SERVED").length;
const served = outcomes.filter((o) => o.reason !== "NEVER_SERVED" && o.outcome !== "NOT_STARTED").length;
for (const o of outcomes) log(`  ${o.conversationId ?? "-"}  ${o.outcome}${o.reason ? ` (${o.reason})` : ""}`);
log(`served ${String(served)}, NEVER_SERVED ${String(neverServed)}, of ${String(CALLS)} started in one batch`);

/**
 * The probe discriminates when the surplus is refused. It does not assert *which* number is right —
 * that is `WORKER_MAX_JOBS` and the operator's — only that a ceiling of one did not serve three.
 */
process.exit(served <= Number(worker["max_jobs"] ?? 1) && neverServed === CALLS - served ? 0 : 1);
