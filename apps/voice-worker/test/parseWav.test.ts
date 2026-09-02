/**
 * Reading a WAV whose header is not the canonical 44 bytes (issue #4, H10).
 *
 * The reader took channels from byte 22, the sample rate from 24, the data length from 40 and the
 * samples from 44 — the layout of a canonical RIFF header and only that. Anything between `fmt ` and
 * `data` (a `LIST`/`INFO` chunk naming the encoder, a `fact` chunk, a pad byte) shifts every one of
 * those, and the failure is not a throw: it is samples read out of the middle of a metadata string,
 * which the borrower then speaks as noise.
 */
import { describe, expect, it } from "vitest";
import { parseWav } from "../src/tracer/line-cache.js";

const chunk = (id: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  // RIFF pads an odd-sized chunk to an even boundary; the pad byte is not part of the size.
  const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, body, pad]);
};

const fmtChunk = (channels: number, sampleRate: number, bits = 16): Buffer => {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(1, 0); // PCM
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(sampleRate, 4);
  b.writeUInt32LE((sampleRate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
};

const pcmChunk = (samples: readonly number[]): Buffer => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};

const wav = (...chunks: Buffer[]): Buffer => {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
};

const SAMPLES = [0, 1000, -1000, 32767, -32768, 7];

describe("parseWav", () => {
  it("reads a canonical file, which is what it always could do", () => {
    const r = parseWav(wav(chunk("fmt ", fmtChunk(1, 24_000)), chunk("data", pcmChunk(SAMPLES))));
    expect(r.channels).toBe(1);
    expect(r.sampleRate).toBe(24_000);
    expect([...r.pcm]).toEqual(SAMPLES);
  });

  it("reads a file with a LIST chunk between fmt and data — the case that produced noise", () => {
    const list = Buffer.concat([Buffer.from("INFO", "ascii"), chunk("ISFT", Buffer.from("Lavf60.16.100\0", "ascii"))]);
    const r = parseWav(wav(chunk("fmt ", fmtChunk(1, 24_000)), chunk("LIST", list), chunk("data", pcmChunk(SAMPLES))));
    // Positionally, byte 44 lands inside "INFO"/"ISFT" and the samples come out as text.
    expect(r.sampleRate).toBe(24_000);
    expect([...r.pcm]).toEqual(SAMPLES);
  });

  it("survives an odd-sized chunk, whose pad byte is not counted in its size", () => {
    const r = parseWav(wav(chunk("fmt ", fmtChunk(2, 48_000)), chunk("junk", Buffer.from("odd", "ascii")), chunk("data", pcmChunk(SAMPLES))));
    expect(r.channels).toBe(2);
    expect(r.sampleRate).toBe(48_000);
    expect([...r.pcm]).toEqual(SAMPLES);
  });

  it("reads a file whose data chunk comes before fmt", () => {
    // Unusual and legal; a walker gets it for free and a positional reader cannot.
    const r = parseWav(wav(chunk("data", pcmChunk(SAMPLES)), chunk("fmt ", fmtChunk(1, 16_000))));
    expect(r.sampleRate).toBe(16_000);
    expect([...r.pcm]).toEqual(SAMPLES);
  });

  it("refuses what it cannot read, rather than returning noise", () => {
    expect(() => parseWav(Buffer.from("not a wav at all"))).toThrow(/not a WAV/);
    expect(() => parseWav(wav(chunk("fmt ", fmtChunk(1, 24_000))))).toThrow(/no data chunk/);
    expect(() => parseWav(wav(chunk("data", pcmChunk(SAMPLES))))).toThrow(/no fmt chunk/);
    // 8- or 24-bit would be read as 16-bit samples and played as noise, so it is a refusal.
    expect(() => parseWav(wav(chunk("fmt ", fmtChunk(1, 24_000, 24)), chunk("data", pcmChunk(SAMPLES))))).toThrow(/24-bit/);
  });

  it("keeps what was complete when a file is truncated mid-chunk", () => {
    const full = wav(chunk("fmt ", fmtChunk(1, 24_000)), chunk("data", pcmChunk(SAMPLES)));
    const cut = full.subarray(0, full.length - 4);
    // The data chunk's declared size overruns the buffer, so it is dropped rather than read past the
    // end — and a file with no usable data chunk is a refusal, not silence.
    expect(() => parseWav(cut)).toThrow(/no data chunk/);
  });
});
