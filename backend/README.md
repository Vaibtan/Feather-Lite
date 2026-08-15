# Feather-Lite backend (Python reference implementation)

Status as of 2026-08-16 — see `docs/reviews/2026-08-16-plan-vs-implementation-review.md`:

- **Done:** schema + migrations, event-sourced conversations, state machine + tool gating,
  idempotent tools, pre-call validation, workflows / scheduled actions / outbox, replay,
  12-scenario runner, operator console.
- **Not done:** LLM (turn decisions are a keyword stub), telephony/SIP, AMD, no-input timer,
  Langfuse tracing, cross-call memory.

This Python tree is now the **reference implementation** for the TypeScript + Effect rebuild
under `packages/` and `apps/`. It is kept for comparison; new work happens in TypeScript.

## Run (local)

```
uv sync
# Postgres on localhost:5434 (see .env) then:
uv run alembic upgrade head
uv run seed-demo
uv run feather-lite-api           # http://127.0.0.1:8000
uv run pytest                     # 25 unit tests (no DB needed)
```

Scenario suite: `POST /api/testing/scenarios/{id}/run` (requires a live DB).
