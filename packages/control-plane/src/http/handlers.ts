/**
 * HttpApi implementation for `FeatherApi`. Thin: decode → service → encode; the domain error
 * channel is mapped to the API's typed errors here and nowhere else.
 */
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { DateTime, Effect, Option, Stream } from "effect";
import { PgClient } from "@effect/sql-pg";
import {
  ApiConflict,
  ApiNotFound,
  ApiPreCallRejected,
  ApiUnavailable,
  ApiBadRequest,
  FeatherApi,
  TurnRequest,
  encodeFrame,
  type SignalRequest,
  type TurnFrame,
} from "@feather-lite/contracts";
import { scoreRecordProblem } from "@feather-lite/domain";
import { AppConfig } from "../config.js";
import { ConversationCompleted, NotFound, PreCallRejected, TelephonyError, TurnInProgress, UnknownScenario } from "../errors.js";
import { rateLimitBucketCount } from "./rateLimit.js";
import { unknownTurnIdMessage, unknownTurnIds } from "./scoreTargets.js";
import { SchedulingRepo } from "../repos/scheduling.js";
import { Orchestrator, type Signal } from "../services/Orchestrator.js";
import { Quality } from "../services/Quality.js";
import { Queries } from "../services/Queries.js";
import { Scores } from "../services/Scores.js";
import { ScenarioRunner } from "../services/Scenarios.js";
import { SeedService } from "../services/Seed.js";
import { VoiceSessions } from "../services/VoiceSessions.js";
import { WorkflowService } from "../services/Workflow.js";
import { Metrics } from "../services/Metrics.js";
import { TurnRunner } from "./TurnRunner.js";

/* --------------------------- error mapping --------------------------- */

const mapNotFound = (e: NotFound) => new ApiNotFound({ entity: e.entity, id: e.id });
const mapConflict = (e: ConversationCompleted | TurnInProgress) =>
  new ApiConflict({ code: e instanceof ConversationCompleted ? "CONVERSATION_COMPLETED" : "TURN_IN_PROGRESS", message: e.message });
const mapPreCall = (e: PreCallRejected) => new ApiPreCallRejected({ error: "Pre-call validation failed", validation_failures: e.failures });

const parseNow = (iso: string | undefined): DateTime.Utc | undefined => {
  if (!iso) return undefined;
  const parsed = DateTime.make(iso);
  return Option.isSome(parsed) ? DateTime.toUtc(parsed.value) : undefined;
};

const toSignal = (s: SignalRequest): Signal => {
  switch (s.kind) {
    case "amd_result":
      return { kind: "amd_result", result: s.result, confidence: s.confidence, actionId: s.action_id };
    case "no_answer":
      return { kind: "no_answer", actionId: s.action_id };
    case "hangup":
      return { kind: "hangup", reason: s.reason, actionId: s.action_id };
    case "barge_in":
      return { kind: "barge_in", partialAgentText: s.partial_agent_text, actionId: s.action_id };
    case "playout":
      return { kind: "playout", turnId: s.turn_id, heardText: s.heard_text, interrupted: s.interrupted };
    case "opening_played":
      return { kind: "opening_played", text: s.text };
    case "voicemail_drop":
      return { kind: "voicemail_drop", confidence: s.confidence, actionId: s.action_id };
    case "turn_metrics":
      return { kind: "turn_metrics", turnId: s.turn_id, eouDelayMs: s.eou_delay_ms, transcriptionDelayMs: s.transcription_delay_ms, ttsTtfbMs: s.tts_ttfb_ms, ttsAudioMs: s.tts_audio_ms, ttsChars: s.tts_chars };
  }
};

const encoder = new TextEncoder();
const sseBytes = (frames: Stream.Stream<TurnFrame>): Stream.Stream<Uint8Array> =>
  frames.pipe(
    Stream.zipWithIndex,
    Stream.map(([frame, i]) => encoder.encode(`id: ${i + 1}\nevent: ${frame.type}\ndata: ${JSON.stringify(encodeFrame(frame))}\n\n`)),
  );

/* ------------------------------ groups ------------------------------ */

export const SystemLive = HttpApiBuilder.group(FeatherApi, "system", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfig;
    const sql = yield* PgClient.PgClient;
    const queries = yield* Queries;
    const quality = yield* Quality;
    const sched = yield* SchedulingRepo;
    const metrics = yield* Metrics;
    return handlers
      .handle("healthz", () => Effect.succeed({ status: "ok" as const, version: "2.0.0" }))
      .handle("readyz", () =>
        sql`SELECT 1`.pipe(
          Effect.as({ status: "ready" as const, database: "ok" as const }),
          Effect.mapError(() => new ApiUnavailable({ message: "database not reachable" })),
        ),
      )
      .handle("status", () =>
        Effect.gen(function* () {
          const dbOk = yield* sql`SELECT 1`.pipe(Effect.as(true), Effect.catchAll(() => Effect.succeed(false)));
          const beats = yield* queries.heartbeats().pipe(Effect.catchAll(() => Effect.succeed([])));
          const now = Date.now();
          const ledger = yield* queries.ledgerCountsForStatus().pipe(Effect.catchAll(() => Effect.succeed({ conversations_total: 0, outcomes: {}, guardrails: {}, reliability: {} })));
          // Read once and reused below: the rate-limit block reports three of these by name, and
          // taking a second snapshot could disagree with the first.
          const counters = yield* metrics.snapshot();
          /**
           * The snapshot is `{uptime_seconds, counters: {...}, histograms: {...}}`, so a named
           * counter lives one level down. Read as `unknown` and coerced rather than cast: a missing
           * counter is 0 requests, which is the truth before the first one is shed.
           */
          const counted = (name: string): number => {
            const inner = (counters as { counters?: Record<string, unknown> }).counters ?? {};
            const v = inner[name];
            return typeof v === "number" ? v : 0;
          };
          return {
            ok: dbOk,
            database: dbOk ? ("ok" as const) : ("down" as const),
            agents: beats.map((b) => ({ ...b, online: now - Date.parse(b.last_seen_at) < 30_000 })),
            counters,
            ledger,
            // The counters are already wire-shaped; the ring is internal camelCase, so it is
            // mapped here rather than snake-casing the service's own type.
            // D6 puts the SLO verdict on status, not only on the quality report: an operator
            // glancing at health should see whether latency is meeting its target without opening
            // a second page. Over the most recent 50 calls, which is what "right now" means here.
            slo: yield* quality.sloStatus(50),
            provider_events: yield* metrics
              .providerEvents()
              .pipe(Effect.map((p) => ({ counters: p.counters, recent: p.recent.map((e) => ({ provider: e.provider, kind: e.kind, stage: e.stage, message: e.message, conversation_id: e.conversationId, at: e.at })) }))),
            turn_decider: cfg.turnDecider,
            demo_mode: cfg.demoMode,
            judge: { enabled: cfg.judge.enabled, model: cfg.judge.model },
            rate_limiting: {
              per_minute: cfg.rateLimitPerMinute,
              daily_turn_cap: cfg.dailyTurnCap,
              rejected_start: counted("rate_limited_start"),
              rejected_turn: counted("rate_limited_turn"),
              rejected_daily_cap: counted("rate_limited_daily_cap"),
              buckets: rateLimitBucketCount(),
            },
          };
        }),
      )
      .handle("latency", ({ urlParams }) => queries.latencyAggregate(Math.min(200, Math.max(1, urlParams.calls ?? 20))).pipe(Effect.orDie))
      .handle("heartbeat", ({ payload }) =>
        Effect.gen(function* () {
          const now = DateTime.toDateUtc(yield* DateTime.now);
          yield* sched.upsertHeartbeat(payload.agent_name, now, payload.meta ?? {}).pipe(Effect.orDie);
          // Only the listed conversations are touched, never a replace: several job processes share
          // one agent name, and each knows about only its own call.
          yield* sched.touchLiveness(payload.conversations ?? [], payload.agent_name, now).pipe(Effect.orDie);
          return { ok: true as const };
        }),
      )
      .handle("quality", ({ urlParams }) => quality.report({ calls: urlParams.calls, from: urlParams.from, to: urlParams.to }))
      .handle("providerEvents", ({ payload }) =>
        Effect.gen(function* () {
          for (const e of payload.events) {
            yield* metrics.providerEvent({ provider: e.provider, kind: e.kind, stage: e.stage, message: e.message, conversationId: e.conversation_id ?? null });
          }
          return { recorded: payload.events.length };
        }),
      );
  }),
);

export const CallsLive = HttpApiBuilder.group(FeatherApi, "calls", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* WorkflowService;
    const queries = yield* Queries;
    const metrics = yield* Metrics;
    return handlers
      .handle("start", ({ payload }) =>
        workflow
          .startCall({ borrowerId: payload.borrower_id, contactPointId: payload.contact_point_id, channel: payload.channel ?? "simulated", now: parseNow(payload.now) })
          .pipe(
            Effect.tap(() => metrics.increment("calls_started")),
            Effect.map((r) => ({ conversation_id: r.conversationId, workflow_execution_id: r.workflowExecutionId, call_attempt_id: r.callAttemptId, attempt_no: r.attemptNo, opening_text: r.openingText })),
            Effect.catchTags({
              NotFound: (e) => Effect.fail(mapNotFound(e)),
              PreCallRejected: (e) => metrics.increment("calls_rejected").pipe(Effect.zipRight(Effect.fail(mapPreCall(e)))),
            }),
            Effect.orDie,
          ),
      )
      .handle("borrowers", () => queries.borrowerDirectory().pipe(Effect.orDie));
  }),
);

export const ConversationsLive = HttpApiBuilder.group(FeatherApi, "conversations", (handlers) =>
  Effect.gen(function* () {
    const queries = yield* Queries;
    const orch = yield* Orchestrator;
    const runner = yield* TurnRunner;
    const metrics = yield* Metrics;
    const scores = yield* Scores;
    return handlers
      .handle("list", ({ urlParams }) =>
        queries.listConversations(Math.min(urlParams.limit ?? 50, 200), urlParams.offset ?? 0).pipe(Effect.orDie),
      )
      .handle("detail", ({ path }) =>
        Effect.gen(function* () {
          const d = yield* queries.conversationDetail(path.id).pipe(Effect.catchTag("NotFound", (e) => Effect.fail(mapNotFound(e))), Effect.orDie);
          const actions = yield* queries.scheduledActionsFor(d.conversation.workflow_execution_id).pipe(Effect.orDie);
          const jobs = yield* queries.outboxJobsFor(path.id).pipe(Effect.orDie);
          return {
            conversation: d.conversation,
            transcript: d.transcript,
            event_timeline: d.event_timeline,
            replay: { ...d.replay, toolCallIds: [...d.replay.toolCallIds], actionIds: [...d.replay.actionIds] } as Record<string, unknown>,
            scheduled_actions: actions.map((a) => ({ id: a.id, action_type: a.actionType, status: a.status, due_at: a.dueAt.toISOString(), payload: a.payload })),
            outbox_jobs: jobs.map((j) => ({ id: j.id, job_type: j.jobType, status: j.status, result: j.result, error: j.error, processed_at: j.processedAt?.toISOString() ?? null })),
          };
        }),
      )
      .handle("simulateTurn", ({ path, payload }) =>
        Effect.gen(function* () {
          const turnId = payload.turn_id ?? crypto.randomUUID();
          const r = yield* orch.processTurn({ conversationId: path.id, turnId, userText: payload.user_text }, () => Effect.void).pipe(
            Effect.catchTags({
              NotFound: (e) => Effect.fail(mapNotFound(e)),
              ConversationCompleted: (e) => Effect.fail(mapConflict(e)),
              TurnInProgress: (e) => Effect.fail(mapConflict(e)),
            }),
            Effect.orDie,
          );
          yield* metrics.increment("turns_processed");
          if (r.degraded) yield* metrics.increment("turns_degraded");
          return {
            turn_id: r.turnId,
            agent_text: r.agentText,
            new_state: r.newState,
            tool_called: r.toolCalled ? { name: r.toolCalled.name, args: r.toolCalled.args } : null,
            call_control_action: r.callControlAction,
            outcome: r.outcome,
            end_call: r.endCall,
            degraded: r.degraded,
          };
        }),
      )
      .handleRaw("turn", ({ path }) =>
        Effect.gen(function* () {
          // Raw handlers receive the undecoded request; decode the body against the contract.
          const payload = yield* HttpServerRequest.schemaBodyJson(TurnRequest).pipe(
            Effect.mapError((e) => new ApiBadRequest({ message: `invalid turn request: ${String(e)}`.slice(0, 300) })),
          );
          const frames = yield* runner
            .run({
              conversationId: path.id,
              turnId: payload.turn_id,
              userText: payload.user_text,
              playout: payload.playout ? { turnId: payload.playout.turn_id, heardText: payload.playout.heard_text, interrupted: payload.playout.interrupted } : undefined,
              supersede: payload.supersede,
            })
            .pipe(
              Effect.catchTags({
                NotFound: (e) => Effect.fail(mapNotFound(e)),
                ConversationCompleted: (e) => Effect.fail(mapConflict(e)),
                TurnInProgress: (e) => Effect.fail(mapConflict(e)),
              }),
            );
          yield* metrics.increment("turns_processed");
          return HttpServerResponse.stream(sseBytes(frames), {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
          });
        }),
      )
      .handle("signal", ({ path, payload }) =>
        orch.processSignal(path.id, toSignal(payload)).pipe(
          Effect.map((r) => ({ agent_text: r.agentText, new_state: r.newState, call_control_action: r.callControlAction, outcome: r.outcome, end_call: r.endCall })),
          Effect.catchTags({ NotFound: (e) => Effect.fail(mapNotFound(e)), ConversationCompleted: (e) => Effect.fail(mapConflict(e)) }),
          Effect.orDie,
        ),
      )
      .handle("noInput", ({ path }) =>
        orch.processNoInput(path.id).pipe(
          Effect.map((r) => ({ agent_text: r.agentText, new_state: r.newState, call_control_action: r.callControlAction, outcome: r.outcome, end_call: r.endCall })),
          Effect.catchTags({ NotFound: (e) => Effect.fail(mapNotFound(e)), ConversationCompleted: (e) => Effect.fail(mapConflict(e)) }),
          Effect.orDie,
        ),
      )
      .handle("latency", ({ path }) =>
        // 404 on an unknown conversation rather than an empty list, so the console can tell
        // "no such call" from "this call has no turns yet".
        queries.conversationDetail(path.id).pipe(
          Effect.catchTag("NotFound", (e) => Effect.fail(mapNotFound(e))),
          Effect.flatMap(() => queries.turnLatencies(path.id)),
          Effect.orDie,
        ),
      )
      .handle("scores", ({ path }) =>
        queries.conversationDetail(path.id).pipe(
          Effect.catchTag("NotFound", (e) => Effect.fail(mapNotFound(e))),
          Effect.flatMap(() => scores.listForConversation(path.id)),
          Effect.map((rows) =>
            rows.map((r) => ({
              conversation_id: r.conversationId,
              turn_id: r.turnId,
              name: r.name,
              value: r.value,
              data_type: r.dataType,
              string_value: r.stringValue,
              source: r.source,
              comment: r.comment,
              evidence: r.evidence,
              created_at: r.createdAt.toISOString(),
            })),
          ),
          Effect.orDie,
        ),
      )
      .handle("postScores", ({ path, payload }) =>
        Effect.gen(function* () {
          // The conversation must exist: a score against a typo'd id would sit in the table forever
          // with nothing to join it to. (The scenario suite's synthetic id is written server-side
          // and does not come through here.)
          yield* queries.conversationDetail(path.id).pipe(Effect.catchTag("NotFound", (e) => Effect.fail(mapNotFound(e))), Effect.orDie);
          /**
           * A `turn_id` must name a turn *of this conversation* (O8).
           *
           * The conversation was checked and the turn was not, so a score could name anything and
           * be accepted. The voice harness posted the scripted line it had spoken — `"BARGE-IN: I
           * can pay 550 on Friday"` — as a turn id for weeks: the rows landed, joined nothing, and
           * every one of them silently took the session-level fallback in `Tracing.score`. Nothing
           * was lost and nothing said anything was wrong, which is the worst of both.
           */
          const known = (yield* queries.turnLatencies(path.id).pipe(Effect.orDie)).map((t) => t.turn_id);
          const unknown = unknownTurnIds(known, payload.scores.map((s) => s.turn_id));
          if (unknown.length > 0) return yield* Effect.fail(new ApiBadRequest({ message: unknownTurnIdMessage(unknown) }));
          const records = payload.scores.map((s) => ({
            conversationId: path.id,
            turnId: s.turn_id ?? null,
            name: s.name,
            value: s.value,
            source: s.source,
            stringValue: s.string_value ?? null,
            comment: s.comment ?? null,
            evidence: s.evidence ?? null,
          }));
          // A caller gets told which of its scores were malformed and none are written. In-process
          // producers take the other branch deliberately (`recordMany` logs and skips a bad record
          // so one typo cannot cost a call its other measurements) — but a client that posted five
          // scores and silently got three back has no way to learn which two went missing.
          const problems = records.map(scoreRecordProblem).filter((p): p is string => p !== null);
          if (problems.length > 0) return yield* Effect.fail(new ApiBadRequest({ message: problems.join("; ").slice(0, 300) }));
          const written = yield* scores.recordMany(records).pipe(Effect.orDie);
          return { written };
        }),
      );
  }),
);

export const TestingLive = HttpApiBuilder.group(FeatherApi, "testing", (handlers) =>
  Effect.gen(function* () {
    const scenarios = yield* ScenarioRunner;
    const metrics = yield* Metrics;
    const strip = (r: Awaited<ReturnType<typeof scenarios.run> extends Effect.Effect<infer A, any, any> ? A : never>) => {
      const { frames: _frames, ...rest } = r;
      return rest;
    };
    return handlers
      .handle("scenarios", () => Effect.succeed(scenarios.list()))
      .handle("runScenario", ({ path }) =>
        scenarios.run(path.id).pipe(
          Effect.tap((r) => metrics.increment(r.passed ? "scenarios_passed" : "scenarios_failed")),
          Effect.map(strip),
          Effect.catchIf(
            (e): e is UnknownScenario => e instanceof UnknownScenario,
            (e) => Effect.fail(new ApiNotFound({ entity: "scenario", id: e.scenarioId })),
          ),
          Effect.orDie,
        ),
      )
      .handle("runAll", () => scenarios.runAll().pipe(Effect.map((rs) => rs.map(strip)), Effect.orDie));
  }),
);

export const VoiceLive = HttpApiBuilder.group(FeatherApi, "voice", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* VoiceSessions;
    return handlers.handle("createSession", ({ payload }) =>
      sessions
        .create({ borrowerId: payload.borrower_id, contactPointId: payload.contact_point_id, participantIdentity: payload.participant_identity, participantName: payload.participant_name, mode: payload.mode ?? "browser" })
        .pipe(
          Effect.map((s) => ({
            conversation_id: s.conversationId,
            workflow_execution_id: s.workflowExecutionId,
            call_attempt_id: s.callAttemptId,
            room_name: s.roomName,
            participant_identity: s.participantIdentity,
            participant_token: s.participantToken,
            livekit_url: s.livekitUrl,
            agent_name: s.agentName,
            dispatch_id: s.dispatchId,
          })),
          Effect.catchTags({
            NotFound: (e) => Effect.fail(mapNotFound(e)),
            PreCallRejected: (e) => Effect.fail(mapPreCall(e)),
            TelephonyError: (e: TelephonyError) => Effect.fail(new ApiUnavailable({ message: e.detail })),
          }),
          Effect.orDie,
        ),
    );
  }),
);

export const DemoLive = HttpApiBuilder.group(FeatherApi, "demo", (handlers) =>
  Effect.gen(function* () {
    const seed = yield* SeedService;
    const cfg = yield* AppConfig;
    return handlers
      .handle("seed", () => seed.run().pipe(Effect.orDie))
      .handle("reset", () => seed.reset().pipe(Effect.orDie))
      .handle("loadFixtures", ({ payload }) =>
        // Writes throwaway borrowers straight into the CRM tables: demo/dev only, never on a
        // deployment that is serving anything real.
        cfg.demoMode
          ? seed.loadFixtures({ count: payload.count, prefix: payload.prefix }).pipe(
              Effect.catchIf(
                (e): e is Error => e instanceof Error,
                (e) => Effect.fail(new ApiBadRequest({ message: e.message })),
              ),
              Effect.orDie,
            )
          : Effect.fail(new ApiBadRequest({ message: "load fixtures are only available with DEMO_MODE=true" })),
      );
  }),
);
