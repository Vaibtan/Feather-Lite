/**
 * Feather-Lite voice worker (LiveKit Agents). Registers with LiveKit Cloud under LIVEKIT_AGENT_NAME
 * and, per dispatched job:
 *   1. reads conversation/mode/opening from the room metadata written by POST /api/voice/sessions
 *   2. starts an AgentSession (STT/TTS via LiveKit Inference, native VAD, audio-native EOT,
 *      preemptive generation OFF, speech during non-interruptible segments buffered)
 *   3. browser mode: waits for the participant, speaks the opening, then every user turn is a
 *      control-plane turn (FeatherAgent.llmNode)
 *      sip mode: dials the borrower, runs AMD, and only speaks the opening to a HUMAN
 *   4. reports playout truth / no-input / hangup back as signals; ends the call by deleting the room
 *
 * Run: pnpm --filter @feather-lite/voice-worker dev   (needs .env at repo root)
 */
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { type AgentServer, inference, type JobContext, type JobProcess, ServerOptions, cli, defineAgent, voice } from "@livekit/agents";
import { RoomServiceClient, SipClient } from "livekit-server-sdk";
import { createAdmissionController } from "./admission.js";
import {
  INTERRUPTION_MIN_DURATION_MS,
  JOB_MEMORY_LIMIT_MB,
  JOB_MEMORY_WARN_MB,
  LOAD_THRESHOLD,
  VAD_ACTIVATION,
  VAD_MIN_SILENCE_MS,
  interruptionMode,
  parseCount,
  parseRatio,
  parseWorkerLimits,
} from "./env.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { FeatherAgent } from "./feather-agent.js";
import { buildSpeechStack } from "./speech.js";
import { RemoteOrchestratorLLM } from "./tracer/remote-orchestrator-llm.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const AGENT_NAME = process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-agent";
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const API_BEARER_TOKEN = process.env["API_BEARER_TOKEN"] ?? null;
const SIP_OUTBOUND_TRUNK_ID = process.env["LIVEKIT_SIP_OUTBOUND_TRUNK_ID"] ?? null;

/**
 * How many calls this worker is sized to carry at once, and how much of that it keeps in hand.
 *
 * The framework's default load function is a five-second **CPU average** of the whole box. That is
 * the wrong quantity twice over: it counts every other process on the machine as this worker's
 * load, and it lags — a burst of five dispatches arrives long before the CPU average notices them.
 * A run on 2026-08-27 lost the fifth of five calls to exactly that: nothing was broken, the worker
 * simply refused a job because a CPU spike happened to be in the window.
 *
 * `activeJobs / WORKER_MAX_JOBS` is instead the quantity being controlled — how many calls this
 * worker is already carrying — and it is exact the instant a job is accepted.
 *
 * The threshold is the margin, and it exists because the SFU learns this number **2.5 seconds
 * late** (`UPDATE_LOAD_INTERVAL`): between two updates it can assign more jobs against a status
 * that is already stale. At 0.75 the worker stops accepting a quarter of the way before it is
 * actually full, which is the room that lag needs.
 *
 * So the admitted concurrency is `floor(MAX_JOBS * THRESHOLD)` — **6 at the defaults**, not 8. The
 * spec's D9 acceptance bar is ten concurrent calls; reaching it means raising `WORKER_MAX_JOBS`,
 * which is why it is an env var and why the default is described as a starting point rather than a
 * measurement. Nothing here decides what this box can carry; it decides that the answer is a number
 * someone chose rather than a CPU average nobody controls.
 */
const LIMITS = parseWorkerLimits(process.env);
const INTERRUPTION = interruptionMode(process.env["WORKER_INTERRUPTION_MODE"]);
if (!INTERRUPTION.ok) {
  // Same rule as the limits below: a setting the operator got wrong is a setting nobody has decided.
  process.stderr.write(`${INTERRUPTION.message}
`);
  process.exit(1);
}
const INTERRUPTION_MODE = INTERRUPTION.ok ? INTERRUPTION.value : "vad";

/**
 * The five knobs that used to be raw `Number(process.env[...])`, and the one D5.2 needs (W5).
 *
 * Every one of them fails the same way `WORKER_MAX_JOBS` did before review #18: `Number("75%")` is
 * `NaN`, and `NaN` in a comparison is always false — so a mistyped load threshold did not raise
 * shedding, it removed it, and a mistyped memory limit did not raise the ceiling, it made the
 * framework log the limit as advisory only. The parser these bypassed exists for exactly that, and
 * they are behind it now. Every refusal is collected, so an operator fixing a compose file is told
 * about all of them in one boot.
 */
const KNOBS = {
  loadThreshold: parseRatio(process.env[LOAD_THRESHOLD.name], LOAD_THRESHOLD),
  vadActivation: parseRatio(process.env[VAD_ACTIVATION.name], VAD_ACTIVATION),
  vadMinSilenceMs: parseCount(process.env[VAD_MIN_SILENCE_MS.name], VAD_MIN_SILENCE_MS),
  jobMemoryWarnMb: parseCount(process.env[JOB_MEMORY_WARN_MB.name], JOB_MEMORY_WARN_MB),
  jobMemoryLimitMb: parseCount(process.env[JOB_MEMORY_LIMIT_MB.name], JOB_MEMORY_LIMIT_MB),
  interruptionMinDurationMs: parseCount(process.env[INTERRUPTION_MIN_DURATION_MS.name], INTERRUPTION_MIN_DURATION_MS),
} as const;
const KNOB_REFUSALS = Object.values(KNOBS).flatMap((r) => (r.ok ? [] : [r.message]));
if (KNOB_REFUSALS.length > 0) {
  for (const m of KNOB_REFUSALS) process.stderr.write(`${m}
`);
  process.exit(1);
}
const knob = (r: { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string }, fallback: number): number => (r.ok ? r.value : fallback);
if (!LIMITS.ok) {
  /**
   * Fail closed, at boot, on stderr (review #18).
   *
   * The alternative is what this replaces: `Math.max(1, Number("eight"))` is `NaN`, and the
   * admission controller's `inFlight() >= NaN` is always false — a typo did not raise the ceiling,
   * it removed it, and nothing said so. A worker whose limits nobody has decided is worse than a
   * worker that did not start: it takes calls it cannot serve, and the failure arrives minutes
   * later, on a borrower's call, somewhere else entirely.
   */
  for (const m of LIMITS.messages) console.error(`[worker] refusing to start: ${m}`);
  process.exit(1);
}

const WORKER_MAX_JOBS = LIMITS.maxJobs;
const WORKER_LOAD_THRESHOLD = knob(KNOBS.loadThreshold, LOAD_THRESHOLD.fallback);
/**
 * How many job processes are kept warm (W3).
 *
 * A cold job process costs ~2.8 s before it can speak, and 2 655 ms of that is module loading — the
 * framework, then `contracts` and `domain` as raw TypeScript. That is not paid at dispatch: it is
 * paid *inside* the call, while the borrower is on the line. With one warm slot, a burst of five
 * paid it four times, serialised behind the pool's init mutex.
 *
 * `min(WORKER_MAX_JOBS, 4)` follows the framework's own production default. It is not free — each
 * warm slot is ~190 MB resident doing nothing — but the gigabyte W1 just gave back buys four of
 * them and still leaves the tree lighter than it was this morning.
 */
const WORKER_IDLE_PROCESSES = LIMITS.idleProcesses;

/**
 * The EOU model's thread pool (W4).
 *
 * libuv's default is 4 threads, and the shared inference process runs every end-of-turn prediction
 * on it — 42-48 ms of wall per 1.2 s window, one to three predictions per user turn, for every call
 * at once. The audit measured its ceiling at ~65 predicts/s with 4 threads and ~80/s with 12
 * (a concurrency-10 burst finishing in 124 ms instead of 160).
 *
 * Set here, on the parent, because the inference and job processes are forked and inherit the
 * environment as it stands at fork time — which is the only reliable moment. This process's *own*
 * pool is already built by then (tsx has read files), and that does not matter: the main worker
 * does no threadpool work. `??=` so an operator's value wins.
 */
process.env["UV_THREADPOOL_SIZE"] ??= String(Math.min(12, availableParallelism()));

/**
 * Voice activity detection (W11).
 *
 * `inference.VAD` runs the **same Silero model** as the plugin it replaces (`model: "silero"` is the
 * only one it accepts), in the same napi addon the end-of-turn detector already lives in
 * (`@livekit/local-inference`, `agents/dist/inference/vad.js:84-93`). What leaves with the plugin is
 * `onnxruntime-node`: 513 MB of prebuilt binaries, 336 MB of it a CUDA execution provider nothing in
 * this deployment can use, hand-pruned in the worker Dockerfile until now.
 *
 * **`minSilenceDuration` is set, and set to the value it had.** The plugin's default is 550 ms; the
 * native VAD's is 250 ms, chosen upstream "so the default satisfies the audio end-of-turn detector's
 * silence-window requirement out of the box" (`inference/vad.js:8-9`). 300 ms is a barge-in and
 * end-of-speech timing change, and this commit is a change of engine, not of timing — every
 * interruption number this project has taken was taken at 550. Lowering it is a knob with its own
 * A/B, next to `interruption.minDuration` and `unlikelyThreshold`.
 *
 * `activationThreshold` is 0.5 on both. `deactivationThreshold` has no plugin equivalent — the
 * plugin has a single threshold — so it takes the native default (`activation - 0.15` = 0.35), which
 * is a hysteresis the plugin did not have and cannot be matched to it.
 */
const VAD_OPTIONS = {
  activationThreshold: knob(KNOBS.vadActivation, VAD_ACTIVATION.fallback),
  minSilenceDuration: knob(KNOBS.vadMinSilenceMs, VAD_MIN_SILENCE_MS.fallback),
} as const;

/**
 * Per-job memory bounds (W7).
 *
 * These were both 0, which did not mean "no monitoring": `supervised_proc` polls `pidusage` for
 * every child every 5 seconds regardless, and on Windows each of those polls spawns a `wmic`
 * process. So the cost was being paid and nothing was being enforced.
 *
 * Real numbers instead of deleting the monitor, because a job that grows past 800 MB is a bug an
 * operator should be told about. Measured job processes sit at 185-290 MB idle and peak near
 * 340 MB during a call, so 400 MB is "look at this" and 800 MB is "this is not a call any more".
 */
const WORKER_JOB_MEMORY_WARN_MB = knob(KNOBS.jobMemoryWarnMb, JOB_MEMORY_WARN_MB.fallback);
const WORKER_JOB_MEMORY_LIMIT_MB = knob(KNOBS.jobMemoryLimitMb, JOB_MEMORY_LIMIT_MB.fallback);

const client = new ControlPlaneClient({ baseUrl: CONTROL_PLANE_URL, bearerToken: API_BEARER_TOKEN });

interface RoomMeta {
  conversation_id?: string;
  mode?: "browser" | "sip";
  opening_text?: string;
  contact_point_value?: string;
}
const parseMeta = (raw: string | undefined): RoomMeta => {
  try {
    return raw ? (JSON.parse(raw) as RoomMeta) : {};
  } catch {
    return {};
  }
};

export default defineAgent({
  prewarm: (proc: JobProcess) => {
    // Synchronous: there is no model file to fetch and no ONNX session to build. The plugin's
    // `VAD.load()` was async because it mapped a `.onnx` file; the native VAD asks the addon for a
    // detector when a stream is opened.
    proc.userData.vad = new inference.VAD(VAD_OPTIONS);
  },
  entry: async (ctx: JobContext) => {
    const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(`[feather] ${msg} ${Object.keys(extra).length ? JSON.stringify(extra) : ""}`);
    await ctx.connect();
    const meta = parseMeta(ctx.room.metadata ?? ctx.job.metadata);
    const conversationId = meta.conversation_id;
    if (!conversationId) {
      log("room has no conversation_id in metadata; leaving", { room: ctx.room.name });
      ctx.shutdown("no conversation");
      return;
    }
    const mode = meta.mode ?? "browser";
    const roomName = ctx.room.name ?? "";
    log("job started", { room: roomName, conversationId, mode });

    const lk = { url: process.env["LIVEKIT_URL"] ?? "", key: process.env["LIVEKIT_API_KEY"] ?? "", secret: process.env["LIVEKIT_API_SECRET"] ?? "" };
    const rooms = new RoomServiceClient(lk.url, lk.key, lk.secret);
    /**
     * Per-conversation liveness for the orphaned-call sweeper (spec 2026-08-26, D6). This runs in
     * the *job* process, which is the only one that knows which call it is on, and it stops the
     * moment the call ends — so a worker that dies mid-call simply stops reporting, which is
     * exactly the signal the sweeper is looking for.
     */
    /**
     * No meta. Every process here shares one agent name and one `agent_heartbeats` row, and this
     * beat's job is the conversation liveness the sweeper reads — not the display fields. Sending
     * `{pid, mode:"job", room}` here overwrote the main process's `production`/`load`/`active_jobs`
     * for as long as a call ran, which made the status page say least about the worker exactly when
     * it was busiest. Nothing ever read the fields being dropped.
     */
    const beat = () => void client.heartbeat(AGENT_NAME, undefined, [conversationId]);
    beat();
    const livenessTimer = setInterval(beat, 10_000);
    livenessTimer.unref();

    let ended = false;
    const hangup = async (reason: string) => {
      if (ended) return;
      ended = true;
      clearInterval(livenessTimer);
      log("hangup", { reason });
      try {
        await rooms.deleteRoom(roomName);
      } catch (e) {
        log("deleteRoom failed", { error: String(e) });
      }
    };

    // SIP/PSTN needs a provisioned outbound trunk, which only LiveKit Cloud has here (livekit-sip is
    // not part of the self-hosted profile — ADR 0006). Fail the attempt now, loudly, instead of
    // building a session and timing out on a dial that can never happen.
    if (mode === "sip" && (!SIP_OUTBOUND_TRUNK_ID || !meta.contact_point_value)) {
      log("sip mode requested but no SIP trunk is configured; failing the attempt", {
        trunkConfigured: Boolean(SIP_OUTBOUND_TRUNK_ID),
        contactNumber: Boolean(meta.contact_point_value),
        livekitUrl: process.env["LIVEKIT_URL"] ?? "",
        hint: "set LIVEKIT_SIP_OUTBOUND_TRUNK_ID (LiveKit Cloud + a SIP trunk); the self-hosted profile has no SIP",
      });
      await client.signal(conversationId, { kind: "hangup", reason: "sip_not_configured" }).catch(() => undefined);
      await hangup("sip_not_configured");
      return;
    }

    const agent = new FeatherAgent({
      client,
      conversationId,
      openingText: meta.opening_text ?? "Hello, this is a call from Feather-Lite Collections.",
      onEndCall: async (reason) => {
        await hangup(reason);
      },
      log,
    });

    // Cloud (LiveKit Inference) or direct provider plugins — an env switch, not a code fork.
    const speech = buildSpeechStack();
    log("speech stack", { provider: speech.provider, describe: speech.describe });

    const session = new voice.AgentSession({
      stt: speech.stt,
      llm: new RemoteOrchestratorLLM(),
      tts: speech.tts,
      vad: ctx.proc.userData.vad as inference.VAD,
      turnHandling: {
        // No `turnDetection` and no `endpointing` on purpose. Leaving turnDetection undefined makes
        // the session auto-provision the audio-native inference.TurnDetector (turn-detector-v1-mini,
        // in-process via @livekit/local-inference, so it works off LiveKit Cloud). The text-based
        // MultilingualModel it replaces is deprecated in 1.6.4 and, being text-based, could not
        // decide the turn was over until STT had produced a transcript -- it serialised EOU behind
        // transcription instead of overlapping it.
        //
        // The explicit endpointing had to go with it: keys the caller supplies always win, so
        // leaving 500/3000 here would have silently cancelled the swap. Unset keys now fall back to
        // the tighter streamingEndpointingOptions (300/2500) that 1.6.4 applies when the detector is
        // a streaming audio model.
        /**
         * `mode` says what actually runs (W1).
         *
         * It used to say `"adaptive"`, and adaptive has never run here. It is LiveKit's hosted
         * detector, the self-hosted profile has no credentials for it, and every job logged
         * `adaptive interruption disabled due to unrecoverable error, falling back to VAD-based
         * interruption` (`agent_activity.js` in the installed 1.6.4) before running on VAD anyway.
         * Issue #2 amendment 1 recorded that and said to correct the config; until now it was not,
         * so every barge-in number this project has published is a VAD number taken under a config
         * that claimed otherwise — including the baseline issue #1's Phase 1 is about to take.
         *
         * `WORKER_INTERRUPTION_MODE=adaptive` selects it back for a Cloud deployment, where it does
         * run and where D5's A/B will want it.
         */
        interruption: { enabled: true, mode: INTERRUPTION_MODE, minDuration: knob(KNOBS.interruptionMinDurationMs, INTERRUPTION_MIN_DURATION_MS.fallback), falseInterruptionTimeout: 2000, resumeFalseInterruption: true, discardAudioIfUninterruptible: false },
        preemptiveGeneration: { enabled: false }, // one control-plane turn per confirmed user turn
      },
      userAwayTimeout: 12,
      aecWarmupDuration: 3000,
    });

    // Runtime truth back to the ledger.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type === "message" && item.role === "assistant") void agent.reportPlayout(item);
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === "away") void agent.onSilence();
    });
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as Record<string, unknown>;
      if (m["type"] === "tts_metrics" || m["type"] === "eou_metrics") {
        log("metrics", { type: m["type"], ttfbMs: m["ttfbMs"], eouDelayMs: m["endOfUtteranceDelayMs"], transcriptionDelayMs: m["transcriptionDelayMs"] });
      }
      // ...and on to the ledger, so the turn row holds the whole waterfall rather than the worker's
      // half of it living only in this log line.
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      if (m["type"] === "eou_metrics") {
        agent.onEouMetrics({ eouDelayMs: num(m["endOfUtteranceDelayMs"]), transcriptionDelayMs: num(m["transcriptionDelayMs"]) });
      } else if (m["type"] === "tts_metrics") {
        agent.onTtsMetrics({ ttfbMs: num(m["ttfbMs"]), audioDurationMs: num(m["audioDurationMs"]), charactersCount: num(m["charactersCount"]) });
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      log("session error", { error: String(ev.error) });
      // The framework's error union is discriminated by pipeline stage and carries the plugin's own
      // label (e.g. "deepgram.STT") plus whether it will be retried, which is exactly the shape the
      // control plane's provider counters want. Reported rather than only logged so a degrading
      // vendor shows up on the status page instead of in a log nobody is tailing.
      const err = ev.error as { type?: string; label?: string; recoverable?: boolean; error?: { message?: string } };
      const stage = err.type === "stt_error" ? "stt" : err.type === "tts_error" ? "tts" : err.type === "llm_error" ? "llm" : "media";
      void client.providerEvents([
        {
          provider: err.label ?? "livekit",
          kind: err.recoverable === true ? "retry" : "error",
          stage,
          message: String(err.error?.message ?? ev.error).slice(0, 300),
          conversation_id: conversationId,
        },
      ]);
    });
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      log("session closed", { reason: String(ev.reason) });
      if (!agent.ended && !ended) {
        // Participant left / transport closed before a disposition: tell the ledger.
        void client.signal(conversationId, { kind: "hangup", reason: String(ev.reason) }).catch(() => undefined).then(() => hangup("session_closed"));
      }
    });

    await session.start({ agent, room: ctx.room });

    if (mode === "sip") {
      // Guarded above: both are present by the time we get here.
      const to = meta.contact_point_value!;
      const sip = new SipClient(lk.url, lk.key, lk.secret);
      const identity = "borrower-phone";
      try {
        await sip.createSipParticipant(SIP_OUTBOUND_TRUNK_ID!, to, roomName, { participantIdentity: identity, waitUntilAnswered: true, ringingTimeout: 30 });
      } catch (e) {
        log("dial failed / unanswered", { error: String(e) });
        await client.signal(conversationId, { kind: "no_answer" }).catch(() => undefined);
        await hangup("no_answer");
        return;
      }
      await ctx.waitForParticipant(identity);
      // AMD before ANY speech (plan rev.2 R9): never recite Mini-Miranda into a voicemail.
      const detector = new voice.AMD(session, { participantIdentity: identity });
      const result = await detector.execute();
      log("amd", { category: result.category });
      const amd = result.category === voice.AMDCategory.HUMAN ? "HUMAN" : result.category === voice.AMDCategory.UNCERTAIN ? "UNCERTAIN" : "MACHINE";
      const r = await client.signal(conversationId, { kind: "amd_result", result: amd });
      if (amd === "MACHINE") {
        const h = session.say(r.agent_text, { allowInterruptions: false });
        await h.waitForPlayout();
        await hangup("voicemail_left");
        return;
      }
    } else {
      await ctx.waitForParticipant();
    }
    await agent.speakOpening();
    log("listening");
  },
});

/**
 * The worker's own state, captured from the load function.
 *
 * `loadFunc` is the only handle the framework hands back on the running `AgentServer` — `cli.runApp`
 * constructs it internally and returns nothing — so this is where "how many calls am I on" becomes
 * observable at all. It is called every 2.5 s whether or not anything is happening.
 */
let server: AgentServer | null = null;
let lastBeatAt = 0;

/**
 * The ceiling, enforced where the answer to a job request is actually given.
 *
 * `WORKER_MAX_JOBS` is the hard limit; the threshold below it remains what it always was — the
 * point at which this worker asks the SFU to prefer someone else, which matters when there is a
 * someone else. Why the load function alone is not enough, and why the accept is not awaited, is
 * in `admission.ts`; the decision is there so it can be tested without a websocket.
 */
const admission = createAdmissionController({
  maxJobs: WORKER_MAX_JOBS,
  activeJobIds: () => (server?.activeJobs ?? []).map((j) => j.job.id),
  log: (message, extra) => console.log(`[feather] ${message} ${JSON.stringify(extra)}`),
});
// `AgentServer.close()` tears down the process pool and then awaits the admission poll, so a job
// admitted seconds before a SIGTERM would hold the shutdown open for the whole assignment timeout.
// The framework's own SIGINT/SIGTERM handlers are `once` listeners; these are additional.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, admission.abandonWaits);

const loadFunc = async (w: AgentServer): Promise<number> => {
  server = w;
  const load = w.activeJobs.length / WORKER_MAX_JOBS;
  /**
   * The worker's heartbeat rides the load tick rather than a timer of its own.
   *
   * `defineAgent`'s module is imported by **every job process too** (`job_proc_lazy_main` forks and
   * imports this file for its default export), so a module-scope `setInterval` heartbeat was being
   * sent by the main process and by each job process, all under one agent name — and the last
   * writer won. That was harmless while the meta was `{pid, mode}`; the moment it carries
   * `active_jobs` and `load` it is a job process reporting zero over the truth.
   *
   * `loadFunc` is only ever called by the process that owns the `AgentServer`, so driving the beat
   * from here makes "who reports the worker's state" a fact rather than a convention. Throttled to
   * the 10 s the sweeper's staleness window is built around; the tick itself is 2.5 s.
   *
   * It also tightens what "online" means: the load monitor only runs once the worker is registered
   * with the SFU, so a worker that is up but cannot receive jobs no longer reports itself healthy.
   */
  const now = Date.now();
  if (now - lastBeatAt >= 10_000) {
    lastBeatAt = now;
    /**
     * Everything here that has a resolved value is read from the resolved value (review #4, #17).
     *
     * `production` used to be `process.env["LIVEKIT_DEV_MODE"] !== "1"`. That is *nearly* right —
     * the SDK's own `dev`, `connect` and `console` commands do set it (`agents/dist/cli.js:128,144,
     * 157`) — but it is an inference about a flag rather than the flag, and it says nothing about
     * `start --simulation`, which is the mode where the ceiling really is gone: `ServerOptions`
     * forces `loadThreshold` to `Infinity` when `simulation` is set (`worker.js:166`).
     *
     * `AgentServer` does not expose its options, so the patch adds two internal getters (see
     * `patches/README.md`). They are the difference between a heartbeat that repeats the config it
     * was handed and one that reports what the worker resolved — and `idle_processes` in
     * particular was the configured constant, so a pool that failed to pre-warm looked identical to
     * one that succeeded, which is the single thing W3 asked to verify live.
     */
    const opts = w.options;
    void client.heartbeat(AGENT_NAME, {
      pid: process.pid,
      mode: "worker",
      production: opts.production,
      simulation: opts.simulation,
      max_jobs: WORKER_MAX_JOBS,
      // Effective, not configured. `Infinity` is not JSON, and it is exactly the value that means
      // "this worker will never tell the SFU it is busy", so it is reported as its own fact.
      load_threshold: Number.isFinite(opts.loadThreshold) ? opts.loadThreshold : null,
      load_shedding_disabled: !Number.isFinite(opts.loadThreshold),
      active_jobs: w.activeJobs.length,
      admitting: admission.admitting(),
      load: Math.round(load * 1000) / 1000,
      /**
       * The pool's own count, not the constant it was configured with: job processes that have
       * forked and are not on a call. Below `idle_processes_configured` means slots never filled.
       */
      idle_processes: w.idleProcesses,
      idle_processes_configured: opts.numIdleProcesses,
      // The parent's value. `fork` passes `process.env` through unless told otherwise, so this is
      // also what the inference and job processes start with — and they are the ones that use it.
      uv_threadpool_size: Number(process.env["UV_THREADPOOL_SIZE"]),
      job_memory_warn_mb: WORKER_JOB_MEMORY_WARN_MB,
      job_memory_limit_mb: WORKER_JOB_MEMORY_LIMIT_MB,
      /**
       * This process only. The framework does not expose the pids of the inference process or the
       * job processes, so the tree-wide figures stay the resource sampler's job
       * (`apps/load-test/src/resources.ts` classifies them from their command lines) rather than
       * being guessed at here.
       */
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  }
  return load;
};

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    requestFunc: admission.requestFunc,
    loadFunc,
    loadThreshold: WORKER_LOAD_THRESHOLD,
    numIdleProcesses: WORKER_IDLE_PROCESSES,
    jobMemoryWarnMB: WORKER_JOB_MEMORY_WARN_MB,
    jobMemoryLimitMB: WORKER_JOB_MEMORY_LIMIT_MB,
    initializeProcessTimeout: 60_000,
  }),
);

