# ADR 0006 — Self-hosted LiveKit for local development; Cloud for the shared demo

- Status: accepted (2026-08-21)
- Related: [ADR 0001](0001-conversation-loop-in-the-control-plane.md), [ADR 0004](0004-hosting-node-behind-cloudflare-edge.md);
  spec `docs/plans/2026-08-21-local-selfhost-livekit-loadtest-spec.md`; results `docs/loadtest/README.md`

## Context

Feather-Lite is an interview artifact that mirrors a lending voice-agent product deliberately. Its
differentiation is the architectural thesis — a deterministic state machine as the authority, the
LLM as conversationalist only, and a durable event ledger with sim/voice equivalence — not product
breadth. Until now the media plane was the one part that only existed in someone else's cloud: every
voice path required LiveKit Cloud keys, so "can this run end to end without an account?" had no
answer, and there was no way to load-test the media path at all.

Running the SFU locally makes the ops story concrete: **the media server is a config value, not an
architecture decision.**

Two things were genuinely coupled to Cloud, both discovered by reading the worker rather than by
assumption:

1. **LiveKit Inference.** `apps/voice-worker/src/agent.ts` used `inference.STT` / `inference.TTS`,
   which resolve model strings like `deepgram/nova-3` through a **Cloud-only gateway**. A
   self-hosted `livekit-server` has no such gateway; the worker must talk to providers directly.
2. **The fake borrower's voice**, synthesised the same way.

SIP/PSTN is a third coupling, and it stays coupled: self-hosting it needs `livekit-sip` plus a real
trunk, which is out of scope.

## Decision

**Add a compose profile, not a fork.** `docker compose --profile livekit up -d livekit`
(`pnpm lk:up`) runs `livekit/livekit-server:v1.13.5` against `deploy/livekit/livekit.yaml`.
`pnpm db:up` still starts Postgres alone.

**Media through a single UDP port.** Docker Desktop on Windows has no host networking, and the
production default — a 50000–60000 UDP range — means publishing 10,000 ports through the NAT, which
is a nonstarter. The config uses the single-port UDP mux (`rtc.udp_port: 7882`) that exists for
exactly this, with `rtc.tcp_port: 7881` as an ICE/TCP fallback, and forces `--node-ip 127.0.0.1` so
the server advertises a host-reachable candidate instead of the container's bridge address.
`room.auto_create: false` keeps parity with Cloud: the control plane creates every room explicitly.

**Cloud ↔ local is an .env change and nothing else.** `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET` already flowed from config through `VoiceSessions`, the worker and every tracer
script, so no code reads a "which LiveKit" flag. The **one** new switch is `STT_TTS_PROVIDER`:

- `inference` (default) — unchanged Cloud behaviour.
- `plugins` — `@livekit/agents-plugin-deepgram` STT + `@livekit/agents-plugin-cartesia` TTS with
  their own API keys, reusing the same `LIVEKIT_STT_MODEL` / `LIVEKIT_TTS_MODEL` strings with the
  `provider/` prefix stripped, so one env block describes both targets. It fails fast with an
  actionable message when a key is missing.

The factory lives in `apps/voice-worker/src/speech.ts` and is used by both the agent session and the
fake borrower. Everything else in the session — silero VAD, the multilingual EOT detector, the
`RemoteOrchestratorLLM` that streams `POST /api/conversations/:id/turn` — is provider-independent
and unchanged. ADR 0001's invariant is untouched: only *where media flows* moved.

**SIP fails fast when self-hosted.** A `mode: "sip"` job with no `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` now
fails the attempt before the session is built, with a log line naming the missing config, instead of
timing out on a dial that can never happen.

## Consequences

### The local media path works, and it is the faster one

Verified on 2026-08-21 against the containerised server, in order:

| Check | Result |
|---|---|
| Container healthy, `GET http://127.0.0.1:7880` | 200 OK, `livekit 1.13.5`, `nodeIP 127.0.0.1`, UDP mux 7882 |
| Room create / list / dispatch / token (`pnpm --filter @feather-lite/voice-worker lk-smoke`) | pass |
| Worker registers | `registered worker … edition: "Standard", version 1.13.5` |
| **Headless voice regression + SPEC §10.5 equivalence** | **pass** — 45 s call, barge-in truncated the agent mid-sentence, state path / tools / outcome identical to the simulation scenario |
| Browser call (headless Chrome → console → local SFU) | pass — ICE resolved, live transcript both sides, barge-in visible, ledger reached `PROMISE_TO_PAY` |

ICE over the published UDP mux worked first try from both `@livekit/rtc-node` and Chrome; the TCP
fallback was never needed. None of the §7 bail-out criteria were hit, so the Cloud fallback was not
taken.

### The Cloud fallback stays green — but only via `STT_TTS_PROVIDER=plugins`

Re-running the same regression with `.env` switched back to Cloud gave a result worth recording:

| Media plane | STT/TTS | Runs | Equivalence |
|---|---|---|---|
| Self-hosted `ws://127.0.0.1:7880` | `plugins` | 1 | pass |
| LiveKit Cloud | `plugins` | 1 | pass (47 s, first transcript in 0.6 s) |
| LiveKit Cloud | `inference` | 3 | **fail, all three** |

The failure mode is not the SFU and not this repo's code — the same Cloud SFU passes with direct
plugins in the same session. It is **LiveKit Inference STT latency** from this machine. The worker's
own `eou_metrics` recorded `transcriptionDelayMs` of 5137, 10504 and 18239 ms across the three runs,
against 200–500 ms for direct Deepgram. At those delays the agent's 12 s `userAwayTimeout` fires
before the transcript arrives, the borrower's turn is scored as silence, and the call ends
`NO_ANSWER` instead of `PROMISE_TO_PAY` — a correct reaction to a broken input, and the ledger says
so honestly.

So `STT_TTS_PROVIDER` turns out to be more than a self-hosting requirement: it is an escape hatch
from a degraded managed dependency, which is the same reason the LLM and the tracer sit behind
seams. The `inference` default is kept (it is the zero-key path on Cloud), but the demo runbook
should prefer `plugins` when direct keys are available.

The scripted borrower's wait bounds were widened as part of this (60 s to hear the agent start
speaking, vs 20 s) — the old heuristics silently assumed local-grade latency and would barge in
before the agent had spoken, which is not a barge-in at all.

### Load testing became possible, and moved the bottleneck story

Full numbers in `docs/loadtest/README.md`. Two findings belong here:

- **Control-plane correctness under load is unconditional.** 10 / 50 / 100 / 200 concurrent
  conversations, every one replaying to the expected scripted outcome; zero 409s, zero pool errors,
  zero lock waits.
- **The saturation point is the single Node process, not Postgres.** Throughput plateaus near
  70–85 turns/s and further concurrency becomes pure latency. Raising `DB_MAX_CONNECTIONS` from 10
  to 40 made it *slower* (83.5 → 78.2 turns/s) with 22 of 30 backends idle-in-transaction. The
  scaling lever is a second server process; the pool default stays 10.
- **Voice: N=5 green and repeatable; N=10 is the CPU ceiling** (measured 10/10 once, 9/10 once). The
  single N=10 failure is worth keeping: the read-back was not fully played out under CPU starvation,
  so the fully-heard guard *refused* to record the promise and the call closed `NO_ANSWER`. Losing
  equivalence in that direction — no promise rather than an unconfirmed one — is the behaviour the
  three-phase turn exists to produce.

Two guardrails became config so a load run does not fight the public-demo hardening:
`RATE_LIMIT_PER_MINUTE` (default 120) and `DAILY_TURN_CAP` (default 5000). Defaults are unchanged.

### Costs and limits

- SIP/PSTN remains Cloud-only. The self-hosted profile has no `livekit-sip` and no trunk.
- No TURN/TLS: the local server is bound for localhost use, and the committed `devkey` secret is a
  development credential. Nothing here should be exposed to the internet.
- `plugins` mode spends Deepgram and Cartesia credits directly instead of LiveKit inference credit.
- One extra demo-only route, `POST /api/demo/load-fixtures`, mints throwaway borrowers. It exists
  because two pre-call rules — one live conversation per borrower, and the 7-in-7 frequency cap —
  make C concurrent conversations require C distinct borrowers.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep Cloud-only for everything | No offline path, no way to load-test media, and the Inference outage above would have been unexplainable rather than diagnosed |
| Publish the 50000–60000 UDP range to the container | 10k published ports through Docker Desktop's NAT on Windows; the UDP mux exists precisely to avoid this |
| Host networking for the container | Not available on Docker Desktop for Windows |
| Self-host `livekit-sip` too | Needs a real SIP trunk and carrier config; out of scope, and PSTN was already listed as unverified |
| Keep `inference` and wrap it in retries | Treats a 10–18 s transcription delay as transient; the provider seam is the honest fix |
