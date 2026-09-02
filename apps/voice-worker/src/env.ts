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
/** A knob that is on or off. Same shape as `CountSpec`, so a refusal reads the same way. */
export interface FlagSpec {
  readonly name: string;
  readonly fallback: boolean;
  readonly means: string;
}

export type ParsedFlag = { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly message: string };

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

/**
 * Parsed, never coerced (amendment 10).
 *
 * `Boolean(process.env.X)` reads `"false"` as true and `WORKER_X=ture` as false, and both are the
 * same failure: a gate you think you set. A typo is a refusal that names the variable.
 */
export const parseFlag = (raw: string | undefined, spec: FlagSpec): ParsedFlag => {
  const text = (raw ?? "").trim().toLowerCase();
  if (text === "") return { ok: true, value: spec.fallback };
  if (TRUE.has(text)) return { ok: true, value: true };
  if (FALSE.has(text)) return { ok: true, value: false };
  return {
    ok: false,
    message: `${spec.name}=${JSON.stringify(raw)} is not a yes or a no. It is ${spec.means}; give one of true/false, 1/0, yes/no, on/off, or leave it unset for ${String(spec.fallback)}.`,
  };
};

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

/**
 * A ratio in [0, 1] — a threshold, not a count (issue #4, W5).
 *
 * Same rule and same reason as `parseCount`, applied to the settings that had escaped it.
 * `Number("0.75 ")` is fine, `Number("75%")` is `NaN`, and `NaN` in a comparison is always false —
 * so `WORKER_LOAD_THRESHOLD=75%` did not raise the shedding threshold, it removed shedding
 * altogether, and the worker went on telling the SFU it was never busy. That is the same lie the
 * fail-closed parser was written to stop; it was simply not applied here.
 */
export interface RatioSpec {
  readonly name: string;
  readonly fallback: number;
  readonly means: string;
}

export const parseRatio = (raw: string | undefined, spec: RatioSpec): ParsedCount => {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: spec.fallback };
  const refuse = (why: string): ParsedCount => ({
    ok: false,
    message: `${spec.name}=${JSON.stringify(raw)} ${why}. It is ${spec.means}; give a number between 0 and 1, or leave it unset for ${String(spec.fallback)}.`,
  });
  // A decimal fraction and nothing else: `Number` would take "1e-1", "0x1" and " Infinity", and an
  // operator who typed any of those did not mean the number they would get.
  if (!/^(?:0|1|0?\.\d+|1\.0+)$/.test(text)) return refuse("is not a number between 0 and 1");
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) return refuse("is not a number between 0 and 1");
  return { ok: true, value };
};

/** The shedding threshold the SFU is told about: above it, this worker asks for somebody else. */
export const LOAD_THRESHOLD: RatioSpec = {
  name: "WORKER_LOAD_THRESHOLD",
  fallback: 0.75,
  means: "the load above which this worker asks the SFU to prefer another one",
};

/** VAD activation. A threshold, so the ratio parser; 0.5 is both the plugin's and the native default. */
export const VAD_ACTIVATION: RatioSpec = {
  name: "WORKER_VAD_ACTIVATION_THRESHOLD",
  fallback: 0.5,
  means: "how loud a frame must be before the VAD calls it speech",
};

/**
 * How long silence must last before the VAD calls the speech over. 550 ms is the plugin's default
 * and the value every interruption number here was measured at; the native VAD's own default is
 * 250 ms, which is a timing change and belongs to an A/B rather than to a swap of engine.
 */
export const VAD_MIN_SILENCE_MS: CountSpec = {
  name: "WORKER_VAD_MIN_SILENCE_MS",
  min: 0,
  fallback: 550,
  means: "how long silence must last before the VAD calls the speech over, in milliseconds",
};

/** Warn here, kill at the limit. Both were 0, which paid for the monitor and enforced nothing. */
export const JOB_MEMORY_WARN_MB: CountSpec = {
  name: "WORKER_JOB_MEMORY_WARN_MB",
  min: 1,
  fallback: 400,
  means: "the per-job memory a warning is logged at, in megabytes",
};

export const JOB_MEMORY_LIMIT_MB: CountSpec = {
  name: "WORKER_JOB_MEMORY_LIMIT_MB",
  min: 1,
  fallback: 800,
  means: "the per-job memory a job is killed at, in megabytes",
};

/**
 * How long a barge-in must last before it counts (D5.2's knob).
 *
 * The framework's default is 500 ms (`voice/turn_config/interruption.js` in the installed 1.6.4).
 * It had no knob at all here, and D5.2 is an A/B on exactly this value against the backchannel
 * scenario — so the knob exists now, parsed like the rest, and unset means the framework's default
 * rather than a number this repo invented.
 */
/**
 * Ask Deepgram to transcribe filler words — "mm-hm", "uh-huh", "um" (issue #1, D1's `resume`).
 *
 * Off by default in the plugin, and that is what breaks D1's `resume`: the classifier runs on the
 * **interim transcript** of a backchannel, and with fillers filtered there is no interim to classify.
 * Measured across three tier-3 backchannel runs, the "Mm-hm." line scored **WER 1.000** — nothing
 * transcribed — while every other line in the same calls scored 0.
 *
 * A knob rather than a constant because it changes what every transcript contains, so its effect on
 * the word-error gate has to be measurable in both positions.
 */
export const STT_FILLER_WORDS: FlagSpec = {
  name: "WORKER_STT_FILLER_WORDS",
  fallback: false,
  means: "transcribe filler words and backchannels, which D1's `resume` classifier needs as input",
};

export const INTERRUPTION_MIN_DURATION_MS: CountSpec = {
  name: "WORKER_INTERRUPTION_MIN_DURATION_MS",
  min: 0,
  fallback: 500,
  means: "how long a barge-in must last before the agent yields, in milliseconds",
};
