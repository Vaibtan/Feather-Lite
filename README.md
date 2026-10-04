# Feather-Lite

A voice-agent platform for debt-collection conversations, built with TypeScript, Effect, PostgreSQL and LiveKit.

The language model proposes responses and actions. The control plane validates business actions and records them in a durable event ledger; the voice worker handles speech and audio playback.

## What it does

- Runs browser voice calls and scripted conversation scenarios.
- Tracks conversations, callback requests and promises to pay.
- Requires completed playback of the exact payment read-back before a voice promise can be recorded.
- Provides an operator console with transcripts, events and quality results.
- Exposes operational metrics and optional Langfuse tracing.

The project is under active development. Authentication, staffed follow-up, telephone reliability and a unified Docker observability stack are covered in the [implementation plans](docs/plans/). It is not ready for real-borrower collection.

## Run locally

Install Docker and the Node.js/pnpm versions specified in [package.json](package.json). Copy [.env.example](.env.example) to `.env`, then run:

```sh
pnpm install
pnpm db:up
pnpm dev:server
```

The server applies database migrations on startup. In another terminal, load synthetic accounts and start the console:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/demo/seed
pnpm dev:console
```

Open [the console](http://127.0.0.1:5173). API documentation is available at [localhost:8080/docs](http://127.0.0.1:8080/docs).

The default scripted decider supports simulations without AI credentials. For model responses, set `TURN_DECIDER=openai` and `OPENAI_API_KEY` in `.env`.

### Voice and tracing

Voice calls also need LiveKit and speech-provider credentials from `.env.example`. On Windows, run the voice worker in Docker. Stop the host API first to free its port, then start the container services:

```sh
docker compose --profile livekit --profile app up -d --build
```

Configure `LIVEKIT_NODE_IP` to an address reachable by both the browser and containers. The console still runs separately. Telephone calls additionally require a configured SIP service and trunk; the current local stack does not include the SIP service.

For optional local Langfuse, run `pnpm lf:up` and configure its endpoint and keys as described in `.env.example`. This starts a separate tracing stack; it does not enable application tracing automatically.

## Development

```sh
pnpm check           # Agent setup validation, typechecks and ordinary tests
pnpm build           # Server and voice worker
pnpm console:build   # Operator console
```

Database tests use `pnpm test:db` and truncate their target tables. Run them only against a dedicated test database.

## Find your way around

| Directory | Purpose |
| --- | --- |
| `packages/domain` | Business rules and state transitions |
| `packages/contracts` | API and streaming contracts |
| `packages/control-plane` | Orchestration, persistence and background jobs |
| `apps/server`, `apps/voice-worker` | API and voice runtimes |
| `apps/console`, `apps/load-test` | Operator interface and load harness |

See the [architecture decisions](docs/adr/), [load-test evidence](docs/loadtest/README.md), and [plans and implementation handoffs](docs/plans/) for details.
