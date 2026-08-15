/**
 * Replay: rebuild the authoritative in-call state from the event log (SPEC §11.3).
 *
 * The runtime keeps hot state in memory during a call, but the event log is
 * the source of truth. After a crash/restart — or for QA — this reducer
 * recovers everything the orchestrator needs to continue safely.
 */
import type { CallControlAction, ConversationState, Outcome } from "./enums.js";
import type { EventRecord } from "./events.js";
import type { ToolName } from "./tools.js";
import type { IsoDate, MoneyAmount } from "./values.js";

export interface PendingProposal {
  readonly kind: "PROMISE_TO_PAY";
  readonly amount: MoneyAmount;
  readonly date: IsoDate;
  /** sequence_no of the TOOL_RESULT that created the proposal. */
  readonly proposedAtSeq: number;
  /** sequence_no of the AGENT_TURN that read it back, once spoken. */
  readonly readBackAtSeq: number | null;
}

export interface ReplaySnapshot {
  readonly currentState: ConversationState;
  readonly protectedContextUnlocked: boolean;
  readonly finalOutcome: Outcome | null;
  readonly executedTools: ReadonlyArray<ToolName>;
  readonly toolCallIds: ReadonlySet<string>;
  readonly callControlActions: ReadonlyArray<CallControlAction>;
  readonly actionIds: ReadonlySet<string>;
  readonly noInputCount: number;
  readonly pendingProposal: PendingProposal | null;
  readonly lastAgentText: string | null;
  readonly lastUserText: string | null;
  readonly turnCount: number;
  readonly lastSequenceNo: number;
  /** STATE_TRANSITION `to` values in order — the "state path" scenarios assert on. */
  readonly statePath: ReadonlyArray<ConversationState>;
}

const EMPTY: ReplaySnapshot = {
  currentState: "GREETING",
  protectedContextUnlocked: false,
  finalOutcome: null,
  executedTools: [],
  toolCallIds: new Set(),
  callControlActions: [],
  actionIds: new Set(),
  noInputCount: 0,
  pendingProposal: null,
  lastAgentText: null,
  lastUserText: null,
  turnCount: 0,
  lastSequenceNo: 0,
  statePath: [],
};

/** Fold one event into the snapshot. Exported so streaming consumers can reduce incrementally. */
export const applyEvent = (snap: ReplaySnapshot, event: EventRecord): ReplaySnapshot => {
  const base: ReplaySnapshot = { ...snap, lastSequenceNo: Math.max(snap.lastSequenceNo, event.sequence_no) };
  switch (event.type) {
    case "STATE_TRANSITION": {
      const to = event.payload.to;
      const unlocked =
        base.protectedContextUnlocked || event.payload.triggered_by === "RIGHT_PARTY_CONFIRMED";
      // Leaving CONFIRMING_OUTCOME backwards clears the pending proposal.
      const pendingProposal =
        event.payload.from === "CONFIRMING_OUTCOME" && to === "DISCUSSING_PAYMENT" ? null : base.pendingProposal;
      return { ...base, currentState: to, protectedContextUnlocked: unlocked, pendingProposal, statePath: [...base.statePath, to] };
    }
    case "TOOL_CALLED":
      return { ...base, toolCallIds: new Set([...base.toolCallIds, event.payload.tool_call_id]) };
    case "TOOL_RESULT": {
      const executedTools = [...base.executedTools, event.payload.name];
      if (event.payload.name === "propose_promise_to_pay") {
        const result = event.payload.result as { amount?: string; date?: string } | undefined;
        if (result?.amount && result?.date) {
          return {
            ...base,
            executedTools,
            pendingProposal: {
              kind: "PROMISE_TO_PAY",
              amount: result.amount as MoneyAmount,
              date: result.date as IsoDate,
              proposedAtSeq: event.sequence_no,
              readBackAtSeq: null,
            },
          };
        }
      }
      if (event.payload.name === "record_promise_to_pay") {
        return { ...base, executedTools, pendingProposal: null };
      }
      return { ...base, executedTools };
    }
    case "CALL_CONTROL":
      return {
        ...base,
        callControlActions: [...base.callControlActions, event.payload.action],
        actionIds: new Set([...base.actionIds, event.payload.action_id]),
      };
    case "NO_INPUT":
      return { ...base, noInputCount: event.payload.count };
    case "USER_TURN_FINAL":
      return { ...base, lastUserText: event.payload.text, turnCount: base.turnCount + 1, noInputCount: 0 };
    case "AGENT_TURN": {
      const pendingProposal =
        base.pendingProposal && base.pendingProposal.readBackAtSeq === null && base.currentState === "CONFIRMING_OUTCOME"
          ? { ...base.pendingProposal, readBackAtSeq: event.sequence_no }
          : base.pendingProposal;
      return { ...base, lastAgentText: event.payload.text, pendingProposal };
    }
    case "AGENT_TURN_PLAYOUT":
      return event.payload.interrupted ? { ...base, lastAgentText: event.payload.heard_text } : base;
    case "CALL_ENDED":
      return { ...base, finalOutcome: event.payload.final_outcome };
    default:
      return base;
  }
};

/** Rebuild the snapshot from a full, possibly unordered, event list. */
export const replay = (events: ReadonlyArray<EventRecord>): ReplaySnapshot =>
  [...events].sort((a, b) => a.sequence_no - b.sequence_no).reduce(applyEvent, EMPTY);

export const emptySnapshot = (): ReplaySnapshot => EMPTY;
