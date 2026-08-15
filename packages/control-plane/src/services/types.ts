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

export interface TurnResult {
  readonly turnId: string;
  readonly agentText: string;
  readonly newState: ConversationState;
  readonly toolCalled: ToolCall | null;
  readonly callControlAction: { readonly action: CallControlAction; readonly action_id: string } | null;
  readonly outcome: Outcome | null;
  readonly endCall: boolean;
  readonly degraded: boolean;
  readonly ttftMs: number | null;
}
