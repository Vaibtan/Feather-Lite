/**
 * SPEC §10.5 equivalence: a real voice call and the equivalent JSON simulation must produce the
 * same conversation, not merely a working one.
 *
 * The reference is not hard-coded here — it is produced by running the corresponding scenario
 * (`happy-path-promise-to-pay`) through the same control plane, so the assertion tracks the
 * scenario suite instead of drifting from it. What must match is the deterministic spine of the
 * ledger: the state path, the tool sequence, and the final outcome. Wording, timing, playout and
 * barge-in events legitimately differ between a typed simulation and spoken audio.
 */
export interface ScenarioReference {
  readonly scenarioId: string;
  readonly statePath: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly callControlActions: ReadonlyArray<string>;
  readonly finalOutcome: string | null;
  /** The scenario itself passed its own assertions (otherwise the reference is worthless). */
  readonly scenarioPassed: boolean;
}

export interface EquivalenceResult {
  readonly conversationId: string;
  readonly equivalent: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly statePath: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly finalOutcome: string | null;
}

const authHeaders = (): Record<string, string> => {
  const bearer = process.env["API_BEARER_TOKEN"];
  return bearer ? { authorization: `Bearer ${bearer}` } : {};
};

/** Run the reference simulation scenario and capture what it actually produced. */
export const loadScenarioReference = async (controlPlaneUrl: string, scenarioId = "happy-path-promise-to-pay"): Promise<ScenarioReference> => {
  const res = await fetch(`${controlPlaneUrl}/api/testing/scenarios/${scenarioId}/run`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`scenario ${scenarioId} run failed: ${res.status} ${await res.text()}`);
  const r = (await res.json()) as {
    passed: boolean;
    actual_state_path: string[];
    actual_tools: string[];
    actual_call_control_actions: string[];
    final_outcome: string | null;
  };
  return {
    scenarioId,
    statePath: r.actual_state_path,
    tools: r.actual_tools,
    callControlActions: r.actual_call_control_actions,
    finalOutcome: r.final_outcome,
    scenarioPassed: r.passed,
  };
};

/** Compare a finished voice conversation's ledger against the simulation reference. */
export const checkEquivalence = async (controlPlaneUrl: string, conversationId: string, reference: ScenarioReference): Promise<EquivalenceResult> => {
  const res = await fetch(`${controlPlaneUrl}/api/conversations/${conversationId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`conversation ${conversationId} fetch failed: ${res.status} ${await res.text()}`);
  const detail = (await res.json()) as {
    conversation?: { final_outcome: string | null; current_state: string };
    event_timeline?: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  // This comparison is the whole point of the harness, so a response that is not the shape we think
  // it is must be an error, not two empty arrays quietly comparing equal.
  if (!detail.conversation || !Array.isArray(detail.event_timeline)) {
    throw new Error(`conversation ${conversationId}: unexpected detail shape (keys: ${Object.keys(detail).join(", ")})`);
  }

  const statePath = detail.event_timeline.filter((e) => e.type === "STATE_TRANSITION").map((e) => String(e.payload["to"]));
  const tools = detail.event_timeline.filter((e) => e.type === "TOOL_CALLED").map((e) => String(e.payload["name"]));
  const finalOutcome = detail.conversation.final_outcome;

  const failures: string[] = [];
  if (!reference.scenarioPassed) failures.push(`reference scenario ${reference.scenarioId} did not pass its own assertions`);
  if (JSON.stringify(statePath) !== JSON.stringify(reference.statePath)) failures.push(`state path ${JSON.stringify(statePath)} != simulation ${JSON.stringify(reference.statePath)}`);
  if (JSON.stringify(tools) !== JSON.stringify(reference.tools)) failures.push(`tools ${JSON.stringify(tools)} != simulation ${JSON.stringify(reference.tools)}`);
  if (finalOutcome !== reference.finalOutcome) failures.push(`outcome ${String(finalOutcome)} != simulation ${String(reference.finalOutcome)}`);

  return { conversationId, equivalent: failures.length === 0, failures, statePath, tools, finalOutcome };
};
