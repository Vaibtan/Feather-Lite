/**
 * How long the borrower is given to speak before the agent checks whether they are still there
 * (issue #1, D1's `wait`).
 *
 * One number governs every silence on the call: the control plane sends it on every turn as
 * `extend_away_ms`, and the worker's clock is armed from it and from nothing else. The SDK's own
 * away timer is disabled, because two clocks driving one strike counter cannot be made safe — the
 * counter closes the call on its second strike.
 *
 * The ladder the windows drive already exists: `noInputPrompt` asks "Are you still there?" on the
 * first strike and closes the attempt as `NO_ANSWER` on the second.
 */

import type { HoldKind } from "./holdRequest.js";

/**
 * An ordinary turn: the agent has finished speaking and is waiting to be answered. Matches the
 * pinned SDK's own `userAwayTimeout` default, which is the behaviour every measurement to date was
 * taken under.
 */
export const SILENCE_WINDOW_MS = 12_000;

/**
 * A bare hold — "wait", "actually, wait", "hold on". The borrower asked for a beat and did not say
 * they were going anywhere, so a beat is what they get before the agent asks again.
 */
export const WAIT_WINDOW_BARE_MS = 5_000;

/**
 * A hold that names an errand — "let me get my card", "give me a minute". Long enough to walk to a
 * wallet and back, because talking over exactly that is the defect D1 exists to remove.
 */
export const WAIT_WINDOW_ERRAND_MS = 15_000;

/** From "Are you still there?" to hanging up. A bare hold therefore ends a dead call at 20 s. */
export const NUDGE_WINDOW_MS = 15_000;

export const waitWindowMs = (kind: HoldKind): number => (kind === "errand" ? WAIT_WINDOW_ERRAND_MS : WAIT_WINDOW_BARE_MS);
