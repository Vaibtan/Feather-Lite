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
import { resumeIfBackchannel } from "./resume-backchannel.js";
import { FeatherAgent } from "./feather-agent.js";
import { buildSpeechStack } from "./speech.js";
import { RemoteOrchestratorLLM } from "./remote-orchestrator-llm.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const AGENT_NAME = process.env["LIVEKIT_AGENT_NAME"] ?? "feather-lite-agent";
const CONTROL_PLANE_URL = (process.env["CONTROL_PLANE_URL"] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const API_BEARER_TOKEN = process.env["API_BEARER_TOKEN"] ?? null;
const SIP_OUTBOUND_TRUNK_ID = process.env["LIVEKIT_SIP_OUTBOUND_TRUNK_ID"] ?? null;

/**
 * The load threshold is a margin, not a target: the SFU learns this worker's load 2.5 s late
 * (`UPDATE_LOAD_INTERVAL`) and can assign against a stale status in between, so at 0.75 the worker
 * stops accepting a quarter of the way before it is actually full.
 */
const LIMITS = parseWorkerLimits(process.env);
const INTERRUPTION = interruptionMode(process.env["WORKER_INTERRUPTION_MODE"]);
if (!INTERRUPTION.ok) {
  process.stderr.write(`${INTERRUPTION.message}
`);
  process.exit(1);
}
const INTERRUPTION_MODE = INTERRUPTION.ok ? INTERRUPTION.value : "vad";

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
   * Fail closed at boot: a coerced limit is `NaN`, and `inFlight() >= NaN` is always false, so a
   * typo removes the ceiling rather than raising it and nothing says so.
   */
  for (const m of LIMITS.messages) console.error(`[worker] refusing to start: ${m}`);
  process.exit(1);
}

const WORKER_MAX_JOBS = LIMITS.maxJobs;
const WORKER_LOAD_THRESHOLD = knob(KNOBS.loadThreshold, LOAD_THRESHOLD.fallback);
/**
 * A cold job process costs ~2.8 s before it can speak, paid inside the call while the borrower is
 * on the line, and cold starts serialise behind the pool's init mutex. `min(WORKER_MAX_JOBS, 4)`
 * follows the framework's production default; each warm slot is ~190 MB resident.
 */
const WORKER_IDLE_PROCESSES = LIMITS.idleProcesses;

/**
 * The shared inference process runs every end-of-turn prediction on libuv's pool: measured ceiling
 * ~65 predicts/s at the default 4 threads against ~80/s at 12. Set on the parent because the
 * inference and job processes inherit the environment at fork time, the only reliable moment.
 */
process.env["UV_THREADPOOL_SIZE"] ??= String(Math.min(12, availableParallelism()));

/**
 * `minSilenceDuration` is set explicitly because the native VAD defaults to 250 ms where the plugin
 * it replaces defaulted to 550 ms, and every interruption number this project has taken was taken
 * at 550; lowering it is a timing change that belongs to its own A/B.
 */
const VAD_OPTIONS = {
  activationThreshold: knob(KNOBS.vadActivation, VAD_ACTIVATION.fallback),
  minSilenceDuration: knob(KNOBS.vadMinSilenceMs, VAD_MIN_SILENCE_MS.fallback),
} as const;

/**
 * Measured job processes sit at 185-290 MB idle and peak near 340 MB during a call, so 400 MB is
 * "look at this" and 800 MB is "this is not a call any more".
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
     * No meta: every process shares one agent name and one `agent_heartbeats` row, so a job process
     * sending display fields would overwrite the main process's `load`/`active_jobs` for as long as
     * a call ran. This beat exists only for the conversation liveness the sweeper reads.
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
      /**
       * `updateOptions` re-opens the Deepgram websocket, so this must only be applied when the
       * borrower is not mid-utterance. An STT without it, or a throw from it, degrades to an
       * unbiased recogniser rather than failing the call.
       */
      biasRecogniser: (terms) => {
        const stt = speech.stt as unknown as { updateOptions?: (o: Record<string, unknown>) => void };
        if (typeof stt.updateOptions !== "function") {
          log("recogniser cannot be biased: no updateOptions on this STT", {});
          return;
        }
        try {
          stt.updateOptions({ keyterm: [...terms.keyterms], keywords: terms.keywords.map((k) => k.split(":")), numerals: terms.numerals });
        } catch (e) {
          log("biasing the recogniser failed", { error: String(e) });
        }
      },
      log,
    });

    const speech = buildSpeechStack();
    log("speech stack", { provider: speech.provider, describe: speech.describe });

    const session = new voice.AgentSession({
      stt: speech.stt,
      llm: new RemoteOrchestratorLLM(),
      tts: speech.tts,
      vad: ctx.proc.userData.vad as inference.VAD,
      turnHandling: {
        // No `turnDetection` and no `endpointing`, on purpose: an undefined `turnDetection` makes
        // the session auto-provision the audio-native detector, and caller-supplied endpointing keys
        // always win, so setting them here would silently cancel the tighter streaming defaults the
        // SDK applies for a streaming audio model.
        //
        // `mode` reflects what actually runs: adaptive is LiveKit's hosted detector, and a
        // self-hosted profile has no credentials for it, so the SDK logs one line and falls back to
        // VAD anyway.
        interruption: { enabled: true, mode: INTERRUPTION_MODE, minDuration: knob(KNOBS.interruptionMinDurationMs, INTERRUPTION_MIN_DURATION_MS.fallback), falseInterruptionTimeout: 2000, resumeFalseInterruption: true, discardAudioIfUninterruptible: false },
        preemptiveGeneration: { enabled: false }, // one control-plane turn per confirmed user turn
      },
      // Disabled deliberately: `FeatherAgent` owns the only silence clock, so the deadline is the
      // control plane's number rather than the SDK's, and the strike that closes a dead call can
      // actually be reached. See `FeatherAgent`'s silence-clock note.
      userAwayTimeout: null,
      aecWarmupDuration: 3000,
    });

    /**
     * `_activity` is the SDK's own seam for tightly-coupled internals; `currentSpeech` is a public
     * getter on it. The framework plays one speech at a time and inserts that speech's chat item
     * inside its own task, before the task completes, so the speech that is current when the item
     * arrives is the one that spoke it. Without the seam the ledger falls back to play order.
     */
    const speakingNow = (): string | null => {
      const activity = (session as unknown as { _activity?: { currentSpeech?: { id?: string } } })._activity;
      return activity?.currentSpeech?.id ?? null;
    };
    session.on(voice.AgentSessionEventTypes.EotPrediction, (ev) => {
      agent.onEotPrediction({ probability: ev.probability, threshold: ev.threshold, inferenceMs: ev.inferenceDurationMs });
    });
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      agent.noteSpeechCreated(ev.source, ev.speechHandle);
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type === "message" && item.role === "assistant") agent.reportPlayout(speakingNow(), item);
    });
    /**
     * The backchannel classifier reads finals as well as interims: an utterance that short is often
     * published with no interim event at all. `pausedSpeech` is the guard either way.
     *
     * `pausedAtMs` is taken from the state change, not from the transcript that triggers the resume,
     * so the duration measures the silence the borrower actually hears.
     */
    let pausedAtMs: number | null = null;
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (ev.oldState === "speaking" && ev.newState !== "speaking") pausedAtMs = Date.now();
      if (ev.newState === "speaking") pausedAtMs = null;
      agent.noteAgentListening(ev.newState === "listening");
    });
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      // If `_activity` or its timer is gone, `resumeIfBackchannel` returns false and the call keeps
      // the SDK's ordinary resume path.
      const activity = (session as unknown as { _activity?: { pausedSpeech?: { handle?: { id?: string } }; startFalseInterruptionTimer?: (ms: number) => void } })._activity;
      // Read before resuming: the framework clears the paused speech as the speech loop picks it up.
      const pausedSpeechId = activity?.pausedSpeech?.handle?.id ?? null;
      if (!resumeIfBackchannel(ev.transcript, activity)) {
        if (ev.isFinal) pausedAtMs = null;
        return;
      }
      // Null means the agent was not observed to stop, so there is no honest duration to report.
      const pausedFor = pausedAtMs === null ? null : Date.now() - pausedAtMs;
      pausedAtMs = null;
      log("resumed on backchannel", { transcript: ev.transcript, pausedForMs: pausedFor, speechId: pausedSpeechId });
      agent.onResumed(pausedSpeechId, pausedFor);
    });
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      agent.noteUserListening(ev.newState === "listening");
    });
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics as Record<string, unknown>;
      if (m["type"] === "tts_metrics" || m["type"] === "eou_metrics") {
        log("metrics", { type: m["type"], ttfbMs: m["ttfbMs"], eouDelayMs: m["endOfUtteranceDelayMs"], transcriptionDelayMs: m["transcriptionDelayMs"] });
      }
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      if (m["type"] === "eou_metrics") {
        // The reading names the reply speech the framework created for the turn it measures, which
        // is the same speech `SpeechCreated` announced before `llmNode` ran.
        agent.onEouMetrics(typeof m["speechId"] === "string" ? m["speechId"] : null, { eouDelayMs: num(m["endOfUtteranceDelayMs"]), transcriptionDelayMs: num(m["transcriptionDelayMs"]) });
      } else if (m["type"] === "tts_metrics") {
        // `speechId` is stamped by the framework from the speech the synthesis ran under, so a
        // nudge's or the opening's audio is never counted against a control-plane turn.
        agent.onTtsMetrics(typeof m["speechId"] === "string" ? m["speechId"] : null, { ttfbMs: num(m["ttfbMs"]), audioDurationMs: num(m["audioDurationMs"]), charactersCount: num(m["charactersCount"]) });
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      log("session error", { error: String(ev.error) });
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
      if (agent.ended || ended) return;
      // A turn's numbers are completed by the next turn, and on this path there is no next turn.
      // They go out before the hangup signal, which finalises the call.
      void agent
        .reportPendingTurns()
        .then(() => client.signal(conversationId, { kind: "hangup", reason: String(ev.reason) }).catch(() => undefined))
        .then(() => hangup("session_closed"));
    });

    await session.start({ agent, room: ctx.room });

    if (mode === "sip") {
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
      // AMD before any speech: never recite Mini-Miranda into a voicemail.
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

let server: AgentServer | null = null;
let lastBeatAt = 0;

const admission = createAdmissionController({
  maxJobs: WORKER_MAX_JOBS,
  activeJobIds: () => (server?.activeJobs ?? []).map((j) => j.job.id),
  log: (message, extra) => console.log(`[feather] ${message} ${JSON.stringify(extra)}`),
});
// Additional to the framework's own `once` handlers: `AgentServer.close()` tears down the process
// pool and then awaits the admission poll, which would otherwise hold shutdown open.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, admission.abandonWaits);

const loadFunc = async (w: AgentServer): Promise<number> => {
  server = w;
  const load = w.activeJobs.length / WORKER_MAX_JOBS;
  /**
   * The worker heartbeat rides the load tick because this module is imported by every job process
   * too, and only the process owning the `AgentServer` ever calls `loadFunc`. Throttled to the 10 s
   * the sweeper's staleness window is built around; the tick itself is 2.5 s.
   */
  const now = Date.now();
  if (now - lastBeatAt >= 10_000) {
    lastBeatAt = now;
    /**
     * Read from the resolved options, not the configured ones: `ServerOptions` forces
     * `loadThreshold` to `Infinity` under `--simulation`, and a pool that failed to pre-warm is
     * otherwise indistinguishable from one that succeeded. `AgentServer` does not expose its
     * options, so the patch adds the getters (see `patches/README.md`).
     */
    const opts = w.options;
    void client.heartbeat(AGENT_NAME, {
      pid: process.pid,
      mode: "worker",
      production: opts.production,
      simulation: opts.simulation,
      max_jobs: WORKER_MAX_JOBS,
      // `Infinity` is not JSON, and it is exactly the value that means "this worker will never tell
      // the SFU it is busy", so it is reported as its own fact.
      load_threshold: Number.isFinite(opts.loadThreshold) ? opts.loadThreshold : null,
      load_shedding_disabled: !Number.isFinite(opts.loadThreshold),
      active_jobs: w.activeJobs.length,
      admitting: admission.admitting(),
      load: Math.round(load * 1000) / 1000,
      /** The pool's own count: below `idle_processes_configured` means slots never filled. */
      idle_processes: w.idleProcesses,
      idle_processes_configured: opts.numIdleProcesses,
      uv_threadpool_size: Number(process.env["UV_THREADPOOL_SIZE"]),
      job_memory_warn_mb: WORKER_JOB_MEMORY_WARN_MB,
      job_memory_limit_mb: WORKER_JOB_MEMORY_LIMIT_MB,
      /**
       * This process only: the framework does not expose the pids of the inference or job
       * processes, so tree-wide figures stay the resource sampler's job.
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

