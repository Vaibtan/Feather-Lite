/**
 * The borrowers run here, out of the harness process, so the resource sampler can name their CPU
 * separately from the worker's. Not run directly: `fake-borrower-fleet.ts --borrower-proc` forks it.
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { initializeLogger } from "@livekit/agents";
import { loadScriptedLines, runScriptedCall, type ScriptedCallResult } from "./scripted-call.js";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
initializeLogger({ pretty: true, level: "warn" });

/** One message in, every call run concurrently, one reply out. */
export interface BorrowerProcRequest {
  readonly controlPlaneUrl: string;
  readonly calls: ReadonlyArray<{ readonly borrowerName: string; readonly participantIdentity: string; readonly label: string }>;
  /**
   * Carried across the fork rather than resolved inside it: the parent writes the report, and a
   * result whose scenario and seed are implicit is not reproducible.
   */
  readonly scenario?: string | undefined;
  readonly seed?: number | undefined;
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
      // Once per process, with the frames shared across every call: an N-call run must not pay for
      // 3N utterances.
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
