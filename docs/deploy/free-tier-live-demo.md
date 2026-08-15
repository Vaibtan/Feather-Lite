# Live demo on free tiers — runbook

Goal: a public console URL where a viewer can open conversations, run the scenario matrix, run a
simulated call, and (while your worker is up) **call the agent from the browser** — at $0.

```
 viewer's browser ── Cloudflare Pages (console, static, always up)
        │                         │  ?api=https://<tunnel-host>
        │ WebRTC                  ▼
        │              Cloudflare Tunnel ──► apps/server (Node, your laptop or a free VM)
        │                                        │  Postgres (Neon free)   OpenAI   Langfuse
        ▼                                        ▼
  LiveKit Cloud (Build tier) ◄── apps/voice-worker (Node, same machine; llmNode → /turn)
```

Everything below was chosen against limits verified on 2026-08-16 (see ADR 0004). Steps marked
**(you)** need your accounts; the code side is done.

## 0. Accounts (all free)

| Service | What for | Sign-up notes |
|---|---|---|
| LiveKit Cloud (Build) | media, agent dispatch, STT/TTS via LiveKit Inference | you already have a project; `LIVEKIT_URL/API_KEY/API_SECRET` in `.env` |
| Neon | Postgres for the public demo | pick a region near the worker (Singapore for India). Copy the pooled connection string, use `?sslmode=verify-full` |
| Cloudflare | Pages (console) + Tunnel (API URL) | free plan; a quick tunnel needs no account at all |
| OpenAI | the conversationalist (`TURN_DECIDER=openai`) | any paid key; GPT-4.1-mini/4.1 cost is cents per demo |
| Langfuse (Hobby) | traces per conversation/turn | optional; omit keys to run without |

## 1. Database — Neon (you)

1. Create a project → copy the connection string.
2. Put it in `.env` as `DATABASE_URL=postgres://…neon.tech/neondb?sslmode=verify-full`.
3. Start the server once (`pnpm start:server`) — migrations run on boot (`0001_initial`).
4. Seed: `curl -X POST https://<api>/api/demo/seed` (or **Status → Seed demo data** in the console).

Neon autosuspends after 5 minutes idle; the first request after that takes ~1 s. The console's
status pill will show `DB ok` once it is warm.

## 2. API on a public URL — Cloudflare Tunnel (you)

Quick tunnel (no account, random hostname, fine for a session):

```bash
pnpm tunnel            # = cloudflared tunnel --url http://127.0.0.1:8080
# → https://<random>.trycloudflare.com
```

Named tunnel (stable hostname on your zone):

```bash
cloudflared tunnel login
cloudflared tunnel create feather-lite
cloudflared tunnel route dns feather-lite api-feather.<your-zone>
cloudflared tunnel run --url http://127.0.0.1:8080 feather-lite
```

Server-side hardening for a public URL — set in `.env` before starting:

```
DEMO_MODE=true                # rate limits + daily turn budget + /api/demo/* + clock override
API_BEARER_TOKEN=<random>     # required on every mutating route; GET/health/docs stay open
TURN_DECIDER=openai
```

Then `pnpm start:server` (or `pnpm dev:server` for auto-reload). Check
`https://<api>/healthz`, `https://<api>/readyz`, `https://<api>/docs` (OpenAPI/Swagger).

## 3. Voice worker (you, same machine as the server is simplest)

```bash
pnpm start:worker      # registers as agent "feather-lite-agent" with LiveKit Cloud; heartbeats to the API
```

`CONTROL_PLANE_URL` defaults to `http://127.0.0.1:8080`; set it to the tunnel URL only if the
worker runs elsewhere. With `API_BEARER_TOKEN` set, the worker reads the same `.env` and sends it.
The console's **Status** page shows the worker online within ~10 s.

Optional PSTN: create a SIP outbound trunk in LiveKit Cloud (their free US number or a Twilio
trial number), set `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`, and the console's **Dial my phone (SIP)**
button will dial the borrower's contact point (AMD-gated). Not verified end-to-end in v2 — treat as
best-effort.

## 4. Console on Cloudflare Pages (you, once)

```bash
npx wrangler login
npx wrangler pages project create feather-lite-console --production-branch main
pnpm deploy:console      # builds apps/console and uploads dist/
```

Share the URL with the API base (and token) in it — the console stores both in `localStorage`
and strips the token from the address bar:

```
https://feather-lite-console.pages.dev/?api=https://<api-host>#token=<API_BEARER_TOKEN>
```

Or set them later on **Status → Console settings**. Hash routing (`#/conversations`, `#/simulate`,
`#/call`, `#/scenarios`, `#/status`) needs no Pages redirects.

## 5. Always-on option (you): Oracle Cloud Always Free

If the demo must stay up when the laptop is closed: an Ampere A1 VM (2 OCPU / 12 GB) at $0 runs
`apps/server` + `apps/voice-worker` + `cloudflared` under systemd. Node 22 + pnpm 11 +
`git clone` + `pnpm install` + `.env` is all that is required; nothing in the repo is
laptop-specific. (Not exercised in v2 — the interview run used the laptop + tunnel.)

## 6. Cost sheet (per interview demo, ~10 conversations)

| Item | Free allowance | Demo usage | Cost |
|---|---|---|---|
| LiveKit agent minutes | 1,000 / month | ~15 min | $0 |
| LiveKit Inference (Deepgram STT + Cartesia TTS) | $2.50 credit | ~$0.20 | $0 |
| Neon | 100 CU-h, 0.5 GB | < 1 CU-h, < 10 MB | $0 |
| Cloudflare Pages / Tunnel | unlimited static / free | — | $0 |
| OpenAI GPT-4.1-mini + GPT-4.1 | — | ~40 turns × ~2k tokens | ≈ $0.10–0.30 |
| Langfuse Hobby | 50k units / month | ~200 observations | $0 |

## 7. Smoke test against the public URL

```bash
API=https://<api-host>; TOKEN=<API_BEARER_TOKEN>
curl -s $API/api/system/status | jq .
curl -s -X POST -H "authorization: Bearer $TOKEN" $API/api/testing/scenarios/run-all | jq '[.[] | .passed] | all'
```

Then open the console URL: **Scenarios → Run all** (20/20), **Simulate**, **Live call**.

## Troubleshooting

- `DB down` on Status → Neon suspended or wrong `DATABASE_URL`; the first request wakes it.
- `no agent worker` → the worker process is not running or cannot reach the API (`CONTROL_PLANE_URL`, token).
- Browser call connects but no audio → the tab needs a user gesture for autoplay; click once on
  the page, or check the LiveKit project region/URL.
- 401 on POSTs from the console → token missing; open `…/?api=<url>#token=<token>` again.
- 429 → per-IP rate limit or daily turn budget (both only in `DEMO_MODE`).
