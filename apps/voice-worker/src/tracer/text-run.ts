/**
 * Text-mode exercise of the tracer agent through the framework's testing harness
 * (`session.run({ userInput })`) — no microphone, no room, no STT/TTS.
 * This is the seed of the voice/simulation equivalence test (plan rev.2 R16).
 */
import { initializeLogger, voice } from "@livekit/agents";
import { RemoteOrchestratorLLM } from "./remote-orchestrator-llm.js";
import { TracerAgent } from "./tracer-agent.js";

const main = async () => {
  initializeLogger({ pretty: true, level: "warn" });
  const session = new voice.AgentSession({
    llm: new RemoteOrchestratorLLM(),
    turnHandling: { preemptiveGeneration: { enabled: false } },
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type === "message") {
      console.log(
        `[text-run] item role=${item.role} interrupted=${item.interrupted} text=${JSON.stringify(item.textContent)}`,
      );
    }
  });
  session.on(voice.AgentSessionEventTypes.Error, (ev) => console.error("[text-run] error", ev.error));
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
    console.log(`[text-run] speech_created source=${ev.source} id=${ev.speechHandle.id} allowInterruptions=${ev.speechHandle.allowInterruptions}`);
    ev.speechHandle.addDoneCallback((h) => console.log(`[text-run] speech_done id=${h.id} interrupted=${h.interrupted}`));
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => console.log(`[text-run] agent_state ${ev.oldState} -> ${ev.newState}`));

  const agent = new TracerAgent();
  await session.start({ agent });

  for (const userInput of ["yes this is Jordan", "I can pay on Friday", "yes"]) {
    console.log(`\n>>> user: ${userInput}`);
    const run = session.run({ userInput });
    const result = await Promise.race([
      run.wait(),
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    if (result === null) {
      console.log("    !! run did not complete within 15s; events so far:", run.events.map((e) => e.type));
      break;
    }
    for (const ev of result.events) {
      if (ev.type === "message") {
        console.log(`    event message role=${ev.item.role} text=${JSON.stringify(ev.item.textContent)}`);
      } else {
        console.log(`    event ${ev.type}`);
      }
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log(
    "\n[text-run] chatCtx items:",
    session.chatCtx.items.map((i) => (i.type === "message" ? `${i.role}: ${i.textContent}` : i.type)),
  );
  await session.close();
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
