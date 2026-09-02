/**
 * The worker's numeric limits, parsed so that a typo cannot quietly remove one (review #18).
 *
 * `Math.max(1, Number(process.env["WORKER_MAX_JOBS"] ?? 8))` reads as defensive and is not.
 * `Number("eight")` is `NaN`, `Math.max(1, NaN)` is `NaN`, and the admission controller's
 * `inFlight() >= NaN` is **always false** — so a misspelled ceiling did not raise the ceiling, it
 * deleted it, and the worker went on accepting every call offered while the heartbeat reported the
 * limit as absent. That is the same class of lie the whole of Phase 0 existed to remove: an
 * instrument that reads "fine" precisely when it has stopped working.
 *
 * So the rule here is **fail closed at boot**. A limit the operator got wrong is a limit nobody has
 * decided, and a worker running without a decided ceiling is worse than a worker that did not
 * start: it takes calls it cannot serve and the failure lands on borrowers, minutes later and
 * somewhere else. Unset is different from wrong — unset is the documented default, and the default
 * is a real limit — so absence takes the fallback and only a value that was typed and cannot be
 * honoured stops the boot.
 *
 * Pure and separate from `agent.ts` because `agent.ts` cannot be imported by a test: it runs
 * `cli.runApp` at module scope and would try to register with an SFU.
 */

/** One numeric setting: what it is called in the environment, and what it will and will not take. */
export interface CountSpec {
  /** The environment variable's name, so a refusal names the thing the operator has to edit. */
  readonly name: string;
  /** The smallest meaningful value. Below it is a refusal, never a clamp. */
  readonly min: number;
  /** What "not set" means. A default is a decision; a typo is not. */
  readonly fallback: number;
  /** One clause saying what the number does, appended to the refusal. */
  readonly means: string;
}

export type ParsedCount = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string };

/**
 * How many calls this worker may carry at once. Minimum 1: a worker configured to carry no calls is
 * a worker that should not have been started, and it would look identical to a healthy idle one.
 */
export const MAX_JOBS: CountSpec = {
  name: "WORKER_MAX_JOBS",
  min: 1,
  fallback: 8,
  means: "the number of concurrent calls this worker admits",
};

/**
 * How many job processes are kept warm. Minimum 0, and 0 is a real setting — it is the one the
 * framework used to swallow (`numIdleProcesses || Default.numIdleProcesses(production)`,
 * `worker.js:167`), which is why `patches/@livekit__agents@1.6.4.patch` makes that `??`.
 *
 * The fallback is `min(WORKER_MAX_JOBS, 4)` — the framework's own production default, and never
 * more warm slots than there are calls to put in them — so it is filled in against the resolved
 * ceiling rather than written here. An **explicit** value above the ceiling is left as typed: it
 * only costs memory, and silently clamping what an operator wrote is how a compose file and a
 * running process come to disagree.
 */
export const IDLE_PROCESSES: CountSpec = {
  name: "WORKER_IDLE_PROCESSES",
  min: 0,
  fallback: 4,
  means: "the number of job processes kept warm",
};

/**
 * Parse one count, or say why it cannot be honoured.
 *
 * Deliberately stricter than `Number`. `Number` accepts `"Infinity"`, `"0x10"` and `"1e3"`, and
 * every one of those is a value an operator did not mean to type — `Infinity` most of all, since it
 * reads as "no ceiling", which is the exact failure being fixed. A count of things is a run of
 * digits with an optional sign, and nothing else.
 */
export const parseCount = (raw: string | undefined, spec: CountSpec): ParsedCount => {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: spec.fallback };

  const refuse = (why: string): ParsedCount => ({
    ok: false,
    message: `${spec.name}=${JSON.stringify(raw)} ${why}. It is ${spec.means}; give a whole number of at least ${String(spec.min)}, or leave it unset for ${String(spec.fallback)}.`,
  });

  if (!/^-?\d+$/.test(text)) return refuse("is not a whole number");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return refuse("is not a whole number");
  if (value < spec.min) return refuse(`is below the minimum of ${String(spec.min)}`);
  return { ok: true, value };
};

/**
 * Parse every count the worker needs, or return every refusal at once.
 *
 * All of them, not the first: an operator fixing a compose file should be told about both typos in
 * one boot rather than discovering the second after the first restart.
 */
export const parseWorkerLimits = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly maxJobs: number; readonly idleProcesses: number } | { readonly ok: false; readonly messages: ReadonlyArray<string> } => {
  const maxJobs = parseCount(env[MAX_JOBS.name], MAX_JOBS);
  // The warm pool's default is "as many as the ceiling allows, up to four", so it is resolved
  // against whatever the ceiling turned out to be rather than against a constant.
  const ceiling = maxJobs.ok ? maxJobs.value : MAX_JOBS.fallback;
  const idleProcesses = parseCount(env[IDLE_PROCESSES.name], { ...IDLE_PROCESSES, fallback: Math.min(ceiling, IDLE_PROCESSES.fallback) });
  const messages = [maxJobs, idleProcesses].flatMap((r) => (r.ok ? [] : [r.message]));
  if (messages.length > 0) return { ok: false, messages };
  return { ok: true, maxJobs: ceiling, idleProcesses: idleProcesses.ok ? idleProcesses.value : IDLE_PROCESSES.fallback };
};

/**
 * Which interruption strategy the session asks for (issue #4, W1).
 *
 * The worker asked for `"adaptive"`, and on this deployment it has never run. Adaptive detection is
 * LiveKit's hosted ML model: the self-hosted profile has no credentials for it, every job logged
 * `adaptive interruption disabled due to unrecoverable error, falling back to VAD-based
 * interruption` (the line is in the installed 1.6.4 dist, `voice/agent_activity.js`), and the
 * session ran on VAD. Issue #2 amendment 1 recorded that and said the config should be corrected;
 * it never was, so every barge-in number this project has published — including the one Phase 1 is
 * about to baseline — is a VAD number produced by a config that claims otherwise.
 *
 * So the default is the truth, and the lie needs an environment variable to tell. `"adaptive"` is
 * still selectable, because on LiveKit Cloud it does run and D5's A/B will want it.
 *
 * Unset is `"vad"`, a typo is a refusal rather than a silent fall back to the framework's
 * auto-detect: "I asked for adaptive and got VAD without being told" is precisely the failure this
 * is fixing, and it should not be reachable through a misspelling either.
 */
export type InterruptionMode = "adaptive" | "vad";

export const interruptionMode = (raw: string | undefined): { readonly ok: true; readonly value: InterruptionMode } | { readonly ok: false; readonly message: string } => {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: "vad" };
  if (text === "vad" || text === "adaptive") return { ok: true, value: text };
  return {
    ok: false,
    message: `WORKER_INTERRUPTION_MODE=${JSON.stringify(raw)} is not a mode. It selects how the session decides a barge-in; give "vad" (the only one a self-hosted profile can run) or "adaptive" (LiveKit Cloud), or leave it unset for "vad".`,
  };
};
