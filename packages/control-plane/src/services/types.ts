/** Shared shapes between the orchestrator and turn deciders. */
import type {
  CallControlAction,
  ConversationState,
  Outcome,
  PendingProposal,
  ToolCall,
  ToolName,
  TurnChunk,
  VisibleContext,
} from "@feather-lite/domain";

export interface DeciderInput {
  readonly conversationId: string;
  readonly turnId: string;
  readonly state: ConversationState;
  readonly userText: string;
  /** What the borrower actually heard of the previous agent line, when it was interrupted. */
  readonly heardAgentText: string | null;
  readonly context: VisibleContext;
  readonly allowedTools: ReadonlyArray<ToolName>;
  readonly pendingProposal: PendingProposal | null;
  /** Recent transcript (oldest first), already limited. */
  readonly recentTranscript: ReadonlyArray<{ readonly speaker: "AGENT" | "BORROWER"; readonly text: string }>;
  readonly model: string;
  readonly borrowerLocalDate: string; // YYYY-MM-DD
  readonly borrowerTimeZone: string;
  readonly borrowerFirstName: string;
}

export type { TurnChunk };

/**
 * Which arm of the decide phase produced this turn's decision (F3).
 *
 * Distinct from `conversations.decider`, which names the decider *service* configured for the whole
 * call. Every turn of an `openai` call reads `openai` there whether the model was consulted or a
 * regex answered in a microsecond, and averaging those into one latency window is how a fast path
 * flatters a p95. `fast-path` is reserved for D2 and is not produced yet.
 */
export type TurnDecisionSource = "override" | "fast-path" | "model" | "scripted" | "none";

/**
 * What the control plane did about this turn (issue #1, D1).
 *
 * The spec's vocabulary, from the four-state turn models in the research: `respond` is today's
 * behaviour and the only one the decider is consulted for. `wait` is the borrower asking for a
 * moment — the agent says nothing and the away timer is extended. `held` is a turn that arrived
 * while a non-interruptible segment was still playing and was parked until it finished (F2).
 * `resume` is the worker resuming a line paused by a backchannel, and is not produced yet: D5.2
 * measures `interruption.minDuration` first, and the interim classifier is built only if that
 * measurement says it is needed.
 */
export type TurnDisposition = "respond" | "wait" | "resume" | "held";

/**
 * How the turn ended.
 *
 * A different axis from `disposition`, and worth keeping separate: `disposition` is what the system
 * decided to do, this is what came of it. `degraded`, `toolCalled`, the tool-rejection branch and
 * the superseded early return each carried a piece of this and a reader had to reassemble it.
 * `superseded` is not a failure and `rejected` is not degradation; keeping them apart is the point.
 *
 * `none` goes with `decider: "none"`: a playout signal and a no-input close both wear the
 * `TurnResult` shape without ever having been decided.
 */
export type TurnResolution = "spoke" | "tool" | "rejected" | "degraded" | "superseded" | "none";

export interface TurnResult {
  readonly turnId: string;
  /** Which arm decided this turn — the turn-level predicate the SLO segment reads (F3, F4). */
  readonly decider: TurnDecisionSource;
  /** What the control plane did about this turn (D1). */
  readonly disposition: TurnDisposition;
  /** How it came out (F3). */
  readonly resolution: TurnResolution;
  /**
   * How long this turn waited for a non-interruptible segment to finish before it claimed (F2).
   *
   * Zero on almost every turn. Non-zero means the borrower spoke while the agent was saying
   * something they may not talk over — the read-back — and the turn was held rather than committing
   * a barge-in the fully-heard guard would refuse. It is in `TurnResult` because that is what lands
   * in `conversation_turns.result`, so the cost of the hold is measurable per turn.
   */
  readonly heldMs?: number | undefined;
  /**
   * How much longer the worker should wait before its next no-input strike (issue #1, D1's `wait`).
   *
   * Present only on a `wait`. The agent deliberately said nothing, so without this the silence the
   * borrower asked for would look exactly like a borrower who had walked away.
   */
  readonly extendAwayMs?: number | undefined;
  readonly agentText: string;
  readonly newState: ConversationState;
  readonly toolCalled: ToolCall | null;
  readonly callControlAction: { readonly action: CallControlAction; readonly action_id: string } | null;
  readonly outcome: Outcome | null;
  readonly endCall: boolean;
  readonly degraded: boolean;
  readonly ttftMs: number | null;
}
