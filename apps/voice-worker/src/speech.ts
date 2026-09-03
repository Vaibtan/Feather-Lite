/**
 * `inference.STT`/`inference.TTS` are a Cloud-only gateway, so a self-hosted `livekit-server` must
 * talk to the providers directly — that is the whole of `STT_TTS_PROVIDER`. In `plugins` mode
 * Deepgram Aura has no separate voice id (the voice IS the model), so `voice` must be an Aura model
 * name and `LIVEKIT_TTS_MODEL` is ignored.
 */
import { STT_FILLER_WORDS, parseFlag } from "./env.js";
import { type stt as sttBase, type tts as ttsBase, inference } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";

export type SpeechProvider = "inference" | "plugins";

export interface SpeechStack {
  readonly provider: SpeechProvider;
  readonly stt: sttBase.STT;
  readonly tts: ttsBase.TTS;
  readonly describe: string;
}

const DEFAULT_STT_MODEL = "deepgram/nova-3";
const DEFAULT_TTS_MODEL = "cartesia/sonic-3";
/** A Cartesia voice id, resolved by Cloud Inference. */
const DEFAULT_TTS_VOICE = "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
const DEFAULT_PLUGINS_TTS_VOICE = "aura-2-asteria-en";

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

  const deepgramSttModel = stripProvider(sttModel);
  /** Parsed, never coerced, so a typo is a refusal rather than a silently-off gate. */
  const fillerFlag = parseFlag(process.env[STT_FILLER_WORDS.name], STT_FILLER_WORDS);
  if (!fillerFlag.ok) throw new Error(fillerFlag.message);
  const sttFillerWords = fillerFlag.value;
  const auraModel = voice ?? process.env["DEEPGRAM_TTS_MODEL"] ?? DEFAULT_PLUGINS_TTS_VOICE;
  const apiKey = requireKey("DEEPGRAM_API_KEY", "Deepgram STT + Aura TTS");
  return {
    provider,
    /**
     * With Deepgram's `filler_words=false` a backchannel is not transcribed at all, so the
     * backchannel classifier has no input and can never fire. Left off by default anyway, because
     * it changes every transcript and therefore what the word-error gate measures.
     */
    stt: new deepgram.STT({ apiKey, model: deepgramSttModel, language: "en", fillerWords: sttFillerWords }),
    tts: new deepgram.TTS({ apiKey, model: auraModel }),
    describe: `plugins stt=deepgram/${deepgramSttModel} tts=deepgram/${auraModel}`,
  };
};
