# ADR 0003 — A turn is three phases: claim (tx) → decide (no tx) → commit (tx) → speak

- Status: accepted (2026-08-16), implemented in `packages/control-plane/src/services/Orchestrator.ts` (`processTurn`)
- Related: [ADR 0001](0001-conversation-loop-in-the-control-plane.md), plan revision 2 findings R3/R6/R8

## Context

The LLM call is the slow, failure-prone part of a turn (1–3 s, occasionally 20 s or an error), and
the durable parts (events, tool side effects, outcome, scheduled actions, outbox) must be atomic
and ordered by `sequence_no`. Holding a Postgres row lock across the LLM call would serialise a
conversation on the model's latency and pin a pool connection per in-flight turn. Not locking at all
lets a barge-in turn and the turn it interrupted both write to the ledger out of order.

We also need: **turn idempotency** (the worker or the browser may re-send the same `turn_id` after
a reconnect), **supersede** (a barge-in makes the previous turn moot), and the promise that the
borrower hears "recorded" only after it *is* recorded.

## Decision

`processTurn(params, emit)` runs:

1. **T1 — claim** (`sql.withTransaction`): `SELECT … FOR UPDATE` the conversation; if a turn with
   this `turn_id` is already `DONE`, return its recorded result (idempotent replay, even after the
   conversation completed); reject if completed (`409`); if another turn is active, either fail
   `TurnInProgress` or, with `supersede:true`, mark it `SUPERSEDED` (event `TURN_SUPERSEDED`);
   CAS `active_turn_id`; append `AGENT_TURN_PLAYOUT` (heard text) and `USER_TURN_FINAL`; build the
   decider context; commit. Emit `turn_start`.
2. **Decide** (no transaction): compliance overrides first (`OPT_OUT > DISPUTE > HARDSHIP >
   WRONG_NUMBER`) — if one matches, no model call at all; otherwise stream the `TurnDecider`
   (`delta` frames flow to the client while the model is still talking).
3. **T2 — commit** (`sql.withTransaction`): re-lock, verify `active_turn_id` is still ours
   (otherwise the turn was superseded — write nothing), validate the suggested transition against
   the adjacency table and the tool against the state matrix (**fail closed**: `TOOL_REJECTED` /
   `TURN_DECISION_REJECTED` events + safe fallback text), execute the tool idempotently by
   `tool_call_id`, append `TOOL_CALLED/TOOL_RESULT/STATE_TRANSITION/AGENT_TURN`, finalize
   (outcome, closing path, scheduled actions, outbox jobs — all in this transaction), record the
   turn result; commit.
4. **Speak after commit**: `say` frames (read-backs, confirmations) and `turn_end` are emitted only
   after T2 committed. "I have recorded your promise to pay…" is therefore never heard for a promise
   that was not durably written.

## Consequences

- No lock is held while waiting on the model; the pool is not exhausted by slow turns.
- A superseded turn's model output is discarded at T2 — the ledger has one truth per turn.
- Two-mode streaming falls out naturally: chat turns stream `delta`s early; tool turns (proposal
  read-back, recorded confirmation) buffer and emit `say` frames after commit.
- The cost is two short transactions per turn and a small "verify still active" re-check; the
  concurrency test (`test/db/concurrency.test.ts`) covers the 409 / supersede paths.
