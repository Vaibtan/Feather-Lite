/**
 * The simulator's borrowers (issue #1, D4 — Phase 4).
 *
 * D4 asks for at least five voices, fixed per seed. Each carries its own **degradation profile**,
 * because an accent and a bad line are the same question asked twice: can the recogniser still hear
 * the amount? Keeping them together means one seed picks a whole borrower — voice and line quality —
 * rather than two knobs a caller has to remember to set consistently.
 *
 * The numbers are profiles rather than adjectives on purpose. "Noisy" is not something two runs can
 * be compared on; 15 dB SNR with 2% bursty loss is.
 */
import { seedFrom } from "./random.js";

export interface DegradationProfile {
  /** Background noise, as a signal-to-noise ratio in dB. Lower is worse. */
  readonly snrDb: number;
  /** Share of frames lost, 0..1. */
  readonly lossRate: number;
  /** How clumped the losses are; 1 is memoryless. See `dropFrames`. */
  readonly burstiness: number;
  /** Whether the line goes through a G.711 μ-law round trip. */
  readonly muLaw: boolean;
}

export interface Persona {
  readonly id: string;
  /** The Deepgram Aura model; for Aura the voice **is** the model. */
  readonly voice: string;
  readonly what: string;
  /** Null means an undegraded line — the control the other four are measured against. */
  readonly degradation: DegradationProfile | null;
}

export const PERSONAS: ReadonlyArray<Persona> = [
  {
    id: "clean",
    voice: "aura-2-asteria-en",
    what: "a studio-quality line: the control every other persona is measured against",
    degradation: null,
  },
  {
    id: "mobile",
    voice: "aura-2-orion-en",
    what: "a decent mobile call: the codec, a quiet room, the odd lost frame",
    degradation: { snrDb: 25, lossRate: 0.005, burstiness: 3, muLaw: true },
  },
  {
    id: "street",
    voice: "aura-2-luna-en",
    what: "outdoors with traffic behind them, which is where a collections call often lands",
    degradation: { snrDb: 15, lossRate: 0.01, burstiness: 4, muLaw: true },
  },
  {
    id: "poor-signal",
    voice: "aura-2-arcas-en",
    what: "a weak signal: audible but dropping syllables in bursts",
    degradation: { snrDb: 20, lossRate: 0.04, burstiness: 8, muLaw: true },
  },
  {
    id: "speakerphone",
    voice: "aura-2-athena-en",
    what: "a speakerphone in a room: reverberant and further from the microphone",
    degradation: { snrDb: 12, lossRate: 0.008, burstiness: 3, muLaw: true },
  },
];

/**
 * The persona a seed selects.
 *
 * Hashed rather than taken modulo directly, so neighbouring seeds do not walk the table in order —
 * a sweep over seeds 1..5 should not be a sweep over the personas in the order they are written.
 */
export const personaForSeed = (seed: number): Persona => {
  const index = seedFrom(`persona:${String(seed)}`) % PERSONAS.length;
  return PERSONAS[index] ?? PERSONAS[0]!;
};
