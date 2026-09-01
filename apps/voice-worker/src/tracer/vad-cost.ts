/**
 * What a VAD costs the process it runs in — the measurement that stopped W11.
 *
 * W11 was to replace `silero.VAD.load()` with `inference.VAD`: the same Silero model, in the same
 * napi addon the end-of-turn detector already lives in, which would take `onnxruntime-node` (513 MB
 * of prebuilt binaries, 336 MB of it an unusable CUDA provider) out of the tree and delete the
 * Dockerfile's hand-prune. On CPU per second of audio it is the clear win the efficiency spec
 * recorded: 0.69 ms against Silero-ONNX's 4.4-6.3.
 *
 * The premise it rested on — "same addon as the EOU model, so the cost is already paid" — is where
 * it fails, and only a measurement shows why. The EOU model runs in the **shared inference
 * process**, once for the whole worker. `inference.VAD` runs its predicts wherever the stream is
 * opened, which is the **job process**: one per concurrent call.
 *
 * Run: pnpm --filter @feather-lite/voice-worker vad-cost
 *
 * Measured on this box, 2026-09-01 (win32-x64, `@livekit/local-inference` 0.2.6), under bare
 * `node --expose-gc`:
 *
 *   node baseline                        44 MB
 *   after loading the addon             385 MB   (+320 MB)
 *   after createVad()                   388 MB
 *   after 1 predict                     517 MB   (+129 MB)
 *   after 551 predicts                  517 MB   (flat)
 *   after a second detector             517 MB   (flat — the cost is per process, not per stream)
 *   after global.gc()                   517 MB   (native, not reclaimable)
 *
 * Under `tsx` the same total arrives in one step at load (86 -> 598 MB) rather than split across
 * load and first predict; where the allocation is attributed varies, the ~450-530 MB does not.
 *
 * That much non-reclaimable native memory in every process that runs a predict. Multiplied by
 * `WORKER_MAX_JOBS` that is the whole memory budget; the per-job limit W7 set at 800 MB killed
 * every call of an N=5 fleet run. The full write-up is in `docs/loadtest/README.md`.
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const mb = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);
const heapMb = (): number => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
const at = (label: string): void => console.log(`${label.padEnd(34)} rss ${String(mb()).padStart(5)} MB   heap ${String(heapMb()).padStart(4)} MB`);

at("node baseline");

/**
 * Reached through the package's internal path, deliberately: this is a measurement of the addon,
 * not of an API. `_getLocalInferenceModule` is what `inference.VAD`'s stream calls
 * (`agents/dist/inference/vad.js:84-93`), so measuring anything else would measure the wrong thing.
 */
const warmupPath = new URL("../../node_modules/@livekit/agents/dist/inference/_warmup.js", import.meta.url).href;
const warmup = (await import(warmupPath)) as { _getLocalInferenceModule: () => undefined | { createVad: () => { predict: (w: Int16Array) => Promise<number> }; VAD_WINDOW_SAMPLES: number } };
at("after importing _warmup");

const mod = warmup._getLocalInferenceModule();
if (mod === undefined) {
  console.error("@livekit/local-inference did not load; there is nothing to measure.");
  process.exit(1);
}
at("after loading the addon");

const vad = mod.createVad();
at("after createVad()");

const window = new Int16Array(mod.VAD_WINDOW_SAMPLES);
await vad.predict(window);
at("after 1 predict");

for (let i = 0; i < 550; i++) await vad.predict(window);
at("after 551 predicts");

// A second detector, to separate "per process" from "per stream". It is per process.
const second = mod.createVad();
for (let i = 0; i < 51; i++) await second.predict(window);
at("after a second detector");

// `--expose-gc` to see whether any of it is JS. None of it is.
const gc = (globalThis as { gc?: () => void }).gc;
if (gc) {
  gc();
  at("after global.gc()");
} else {
  console.log("(re-run with `node --expose-gc` to confirm none of it is reclaimable JS heap)");
}
