/**
 * Placeholder `LLM` so the framework's `generateReply` guard is satisfied.
 * `Agent.llmNode` is overridden to stream the control-plane turn, so `chat()`
 * must never be reached — if it is, that is a bug and we fail loudly.
 */
import { llm } from "@livekit/agents";

export class RemoteOrchestratorLLM extends llm.LLM {
  override label(): string {
    return "feather-lite.remote-orchestrator";
  }
  override get model(): string {
    return "control-plane";
  }
  override get provider(): string {
    return "feather-lite";
  }
  override chat(): llm.LLMStream {
    throw new Error(
      "RemoteOrchestratorLLM.chat() was invoked: Agent.llmNode override is not in effect. The control plane must be the only reply source.",
    );
  }
}
