# ADR 0004 — Hosting: one Node process behind a Cloudflare Tunnel, console on Cloudflare Pages, Postgres on Neon

- Status: accepted (2026-08-16); see `docs/deploy/free-tier-live-demo.md` for the runbook
- Related: [ADR 0001](0001-conversation-loop-in-the-control-plane.md)

## Context

The demo must be **free** and ideally a **live URL**. Cloudflare's free tier is available. Verified
limits at decision time (2026-08-16):

| Service | Free tier | Fit |
|---|---|---|
| Cloudflare Workers | 100k req/day, **10 ms CPU per invocation** | Too small for Effect + Postgres + streaming an LLM turn; a scenario run-all in one request is impossible |
| Cloudflare Pages | unlimited static, 500 builds/month | Console (static Vite app) |
| Cloudflare Tunnel | free, no account needed for a quick tunnel (`trycloudflare.com`), named tunnels with an account | Public URL for the laptop-hosted API |
| Neon Postgres | 0.5 GB, 100 CU-hours/month, autosuspend after 5 min, Singapore region | Ledger for the live demo |
| LiveKit Cloud Build | 1,000 agent minutes, $2.50 inference credit, SIP, 1 free US number, India-West region | Media, STT/TTS via LiveKit Inference |
| Oracle Cloud Always Free | Ampere A1 2 OCPU / 12 GB, $0 always-on VM | The only free always-on host for the Node processes |

## Decision

- `apps/server` (HTTP API + in-process schedulers) and `apps/voice-worker` run as plain Node
  processes — on the laptop during the interview, or on an Oracle Always Free VM for always-on.
- A Cloudflare Tunnel exposes the API (`https://<name>.trycloudflare.com` or a named tunnel on the
  user's zone). Nothing in the code depends on the tunnel; the console reads the API base from
  `?api=` / localStorage.
- `apps/console` is a static build deployed to Cloudflare Pages (`pnpm deploy:console`). It shows
  API / DB / agent-worker liveness so a viewer knows immediately whether the live path is up.
- Postgres on Neon (free) for the public demo; local Docker Postgres for development and tests.

## Consequences

- The whole demo is $0. The API is only up while a Node process runs somewhere; the console is
  always up and says so honestly.
- `@effect/platform` HttpApi is runtime-agnostic (`HttpApiBuilder.toWebHandler`), so an
  `apps/edge` Workers mount of the same `packages/control-plane` remains possible if measured CPU
  fits — the design does not depend on where it runs.
- Durable Objects / Queues / Workflows (all on the free tier) were considered for the outbox and
  per-conversation serialisation; Postgres row locks + `SKIP LOCKED` already give the same
  guarantees with one fewer moving part, so they stay a stretch item.
