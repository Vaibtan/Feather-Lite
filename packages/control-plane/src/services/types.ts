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
 * How the turn ended, in one field instead of four (F3).
 *
 * `degraded`, `toolCalled`, the rejection branch and the superseded early return each carried a
 * piece of this, and a reader had to reassemble it. `superseded` is not a failure and `rejected` is
 * not degradation; keeping them apart is the point.
 */
export type TurnDisposition = "spoke" | "tool" | "rejected" | "degraded" | "superseded" | "none";

export interface TurnResult {
  readonly turnId: string;
  /** Which arm decided this turn — the turn-level predicate the SLO segment reads (F3, F4). */
  readonly decider: TurnDecisionSource;
  /** How this turn ended (F3). */
  readonly disposition: TurnDisposition;
  /**
   * How long this turn waited for a non-interruptible segment to finish before it claimed (F2).
   *
   * Zero on almost every turn. Non-zero means the borrower spoke while the agent was saying
   * something they may not talk over — the read-back — and the turn was held rather than committing
   * a barge-in the fully-heard guard would refuse. It is in `TurnResult` because that is what lands
   * in `conversation_turns.result`, so the cost of the hold is measurable per turn.
   */
  readonly heldMs?: number | undefined;
  readonly agentText: string;
  readonly newState: ConversationState;
  readonly toolCalled: ToolCall | null;
  readonly callControlAction: { readonly action: CallControlAction; readonly action_id: string } | null;
  readonly outcome: Outcome | null;
  readonly endCall: boolean;
  readonly degraded: boolean;
  readonly ttftMs: number | null;
}
