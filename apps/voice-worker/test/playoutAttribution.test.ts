/**
 * Which turn an agent line belongs to, and how much of the turn is reported (issue #4, W3 and W4).
 *
 * One turn can speak several times: the reply the framework builds from `delta` frames, plus one
 * item per `say`. The old reporting took the **first** item and dropped the rest — so a turn that
 * spoke a reply and then a tool line reported only the reply, and the fully-heard guard judged a
 * promise read-back against a partial record of what was said (W4). And it read the turn from
 * `currentTurnId` at the moment the item landed, a field that has already moved on if the next turn
 * has begun, so a late item was booked to the wrong turn (W3, ADR 0008's recorded residual).
 */
import { describe, expect, it } from "vitest";
import { FeatherAgent } from "../src/feather-agent.js";

const makeAgent = () => {
  const signals: Array<Record<string, unknown>> = [];
  const agent = new FeatherAgent({
    conversationId: "c-1",
    client: {
      signal: async (_id: string, body: Record<string, unknown>) => {
        signals.push(body);
        return {} as never;
      },
      providerEvents: async () => undefined,
    },
    log: () => undefined,
    onEndCall: async () => undefined,
  } as never);
  const priv = agent as unknown as {
    currentTurnId: string | null;
    itemTurn: Map<string, string>;
    ttsProducedAudio: Set<string>;
    reportTurnPlayout: (t: string) => Promise<void>;
  };
  return { agent, signals, priv };
};

const playouts = (signals: Array<Record<string, unknown>>) => signals.filter((s) => s["kind"] === "playout");

describe("a turn that speaks more than once (W4)", () => {
  it("reports every item it spoke, once, rather than only the first", async () => {
    const { agent, signals, priv } = makeAgent();
    priv.currentTurnId = "t1";
    priv.ttsProducedAudio.add("t1");
    // A reply built from deltas, then a tool line said after the commit — one turn, two items.
    agent.reportPlayout({ id: "i1", interrupted: false, textContent: "Thank you." } as never);
    agent.reportPlayout({ id: "i2", interrupted: false, textContent: "To confirm: you will pay 550 dollars." } as never);
    await priv.reportTurnPlayout("t1");

    const p = playouts(signals);
    expect(p).toHaveLength(1);
    // The whole of what was spoken — the read-back the guard is about was the *second* item.
    expect(p[0]?.["heard_text"]).toBe("Thank you. To confirm: you will pay 550 dollars.");
    expect(p[0]?.["interrupted"]).toBe(false);
  });

  it("calls the turn interrupted if any part of it was cut off", async () => {
    const { agent, signals, priv } = makeAgent();
    priv.currentTurnId = "t2";
    priv.ttsProducedAudio.add("t2");
    agent.reportPlayout({ id: "i1", interrupted: false, textContent: "Thank you." } as never);
    agent.reportPlayout({ id: "i2", interrupted: true, textContent: "To confirm: you will" } as never);
    await priv.reportTurnPlayout("t2");
    // A read-back the borrower talked over is a read-back they did not hear in full, whatever the
    // item before it managed to say.
    expect(playouts(signals)[0]?.["interrupted"]).toBe(true);
  });
});

describe("which turn an item belongs to (W3)", () => {
  it("books an item to the turn that asked for it, not the turn that happens to be current", async () => {
    const { agent, signals, priv } = makeAgent();
    // `t1` said something; before its item was delivered, `t2` began — which is exactly the
    // ordering ADR 0008 recorded as the residual, and the one `currentTurnId` gets wrong.
    priv.itemTurn.set("late-item", "t1");
    priv.currentTurnId = "t2";
    priv.ttsProducedAudio.add("t1");
    agent.reportPlayout({ id: "late-item", interrupted: false, textContent: "the line t1 spoke" } as never);

    await priv.reportTurnPlayout("t1");
    const p = playouts(signals);
    expect(p).toHaveLength(1);
    expect(p[0]?.["turn_id"]).toBe("t1");
    expect(p[0]?.["heard_text"]).toBe("the line t1 spoke");

    // And t2 has nothing of its own to report, because it never spoke.
    await priv.reportTurnPlayout("t2");
    expect(playouts(signals)).toHaveLength(1);
  });

  it("falls back to the current turn for an item nothing stamped", async () => {
    // The framework's own generated reply has no handle of ours to stamp it, so it keeps the old
    // attribution — which is right for it, because it is created while its turn is current.
    const { agent, signals, priv } = makeAgent();
    priv.currentTurnId = "t3";
    priv.ttsProducedAudio.add("t3");
    agent.reportPlayout({ id: "unstamped", interrupted: false, textContent: "generated reply" } as never);
    await priv.reportTurnPlayout("t3");
    expect(playouts(signals)[0]?.["turn_id"]).toBe("t3");
  });
});

describe("a turn whose TTS produced nothing", () => {
  it("is reported unheard, so the guard repeats the read-back", async () => {
    const { agent, signals, priv } = makeAgent();
    priv.currentTurnId = "t4";
    // Deliberately not in `ttsProducedAudio`: the ADR 0008 stall, where the item claims it played.
    agent.reportPlayout({ id: "i1", interrupted: false, textContent: "To confirm: you will pay." } as never);
    await priv.reportTurnPlayout("t4");
    const p = playouts(signals);
    expect(p[0]?.["heard_text"]).toBe("");
    expect(p[0]?.["interrupted"]).toBe(true);
  });
});
