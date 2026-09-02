/**
 * The fleet's borrowers, in their own process (spec D1 / findings W8).
 *
 * Every tier-2 number to date was taken with N speaking borrowers — N `Room`s, N `AudioSource`s, N
 * `AudioStream`s, N Opus encoders and N onset detectors — running in the *same* Node process as the
 * harness that then reports "the worker's latency". They are not the worker, they are not even the
 * worker's tree, and on a 6-core laptop at N=10 they are a material share of the box. Moving them
 * out does not remove the competition for CPU, but it makes it *visible*: the resource sampler can
 * name their process `harness-borrower` and put their CPU-seconds in the report next to the
 * worker's, so a fleet run finally says how much of the machine measured the machine.
 *
 * It is also the step that makes `--remote-borrower <host>` a small change rather than a rewrite:
 * the contract here is already a JSON request in and a JSON array of `ScriptedCallResult` out.
 *
 * Not run directly — `fake-borrower-fleet.ts --borrower-proc` forks it.
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { initializeLogger } from "@livekit/agents";
import { loadScriptedLines, runScriptedCall, type ScriptedCallResult } from "./scripted-call.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
initializeLogger({ pretty: true, level: "warn" });

/** What the parent sends. One message, then the child runs every call concurrently and replies once. */
export interface BorrowerProcRequest {
  readonly controlPlaneUrl: string;
  readonly calls: ReadonlyArray<{ readonly borrowerName: string; readonly participantIdentity: string; readonly label: string }>;
  /**
   * Which borrower script to run, and the seed its stochastic parts draw from (issue #4, H9, H7).
   *
   * Both are carried across the fork rather than resolved inside it, because the parent is what
   * writes the report and the report has to say which scenario at which seed produced the numbers —
   * a tier-3 result whose scenario is implicit is not reproducible whatever the seed says.
   *
   * Undefined means the promise-to-pay script on the default voice, which is every measurement
   * recorded so far.
   */
  readonly scenario?: string | undefined;
  readonly seed?: number | undefined;
  /** The voice the borrower speaks in; `undefined` is `BORROWER_TTS_VOICE` (H9). */
  readonly persona?: string | undefined;
}

export type BorrowerProcMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "log"; readonly line: string }
  | { readonly kind: "results"; readonly results: ReadonlyArray<ScriptedCallResult> }
  | { readonly kind: "failed"; readonly error: string };

const send = (m: BorrowerProcMessage): void => {
  process.send?.(m);
};

if (!process.send) {
  console.error("[borrower-proc] no IPC channel: this process is forked by the fleet harness, not run directly");
  process.exit(2);
}

process.on("message", (raw: unknown) => {
  void (async () => {
    try {
      const req = raw as BorrowerProcRequest;
      // Synthesis happens once per process and the frames are shared across every call, exactly as
      // the in-process fleet did — an N-call run must not pay for 3N utterances.
      // The persona the parent asked for, so a tier-3 run speaks in the voice its report names (H9).
      const lines = await loadScriptedLines(req.persona);
      send({ kind: "log", line: `borrower lines ready (${lines.cached ? "WAV cache" : "synthesised"}): ${lines.describe}` });
      const results = await Promise.all(
        req.calls.map((c) =>
          runScriptedCall({
            lines,
            controlPlaneUrl: req.controlPlaneUrl,
            borrowerName: c.borrowerName,
            participantIdentity: c.participantIdentity,
            label: c.label,
            log: (message) => send({ kind: "log", line: `[${c.label}] ${message}` }),
          }),
        ),
      );
      send({ kind: "results", results });
    } catch (e) {
      send({ kind: "failed", error: String(e) });
    }
  })();
});

send({ kind: "ready" });
