/**
 * Where speech comes from — the one code-level difference between LiveKit Cloud and a self-hosted
 * server (ADR 0006).
 *
 * LiveKit **Inference** is a Cloud-only gateway: `inference.STT` / `inference.TTS` resolve model
 * strings like `deepgram/nova-3` server-side and bill against the Cloud project. A self-hosted
 * `livekit-server` has no such gateway, so the worker must talk to the providers directly.
 *
 * `STT_TTS_PROVIDER` selects which:
 *   inference (default) — unchanged Cloud behaviour, models from LIVEKIT_STT_MODEL/LIVEKIT_TTS_MODEL
 *   plugins             — Deepgram STT + Cartesia TTS with their own API keys; the same model
 *                         strings are reused with the `provider/` prefix stripped, so one env block
 *                         describes both targets.
 *
 * Everything else in the session (silero VAD, the multilingual EOT model, RemoteOrchestratorLLM) is
 * provider-independent.
 */
import { type stt as sttBase, type tts as ttsBase, inference } from "@livekit/agents";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as deepgram from "@livekit/agents-plugin-deepgram";

export type SpeechProvider = "inference" | "plugins";

export interface SpeechStack {
  readonly provider: SpeechProvider;
  readonly stt: sttBase.STT;
  readonly tts: ttsBase.TTS;
  /** For logs: what actually got constructed. */
  readonly describe: string;
}

const DEFAULT_STT_MODEL = "deepgram/nova-3";
const DEFAULT_TTS_MODEL = "cartesia/sonic-3";
/** The agent's voice on both targets (Cartesia voice id, also used by Inference). */
const DEFAULT_TTS_VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";

/** `deepgram/nova-3` -> `nova-3`; a bare `nova-3` is left alone. */
const stripProvider = (model: string): string => (model.includes("/") ? model.slice(model.indexOf("/") + 1) : model);

export const speechProvider = (): SpeechProvider => {
  const raw = (process.env["STT_TTS_PROVIDER"] ?? "inference").trim().toLowerCase();
  if (raw !== "inference" && raw !== "plugins") {
    throw new Error(`STT_TTS_PROVIDER must be "inference" or "plugins" (got ${JSON.stringify(raw)})`);
  }
  return raw;
};

const requireKey = (name: string, why: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`STT_TTS_PROVIDER=plugins needs ${name} (${why}). Set it in .env, or use STT_TTS_PROVIDER=inference against LiveKit Cloud.`);
  return v;
};

/**
 * Build the STT/TTS pair for the agent session.
 * @param voice override the TTS voice id (the fake borrower uses a different one than the agent).
 */
export const buildSpeechStack = (voice?: string): SpeechStack => {
  const provider = speechProvider();
  const sttModel = process.env["LIVEKIT_STT_MODEL"] ?? DEFAULT_STT_MODEL;
  const ttsModel = process.env["LIVEKIT_TTS_MODEL"] ?? DEFAULT_TTS_MODEL;
  const ttsVoice = voice ?? process.env["LIVEKIT_TTS_VOICE"] ?? DEFAULT_TTS_VOICE;

  if (provider === "inference") {
    return {
      provider,
      stt: new inference.STT({ model: sttModel, language: "en" }),
      tts: new inference.TTS({ model: ttsModel, voice: ttsVoice }),
      describe: `inference stt=${sttModel} tts=${ttsModel} voice=${ttsVoice}`,
    };
  }

  const deepgramModel = stripProvider(sttModel);
  const cartesiaModel = stripProvider(ttsModel);
  return {
    provider,
    stt: new deepgram.STT({ apiKey: requireKey("DEEPGRAM_API_KEY", "Deepgram STT"), model: deepgramModel, language: "en" }),
    tts: new cartesia.TTS({ apiKey: requireKey("CARTESIA_API_KEY", "Cartesia TTS"), model: cartesiaModel, voice: ttsVoice }),
    describe: `plugins stt=deepgram/${deepgramModel} tts=cartesia/${cartesiaModel} voice=${ttsVoice}`,
  };
};
