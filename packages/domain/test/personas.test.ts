/**
 * The simulator's borrowers, fixed per seed (issue #1, D4 — Phase 4).
 *
 * D4 asks for at least five voices, and for the choice to be a function of the seed so a run can be
 * repeated. The persona also carries its own degradation profile, because an accent and a bad line
 * are the same question asked twice: can the recogniser still hear the amount?
 */
import { describe, expect, it } from "vitest";
import { PERSONAS, personaForSeed } from "../src/personas.js";

describe("PERSONAS", () => {
  it("has at least the five D4 asks for", () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(5);
  });

  it("gives every persona a distinct voice, or they are not five borrowers", () => {
    expect(new Set(PERSONAS.map((p) => p.voice)).size).toBe(PERSONAS.length);
  });

  it("keeps one persona clean, so the baseline is still measurable", () => {
    /**
     * Without it every number moves at once and nothing is attributable: a WER change could be the
     * accent, the noise or the codec. The clean persona is the control.
     */
    const clean = PERSONAS.filter((p) => p.degradation === null);
    expect(clean).toHaveLength(1);
    expect(clean[0]?.id).toBe("clean");
  });

  it("gives every degraded persona a measurable profile, not an adjective", () => {
    for (const p of PERSONAS) {
      if (p.degradation === null) continue;
      expect(p.degradation.snrDb).toBeGreaterThan(0);
      expect(p.degradation.lossRate).toBeGreaterThanOrEqual(0);
      expect(p.degradation.lossRate).toBeLessThan(0.5);
      expect(p.degradation.burstiness).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("personaForSeed", () => {
  it("is a function of the seed, so a run can be repeated", () => {
    expect(personaForSeed(7).id).toBe(personaForSeed(7).id);
    expect(personaForSeed(0).id).toBe(personaForSeed(0).id);
  });

  it("spreads across the table rather than always picking one", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => personaForSeed(i).id));
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it("always returns one of the declared personas", () => {
    const ids = new Set(PERSONAS.map((p) => p.id));
    for (let s = 0; s < 20; s++) expect(ids.has(personaForSeed(s).id)).toBe(true);
  });
});
