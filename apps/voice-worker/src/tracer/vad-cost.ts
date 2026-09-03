/**
 * What `inference.VAD` costs the process it runs in. The EOU model runs once in the shared
 * inference process, but the VAD runs its predicts wherever the stream is opened — the job process,
 * one per concurrent call — and it costs ~450-530 MB of non-reclaimable native memory there.
 *
 * Run: pnpm --filter @feather-lite/voice-worker vad-cost
 */
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });

const mb = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);
const heapMb = (): number => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
const at = (label: string): void => console.log(`${label.padEnd(34)} rss ${String(mb()).padStart(5)} MB   heap ${String(heapMb()).padStart(4)} MB`);

at("node baseline");

/**
 * Reached through the package's internal path deliberately: `_getLocalInferenceModule` is what
 * `inference.VAD`'s stream calls, so measuring anything else would measure the wrong thing.
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
