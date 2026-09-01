/**
 * Admission control for the worker: the half of load shedding the load function cannot do.
 *
 * **Why it exists.** `loadFunc` shapes what the *SFU* believes about this worker, and the SFU is
 * told only every 2.5 s (`UPDATE_LOAD_INTERVAL`), so a burst arriving inside one interval is routed
 * against a status that still says "idle". No threshold, however low, catches it, and the
 * framework's default `requestFunc` accepts whatever it is offered. Measured on 2026-08-28: with
 * `WORKER_MAX_JOBS=2` and three calls started together, all three were served. So the ceiling is
 * enforced here, where the answer is actually given.
 *
 * **Why it is not simply `activeJobs.length`.** `AgentServer.activeJobs` counts child processes that
 * have a `runningJob`, and that flag is set inside `launchJob` — *after* the accept has been sent
 * and after the SFU has answered with an assignment (`agents/dist/worker.js:643-690`). Between
 * those two points the job is this worker's responsibility and invisible to every count of it.
 * `admitting` is that window.
 *
 * **Why `accept()` is not awaited.** `JobRequest.accept()` calls the worker's `#onAccept` *without
 * awaiting it* (`agents/dist/job.js:468-471`), so the promise it returns resolves before the SFU
 * round trip has even started. An `await req.accept()` therefore decrements `admitting` in the same
 * microtask that incremented it, and `inFlight()` collapses back to the stale `activeJobs` this
 * module exists to replace — which is the defect the 2026-08-30 review found (#1) and which the
 * 2026-08-28 shed probe could not see, because its rooms were created over separate HTTP calls.
 *
 * So: fire the accept, then wait for the job to actually appear in `activeJobs`, or for the
 * assignment to time out. The SDK gives an assignment 7.5 s (`ASSIGNMENT_TIMEOUT`); the extra half
 * second is the launch itself.
 *
 * A rejected job is not a lost call. The conversation row stays open with no worker claim, and the
 * sweeper finalizes it as `NEVER_SERVED` — a call that never had a worker, distinct from one that
 * lost hers (O4). That is the honest record of shed load.
 *
 * Structural types rather than `JobRequest`/`AgentServer` so the decision is testable without the
 * SDK's websocket: `agent.ts` passes the real ones in.
 */

/** The part of `JobRequest` an admission decision needs. */
export interface AdmissionRequest {
  readonly id: string;
  readonly accept: () => Promise<void>;
  readonly reject: () => Promise<void>;
}

export interface AdmissionOptions {
  /** Hard ceiling on concurrent calls. */
  readonly maxJobs: number;
  /** Ids of the jobs the server is running now — `AgentServer.activeJobs.map((j) => j.job.id)`. */
  readonly activeJobIds: () => readonly string[];
  /** How long an accepted job has to appear in `activeJobIds()` before we stop holding its slot. */
  readonly assignmentTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string, extra: Record<string, unknown>) => void;
}

export interface AdmissionController {
  /** Pass this as `ServerOptions.requestFunc`. */
  readonly requestFunc: (req: AdmissionRequest) => Promise<void>;
  /** Accepted, not yet visible in `activeJobIds()`. Reported on the heartbeat. */
  readonly admitting: () => number;
  /** What the ceiling is compared against: running + admitting. */
  readonly inFlight: () => number;
  /**
   * Stop waiting on outstanding accepts, because the worker is going down.
   *
   * `AgentServer.close()` tears the process pool down and *then* awaits its outstanding tasks
   * (`agents/dist/worker.js:354-360`), and this poll is one of them. A job admitted in the last
   * few seconds before a SIGTERM can never reach `activeJobs` once the pool is gone, so without
   * this the shutdown would sit out the whole assignment timeout waiting for it.
   */
  readonly abandonWaits: () => void;
}

/** `ASSIGNMENT_TIMEOUT` in `agents/dist/worker.js:28` is 7.5 s; the rest is the launch. */
export const ASSIGNMENT_TIMEOUT_MS = 8_000;
/** Fine enough that the admitting window closes promptly, coarse enough to cost nothing. */
export const ASSIGNMENT_POLL_INTERVAL_MS = 25;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });

export const createAdmissionController = (options: AdmissionOptions): AdmissionController => {
  const { maxJobs, activeJobIds } = options;
  const assignmentTimeoutMs = options.assignmentTimeoutMs ?? ASSIGNMENT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ASSIGNMENT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => undefined);

  /**
   * The ids of jobs accepted and not yet seen running — a set, not a counter.
   *
   * A counter double-counts for up to one poll interval: measured live on 2026-09-01, a warm slot
   * put a job into `activeJobs` 26 ms after the accept, before the 25 ms poll had observed it, so
   * the next request read `running: 1, admitting: 1` for one job. Over-counting refuses early
   * rather than late, so it was never dangerous — but the ceiling is supposed to be exact, and a
   * union of ids is exact for the same three lines.
   */
  const admittingIds = new Set<string>();
  let abandoned = false;
  const inFlight = (): number => {
    const running = activeJobIds();
    return running.length + [...admittingIds].filter((id) => !running.includes(id)).length;
  };

  const requestFunc = async (req: AdmissionRequest): Promise<void> => {
    if (inFlight() >= maxJobs) {
      // The one line that must exist: a refused job is otherwise indistinguishable, from outside,
      // from a call the SFU never offered.
      // `in_flight` as well as its two parts, because they overlap: a job that has just reached
      // `activeJobs` is in both until the poll notices, and the decision is made on the union.
      log(`refusing job ${req.id}: at capacity`, { in_flight: inFlight(), running: activeJobIds().length, admitting: admittingIds.size, max_jobs: maxJobs });
      await req.reject();
      return;
    }
    admittingIds.add(req.id);
    const startedAt = now();
    try {
      // Deliberately not awaited — see the module comment. Errors inside `#onAccept` are caught by
      // the framework, but a synchronous throw here would otherwise be an unhandled rejection.
      void req.accept().catch((error: unknown) => log(`accept failed for job ${req.id}`, { error: String(error) }));
      while (!activeJobIds().includes(req.id)) {
        if (abandoned) {
          log(`stopped waiting on job ${req.id}: the worker is shutting down`, { waited_ms: now() - startedAt });
          return;
        }
        if (now() - startedAt >= assignmentTimeoutMs) {
          log(`job ${req.id} never reached activeJobs; releasing its slot`, { waited_ms: now() - startedAt });
          return;
        }
        await sleep(pollIntervalMs);
      }
    } finally {
      admittingIds.delete(req.id);
    }
  };

  return {
    requestFunc,
    admitting: () => admittingIds.size,
    inFlight,
    abandonWaits: () => {
      abandoned = true;
    },
  };
};
