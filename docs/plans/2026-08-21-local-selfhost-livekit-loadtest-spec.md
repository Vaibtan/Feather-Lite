# Spec: Fully local stack (self-hosted LiveKit) + heavy-load end-to-end testing

Date: 2026-08-21 · Status: approved by user, ready to implement · Target: one implementation session (Opus 5)

## 0. Read first (do not re-derive)

You are in `D:\SWE_DEV_NEW\Feather-Lite` on Windows 11 (PowerShell + Git Bash, Node 22, pnpm 11,
Docker Desktop). v2 (TypeScript + Effect 3.22) is complete through Phase 7 on `main`. Before coding, read:

- `README.md` — thesis, status table, architecture diagram, run recipes, "Not built" list
- `docs/adr/0001`–`0005` — especially 0001 (control plane owns the loop), 0003 (three-phase turn), 0004 (hosting)
- `docs/plans/PROGRESS.md` — one line per phase
- `.env.example` — every knob; real secrets live in gitignored `.env` (never print or commit its values)

**Architecture invariants you must not violate:**

1. The control plane owns the conversation loop (`POST /api/conversations/:id/turn`, SSE frames
   `turn_start → delta* → say* → turn_end|error`). The voice worker's `llmNode` just streams that endpoint.
2. Three-phase turn in `packages/control-plane/src/services/Orchestrator.ts`: T1 claim → decide → T2 commit →
   speak only after commit. Do not touch this logic; you are only changing *where media flows*.
3. Everything swaps by Effect Layer / env config. New behavior must follow the same pattern: an env switch,
   not a fork of the code path.
4. Concurrency correctness lives in Postgres (row locks, `active_turn_id` CAS, `SKIP LOCKED`), not the runtime.

## 1. Goal and decision

**User's stated goal (verbatim intent):** set up *everything* locally — including the LiveKit media
server — and verify the whole app end to end under heavy load. **LiveKit Cloud remains the fallback**:
if the Windows/Docker environment makes the local WebRTC path unworkable (see §7 bail-out criteria),
revert to Cloud (current `.env` already has working Cloud keys) and record why in the ADR.

Positioning context (bake a short version into ADR 0006's context section): Feather-Lite is an interview
artifact mirroring Feather's domain deliberately; the differentiation is the architectural thesis
(deterministic state machine as authority, LLM as conversationalist only, event ledger with sim/voice
equivalence), not product breadth. A fully self-hosted, load-tested local stack strengthens the ops story:
"the media server is a config value, not an architecture decision."

## 2. What is already decoupled vs. what is Cloud-coupled

Verified against current code:

- **Already portable** (reads `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` from config, works
  against any LiveKit server): room create + agent dispatch + participant tokens in
  `packages/control-plane/src/services/VoiceSessions.ts`; worker connection in
  `apps/voice-worker/src/agent.ts`; all tracer scripts in `apps/voice-worker/src/tracer/*`.
  Explicit agent dispatch (`AgentDispatchClient`) is supported by the OSS server.
- **Cloud-coupled #1 — STT/TTS:** `apps/voice-worker/src/agent.ts:93-95` uses `inference.STT` /
  `inference.TTS` (LiveKit **Inference is a Cloud-only gateway**; it does not exist on a self-hosted
  server). Must be swappable to direct-provider plugins.
- **Cloud-coupled #2 — fake borrower's voice:** `apps/voice-worker/src/tracer/fake-borrower.ts:42`
  synthesizes its three lines with `inference.TTS`. Must also be swappable (and cached, see §5.3).
- **Cloud-coupled #3 — SIP/PSTN:** out of scope locally (would need `livekit-sip` + a trunk). The
  `mode: "sip"` path stays Cloud-only; guard it with a clear error when running self-hosted.

## 3. Phase A — self-hosted LiveKit in Docker

### 3.1 Compose

Add a `livekit` service to the root `docker-compose.yml` under a compose **profile** named `livekit`
(so `pnpm db:up` alone still starts only Postgres):

```yaml
  livekit:
    image: livekit/livekit-server:latest   # pin the current tag you find at implementation time
    container_name: feather-lite-livekit
    profiles: ["livekit"]
    command: --config /etc/livekit.yaml --node-ip 127.0.0.1
    ports:
      - "7880:7880"        # signalling / WebSocket API (ws://127.0.0.1:7880)
      - "7881:7881"        # ICE over TCP fallback
      - "7882:7882/udp"    # single-port UDP mux for all media
    volumes:
      - ./deploy/livekit/livekit.yaml:/etc/livekit.yaml:ro
```

`deploy/livekit/livekit.yaml` (new file):

```yaml
port: 7880
bind_addresses:
  - 0.0.0.0
rtc:
  udp_port: 7882          # single-port UDP mux — do NOT use port_range_start/end on Docker Desktop
  tcp_port: 7881
  use_external_ip: false  # local only; node_ip is forced to 127.0.0.1 via --node-ip
room:
  auto_create: false      # the control plane creates rooms explicitly; keep parity with Cloud
  empty_timeout: 300
keys:
  devkey: "<generate a random secret at implementation time; it is local-only but do not use 'secret'>"
logging:
  level: info
```

Rationale (verified against livekit/livekit config docs): a 50000–60000 UDP port range is the production
default but publishing 10k ports through Docker Desktop's NAT is a nonstarter on Windows; the UDP mux
(`udp_port`) exists exactly for this. `--node-ip 127.0.0.1` makes the server advertise a host-reachable
ICE candidate instead of the container's internal IP. `tcp_port` gives an ICE/TCP fallback if UDP through
the Docker NAT misbehaves.

Add root scripts (follow the style of the existing `db:up`): `lk:up` → `docker compose --profile livekit up -d livekit`,
`lk:down`, and extend the README run recipe.

### 3.2 Env switching (Cloud ↔ local is *only* an .env change)

Extend `.env.example` with a clearly delimited "self-hosted LiveKit" block:

```
# --- Self-hosted LiveKit (docker compose --profile livekit) ---
# LIVEKIT_URL=ws://127.0.0.1:7880
# LIVEKIT_API_KEY=devkey
# LIVEKIT_API_SECRET=<same value as deploy/livekit/livekit.yaml>
# STT_TTS_PROVIDER=plugins        # inference (default, Cloud) | plugins (Deepgram+Cartesia direct)
# DEEPGRAM_API_KEY=...
# CARTESIA_API_KEY=...
```

No code reads a "which LiveKit" flag — the URL/key/secret are sufficient for media. The **only** new
switch is `STT_TTS_PROVIDER` in the worker (next section). Everything else (server, console, tracers)
must work unchanged against either target. That property is the point; preserve it.

### 3.3 STT/TTS provider switch in the worker

In `apps/voice-worker`:

- Add deps `@livekit/agents-plugin-deepgram` and `@livekit/agents-plugin-cartesia` at the same minor
  as `@livekit/agents` (currently `^1.6.4`). Both packages exist in livekit/agents-js; Deepgram's plugin
  exports classic `STT` (nova models) and `STTv2` (flux); Cartesia's exports `TTS` (sonic models).
  **Verify exact constructor options against the installed package's README/types at implementation
  time** (ctx7: `/livekit/agents-js`) — do not trust this spec for signatures.
- Add a small factory (e.g. `src/speech.ts`) returning `{ stt, tts }` from env:
  - `STT_TTS_PROVIDER=inference` (default) → current behavior, `inference.STT/TTS` with the existing
    `LIVEKIT_STT_MODEL` / `LIVEKIT_TTS_MODEL` / `LIVEKIT_TTS_VOICE` strings.
  - `STT_TTS_PROVIDER=plugins` → `deepgram.STT` with model `nova-3` (map from the existing
    `LIVEKIT_STT_MODEL` by stripping the `deepgram/` prefix; same for Cartesia `sonic-3` + voice id).
    Keys via `DEEPGRAM_API_KEY` / `CARTESIA_API_KEY` (both providers have free tiers/credits).
    Fallback if the user has no Cartesia key at implementation time: `@livekit/agents-plugin-openai`
    TTS on the existing `OPENAI_API_KEY` (different voice than the current demo — note it in ADR 0006).
  - Fail fast with an actionable message if `plugins` is selected and a key is missing.
- Use the factory in `agent.ts` (AgentSession construction) — nothing else in the session changes
  (silero VAD, multilingual EOT turn detector, and the `RemoteOrchestratorLLM` are all provider-independent).

### 3.4 SIP guard

When `mode === "sip"` is requested and `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` is unset (which it will be
locally), the worker already needs a trunk; make the failure explicit and early (clear log + attempt
marked FAILED via the existing hangup path) rather than a timeout.

### 3.5 Phase A acceptance criteria (all must pass, in order)

1. `docker compose --profile livekit up -d` → healthy; `curl http://127.0.0.1:7880` responds (LiveKit
   answers HTTP on the WS port).
2. Token/API smoke: a tiny script (or `lk` CLI if installed) creates a room and lists it via
   `RoomServiceClient` against `ws://127.0.0.1:7880`.
3. Worker registers: `pnpm dev:worker` with the local env connects and logs registration.
4. **Headless voice regression on the local stack**: `pnpm --filter @feather-lite/voice-worker fake-borrower`
   (with `STT_TTS_PROVIDER=plugins`) completes the scripted call and — the real gate — the event
   sequence matches the equivalent simulation scenario (SPEC §10.5 equivalence), same as it did on Cloud.
5. **Browser call**: console → "call me in the browser" joins the local server, live transcript works,
   barge-in works. (Vite already binds `127.0.0.1`; browser and server are both on localhost so ICE
   should resolve via the `127.0.0.1` candidate over UDP 7882, TCP 7881 as fallback.)
6. Switching `.env` back to the Cloud block and re-running (4) still passes — the fallback stays green.

## 4. Phase B — load testing

Two tiers, because they measure different things and have different cost profiles. Build tier 1 first;
it is the "heavy" one. Use `/tdd` for the harness where practical.

### 4.1 Tier 1 — control-plane load (heavy: hundreds of conversations)

New package or script dir `apps/load-test` (plain tsx script(s), no framework):

- Drives `POST /api/workflows/... start` + the SSE `/turn` endpoint directly with
  `TURN_DECIDER=scripted` (deterministic, free, exercises the full three-phase turn + Postgres path —
  row locks, `active_turn_id` CAS, outbox/scheduled-action workers — which is where the concurrency
  thesis lives).
- Parameters (flags or env): number of concurrent conversations `C`, turns per conversation (drive each
  scripted conversation to its natural outcome), ramp-up seconds, total duration or iteration count.
- Metrics captured per turn from existing data (`turn_end.ttft_ms` is already in the frame protocol) plus
  client-observed wall time: p50/p95/p99 TTFT, p50/p95/p99 turn wall time, error/409/timeout counts,
  throughput (turns/s). Print a summary table and write a JSON report to `docs/loadtest/<date>-tier1.json`.
- Also record DB-side saturation: pool exhaustion errors, and (nice-to-have) a `pg_stat_activity`
  snapshot at peak.
- Suggested run matrix: C = 10, 50, 100, 200 against the local server + local Postgres. Find the knee;
  raise `DB_MAX_CONNECTIONS` deliberately, not reflexively, and note what actually saturates.
- Acceptance: at C=100, zero incorrect outcomes (every conversation's final ledger replays to the
  expected scripted outcome — reuse the scenario assertion helpers), and a written summary of the
  latency distribution in the report file. Correctness under load *is* the demo claim; latency numbers
  are reported, not gated.

### 4.2 Tier 2 — voice load (modest: single-digit concurrent calls)

Real audio through the self-hosted SFU with real STT/TTS costs provider credits and CPU; the goal is
"the media plane and worker handle N simultaneous calls correctly," not raw scale.

- Generalize `fake-borrower.ts` (or add `fake-borrower-fleet.ts`) to run `N` concurrent scripted calls
  (distinct borrowers — seed data permitting; extend the seed if needed).
- **Cache synthesized borrower lines to WAV on disk** (first run synthesizes via the active TTS provider,
  later runs replay frames) so a 10-call fleet doesn't pay TTS for 30 identical lines every run.
- N = 2, then 5, then 10. Capture per-call: event-sequence equivalence vs the simulation scenario,
  worker TTFT metrics (already logged via `MetricsCollected`), and any dropped/failed calls.
- Acceptance: N=5 with all calls equivalence-green on the local stack. N=10 is stretch; if the
  bottleneck is laptop CPU (silero VAD + Opus encode ×10), record the number and move on — that is an
  honest, defensible result.

## 5. Phase C — documentation (part of done, not optional)

1. **ADR 0006 — "Self-hosted LiveKit for local dev; Cloud for the shared demo."** Context (incl. the
   positioning paragraph from §1), the Inference coupling discovered, the UDP-mux/node-ip Docker
   decision, the STT/TTS switch design, SIP staying Cloud-only, and the bail-out criteria + outcome.
2. README: status table row, run recipe (`pnpm lk:up`, env block), and move the relevant "Not built"
   items. Add a short "load test results" pointer to `docs/loadtest/`.
3. `docs/plans/PROGRESS.md`: one line for this phase.
4. `.env.example`: §3.2 block.

## 6. Environment gotchas (learned the hard way — trust these)

- Bash heredocs with Unicode break on this Windows setup → use the Write tool or small script files.
- Vite must stay bound to `host: "127.0.0.1"` (already configured) — headless Chrome can't reach
  `localhost` (IPv6-only resolution).
- Kill stray listeners with PowerShell: `Get-NetTCPConnection -LocalPort 8080` → `Stop-Process`.
  Background processes from prior sessions may still hold :8080/:5173.
- DB tests need `--no-file-parallelism` (already in scripts); tests use the separate `feather_lite_test` DB.
- The DB may contain old scenario-run conversations; console Status → "Reset demo data" cleans it.
- Docker Desktop on Windows: no host networking; everything must go through published ports — which is
  exactly why §3.1 uses the single-port UDP mux.

## 7. Bail-out criteria (fallback to LiveKit Cloud)

Revert the `.env` to the Cloud block (keys already present and working) and record the failure mode in
ADR 0006 if, after a reasonable diagnosis effort (~2 hours on the media path specifically):

- The browser cannot establish a media connection to the containerized server (ICE fails on both UDP
  7882 and TCP 7881), or
- audio quality/latency through the Docker NAT is visibly broken (choppy playout, >1s added latency), or
- `@livekit/rtc-node` (fake borrower) cannot exchange audio with the containerized SFU on Windows.

Tier 1 load testing (§4.1) does **not** depend on LiveKit at all — if the media path bails out, tier 1
still proceeds in full, and tier 2 runs against Cloud at reduced N (mind the free-tier minutes).

## 8. Out of scope (do not build)

- SIP/PSTN self-hosting (`livekit-sip`), TURN/TLS for public exposure of the local server.
- Containerizing the Node apps (`docker-compose.full.yml`) — a separate, previously offered task; only
  pick it up if the user asks.
- Neon/Cloudflare deployment (runbook exists in `docs/deploy/free-tier-live-demo.md`; deferred to demo day).
- Go anything (settled: ADR 0005).

## 9. Suggested commit slices

1. `deploy/livekit/` + compose profile + root scripts + env example block (Phase A infra).
2. Worker STT/TTS factory + plugin deps + SIP guard (Phase A code) — run `/code-review` before landing.
3. Local end-to-end verification evidence (equivalence re-run) + README/PROGRESS updates.
4. Tier 1 load harness + first report.
5. Tier 2 fleet + report; ADR 0006 last (it needs the outcome).
