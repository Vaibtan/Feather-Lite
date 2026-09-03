/**
 * The reference is produced by running the scenario through the same control plane rather than
 * hard-coded, so the assertion cannot drift from the suite. Only the deterministic spine is
 * compared — state path, tool sequence, final outcome — because wording, timing and barge-in events
 * legitimately differ between a typed simulation and spoken audio.
 */
import { harnessHeaders } from "@feather-lite/load-test/harness-http";
export interface ScenarioReference {
  readonly scenarioId: string;
  readonly statePath: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly callControlActions: ReadonlyArray<string>;
  readonly finalOutcome: string | null;
  /** The scenario itself passed its own assertions; otherwise the reference is worthless. */
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

export const loadScenarioReference = async (controlPlaneUrl: string, scenarioId = "happy-path-promise-to-pay"): Promise<ScenarioReference> => {
  const res = await fetch(`${controlPlaneUrl}/api/testing/scenarios/${scenarioId}/run`, { method: "POST", headers: harnessHeaders() });
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

export const checkEquivalence = async (controlPlaneUrl: string, conversationId: string, reference: ScenarioReference): Promise<EquivalenceResult> => {
  const res = await fetch(`${controlPlaneUrl}/api/conversations/${conversationId}`, { headers: harnessHeaders() });
  if (!res.ok) throw new Error(`conversation ${conversationId} fetch failed: ${res.status} ${await res.text()}`);
  const detail = (await res.json()) as {
    conversation?: { final_outcome: string | null; current_state: string };
    event_timeline?: Array<{ type: string; payload: Record<string, unknown> }>;
  };
  // An unexpected shape must throw, not leave two empty arrays quietly comparing equal.
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
