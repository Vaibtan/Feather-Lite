/**
 * The SDK's own away timer fires once and then wedges — `_updateUserState` returns early on an
 * unchanged state, and only a final transcript leaves `away` — so the strike that closes a dead
 * call was unreachable on a voice call. This clock replaces it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NUDGE_WINDOW_MS, SILENCE_WINDOW_MS, WAIT_WINDOW_BARE_MS } from "@feather-lite/domain";
import { FeatherAgent } from "../src/feather-agent.js";

interface Probe {
  readonly agent: FeatherAgent;
  readonly probes: number[];
  readonly said: string[];
  reply: { agent_text: string; end_call: boolean; extend_away_ms?: number };
}

const makeAgent = (): Probe => {
  const probes: number[] = [];
  const said: string[] = [];
  const state: Probe = {
    probes,
    said,
    reply: { agent_text: "Are you still there?", end_call: false, extend_away_ms: NUDGE_WINDOW_MS },
    agent: null as unknown as FeatherAgent,
  };
  const agent = new FeatherAgent({
    conversationId: "c-1",
    client: {
      noInput: async () => {
        probes.push(Date.now());
        return state.reply;
      },
      signal: async () => ({}) as never,
      providerEvents: async () => undefined,
    },
    log: () => undefined,
    onEndCall: async () => undefined,
  } as never);
  Object.defineProperty(agent, "session", {
    value: {
      say: (text: string) => {
        said.push(text);
        return { waitForPlayout: async () => undefined };
      },
    },
  });
  return { ...state, agent };
};

/** The agent has finished speaking and the borrower has not started: the clock's only arming state. */
const bothListening = (agent: FeatherAgent) => {
  agent.noteUserListening(true);
  agent.noteAgentListening(true);
};

describe("the silence clock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not run while the agent is still speaking", async () => {
    const { agent, probes } = makeAgent();
    agent.noteAgentListening(false);
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 3);
    expect(probes).toHaveLength(0);
  });

  it("probes once the borrower has been silent for the window", async () => {
    const { agent, probes } = makeAgent();
    bothListening(agent);
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS - 1);
    expect(probes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toHaveLength(1);
  });

  it("restarts when the borrower starts speaking", async () => {
    const { agent, probes } = makeAgent();
    bothListening(agent);
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS - 100);
    agent.noteUserListening(false);
    agent.noteUserListening(true);
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS - 1);
    expect(probes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toHaveLength(1);
  });

  it("uses the window the turn asked for, not its own default", async () => {
    const { agent, probes } = makeAgent();
    agent.setSilenceWindow(WAIT_WINDOW_BARE_MS);
    bothListening(agent);
    await vi.advanceTimersByTimeAsync(WAIT_WINDOW_BARE_MS);
    expect(probes).toHaveLength(1);
  });

  /** The defect the clock exists for: the second strike is what hangs up a dead call. */
  it("comes back for the strike that closes the call", async () => {
    const probe = makeAgent();
    const { agent, probes, said } = probe;
    agent.setSilenceWindow(WAIT_WINDOW_BARE_MS);
    bothListening(agent);
    await vi.advanceTimersByTimeAsync(WAIT_WINDOW_BARE_MS);
    expect(said).toEqual(["Are you still there?"]);

    // The nudge is spoken, then the agent is listening again with the window its reply carried.
    probe.reply = { agent_text: "I am not hearing a response, so I will end this call.", end_call: true };
    agent.noteAgentListening(false);
    agent.noteAgentListening(true);
    await vi.advanceTimersByTimeAsync(NUDGE_WINDOW_MS - 1);
    expect(probes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toHaveLength(2);
    expect(said).toHaveLength(2);
  });

  it("stops once the call is ending", async () => {
    const { agent, probes } = makeAgent();
    bothListening(agent);
    await agent.endCall("test");
    await vi.advanceTimersByTimeAsync(SILENCE_WINDOW_MS * 3);
    expect(probes).toHaveLength(0);
  });
});
