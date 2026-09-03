/**
 * `AgentServer.activeJobs` only counts a job once `launchJob` has set its `runningJob`, which is
 * after the accept and after the SFU's assignment; between those points a job is this worker's
 * responsibility and invisible to every count of it. `admitting` is that window, and the ceiling is
 * enforced here rather than in `loadFunc` because that only reaches the SFU every 2.5 s.
 */

export interface AdmissionRequest {
  readonly id: string;
  readonly accept: () => Promise<void>;
  readonly reject: () => Promise<void>;
}

export interface AdmissionOptions {
  readonly maxJobs: number;
  readonly activeJobIds: () => readonly string[];
  readonly assignmentTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string, extra: Record<string, unknown>) => void;
}

export interface AdmissionController {
  readonly requestFunc: (req: AdmissionRequest) => Promise<void>;
  readonly admitting: () => number;
  readonly inFlight: () => number;
  /**
   * `AgentServer.close()` tears the process pool down and *then* awaits its outstanding tasks, and
   * this poll is one of them; without abandoning, shutdown sits out the whole assignment timeout
   * waiting for a job that can no longer reach `activeJobs`.
   */
  readonly abandonWaits: () => void;
}

/** The SDK's `ASSIGNMENT_TIMEOUT` is 7.5 s; the rest is the launch. */
export const ASSIGNMENT_TIMEOUT_MS = 8_000;
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
   * A set of ids, not a counter: a warm slot put a job into `activeJobs` 26 ms after the accept,
   * inside one 25 ms poll, so a counter read `running: 1, admitting: 1` for a single job. A union
   * of ids is exact.
   */
  const admittingIds = new Set<string>();
  let abandoned = false;
  const inFlight = (): number => {
    const running = activeJobIds();
    return running.length + [...admittingIds].filter((id) => !running.includes(id)).length;
  };

  const requestFunc = async (req: AdmissionRequest): Promise<void> => {
    if (abandoned) {
      log(`refusing job ${req.id}: the worker is shutting down`, { in_flight: inFlight(), max_jobs: maxJobs });
      await req.reject();
      return;
    }
    if (inFlight() >= maxJobs) {
      log(`refusing job ${req.id}: at capacity`, { in_flight: inFlight(), running: activeJobIds().length, admitting: admittingIds.size, max_jobs: maxJobs });
      await req.reject();
      return;
    }
    admittingIds.add(req.id);
    const startedAt = now();
    try {
      // Not awaited: `JobRequest.accept()` calls the worker's `#onAccept` without awaiting it, so
      // awaiting here would clear `admitting` in the same microtask that set it.
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
