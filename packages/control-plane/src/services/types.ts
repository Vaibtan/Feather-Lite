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
  readonly heardAgentText: string | null;
  readonly context: VisibleContext;
  readonly allowedTools: ReadonlyArray<ToolName>;
  readonly pendingProposal: PendingProposal | null;
  readonly recentTranscript: ReadonlyArray<{ readonly speaker: "AGENT" | "BORROWER"; readonly text: string }>;
  readonly model: string;
  readonly borrowerLocalDate: string; // YYYY-MM-DD
  readonly borrowerTimeZone: string;
  readonly borrowerFirstName: string;
}

export type { TurnChunk };

export type TurnDecisionSource = "override" | "model" | "scripted" | "none";

export type TurnDisposition = "respond" | "wait" | "resume" | "held";

export type TurnResolution = "spoke" | "tool" | "rejected" | "degraded" | "superseded" | "none";

export interface TurnResult {
  readonly turnId: string;
  readonly decider: TurnDecisionSource;
  readonly disposition: TurnDisposition;
  readonly resolution: TurnResolution;
  readonly heldMs?: number | undefined;
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
