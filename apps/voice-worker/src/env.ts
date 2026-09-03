/**
 * Fail closed at boot: a limit that was typed and cannot be honoured stops the worker, because a
 * coerced one silently removes itself (`Number("eight")` is `NaN`, and `inFlight() >= NaN` is always
 * false). Unset is different from wrong, so absence takes the documented fallback.
 */

export interface CountSpec {
  readonly name: string;
  /** The smallest meaningful value. Below it is a refusal, never a clamp. */
  readonly min: number;
  readonly fallback: number;
  readonly means: string;
}

export type ParsedCount = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string };

export const MAX_JOBS: CountSpec = {
  name: "WORKER_MAX_JOBS",
  min: 1,
  fallback: 8,
  means: "the number of concurrent calls this worker admits",
};

/**
 * 0 is a real setting, which the framework swallowed with `numIdleProcesses || default` — hence the
 * `??` in `patches/@livekit__agents@1.6.4.patch`. The fallback is resolved against the ceiling in
 * `parseWorkerLimits`, but an explicit value above it is left as typed rather than clamped.
 */
export const IDLE_PROCESSES: CountSpec = {
  name: "WORKER_IDLE_PROCESSES",
  min: 0,
  fallback: 4,
  means: "the number of job processes kept warm",
};

export interface FlagSpec {
  readonly name: string;
  readonly fallback: boolean;
  readonly means: string;
}

export type ParsedFlag = { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly message: string };

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

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

export const parseWorkerLimits = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly maxJobs: number; readonly idleProcesses: number } | { readonly ok: false; readonly messages: ReadonlyArray<string> } => {
  const maxJobs = parseCount(env[MAX_JOBS.name], MAX_JOBS);
  const ceiling = maxJobs.ok ? maxJobs.value : MAX_JOBS.fallback;
  const idleProcesses = parseCount(env[IDLE_PROCESSES.name], { ...IDLE_PROCESSES, fallback: Math.min(ceiling, IDLE_PROCESSES.fallback) });
  const messages = [maxJobs, idleProcesses].flatMap((r) => (r.ok ? [] : [r.message]));
  if (messages.length > 0) return { ok: false, messages };
  return { ok: true, maxJobs: ceiling, idleProcesses: idleProcesses.ok ? idleProcesses.value : IDLE_PROCESSES.fallback };
};

/**
 * The default is `"vad"` because adaptive detection is LiveKit's hosted model: a self-hosted profile
 * has no credentials for it and the SDK silently falls back to VAD, so asking for it there produces
 * VAD numbers under a config that claims otherwise. `"adaptive"` stays selectable for Cloud.
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
  // A decimal fraction and nothing else: `Number` would also take "1e-1", "0x1" and " Infinity".
  if (!/^(?:0|1|0?\.\d+|1\.0+)$/.test(text)) return refuse("is not a number between 0 and 1");
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) return refuse("is not a number between 0 and 1");
  return { ok: true, value };
};

export const LOAD_THRESHOLD: RatioSpec = {
  name: "WORKER_LOAD_THRESHOLD",
  fallback: 0.75,
  means: "the load above which this worker asks the SFU to prefer another one",
};

/** 0.5 is both the plugin's and the native VAD's default. */
export const VAD_ACTIVATION: RatioSpec = {
  name: "WORKER_VAD_ACTIVATION_THRESHOLD",
  fallback: 0.5,
  means: "how loud a frame must be before the VAD calls it speech",
};

/**
 * 550 ms is the plugin's default and the value every interruption number here was measured at; the
 * native VAD's own default is 250 ms, which is a timing change rather than a swap of engine.
 */
export const VAD_MIN_SILENCE_MS: CountSpec = {
  name: "WORKER_VAD_MIN_SILENCE_MS",
  min: 0,
  fallback: 550,
  means: "how long silence must last before the VAD calls the speech over, in milliseconds",
};

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
 * Off in the Deepgram plugin, which means a backchannel is not transcribed at all and the `resume`
 * classifier has no input.
 */
export const STT_FILLER_WORDS: FlagSpec = {
  name: "WORKER_STT_FILLER_WORDS",
  /** On: measured against the word-error gate, both arms came out identical (p50/p95 0 / 0.1111). */
  fallback: true,
  means: "transcribe filler words and backchannels, which D1's `resume` classifier needs as input",
};

export const INTERRUPTION_MIN_DURATION_MS: CountSpec = {
  name: "WORKER_INTERRUPTION_MIN_DURATION_MS",
  min: 0,
  fallback: 500,
  means: "how long a barge-in must last before the agent yields, in milliseconds",
};
