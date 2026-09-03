/**
 * Frames are re-chunked to 10 ms so replayed playout is paced like the TTS stream that produced it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tts as ttsBase } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";

const CACHE_DIR = fileURLToPath(new URL("../../.cache/borrower-lines/", import.meta.url));

const FRAME_MS = 10;

const wavPathFor = (key: string) => join(CACHE_DIR, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.wav`);

const writeWav = (path: string, pcm: Int16Array, sampleRate: number, channels: number): void => {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes).copy(buf, 44);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
};

/**
 * Chunks are walked rather than read positionally: a positional reader assumes a canonical 44-byte
 * RIFF header, and anything between `fmt ` and `data` (a `LIST`/`INFO` or `fact` chunk) then reads
 * metadata bytes as samples — noise the borrower speaks, not a throw. Exported so it can be tested
 * on a buffer rather than through the cache.
 */
export const parseWav = (buf: Buffer, source = "<buffer>"): { pcm: Int16Array; sampleRate: number; channels: number } => {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`not a WAV file: ${source}`);

  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let data: Buffer | null = null;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (body + size > buf.length) break; // truncated file: keep whatever was complete
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size % 2); // pad byte when the size is odd
  }

  if (channels === null || sampleRate === null || bitsPerSample === null) throw new Error(`WAV has no fmt chunk: ${source}`);
  if (data === null) throw new Error(`WAV has no data chunk: ${source}`);
  // Anything but 16-bit would be read as noise rather than converted, so it is a refusal.
  if (bitsPerSample !== 16) throw new Error(`WAV is ${String(bitsPerSample)}-bit, expected 16: ${source}`);

  const pcm = new Int16Array(Math.floor(data.length / 2));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2);
  return { pcm, sampleRate, channels };
};

const readWav = (path: string): { pcm: Int16Array; sampleRate: number; channels: number } => parseWav(readFileSync(path), path);

const toFrames = (pcm: Int16Array, sampleRate: number, channels: number): AudioFrame[] => {
  const samplesPerChannel = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const step = samplesPerChannel * channels;
  const frames: AudioFrame[] = [];
  for (let off = 0; off + step <= pcm.length; off += step) {
    frames.push(new AudioFrame(pcm.slice(off, off + step), sampleRate, channels, samplesPerChannel));
  }
  return frames;
};

const concat = (frames: ReadonlyArray<AudioFrame>): Int16Array => {
  const total = frames.reduce((n, f) => n + f.data.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f.data, off);
    off += f.data.length;
  }
  return out;
};

export interface SynthesizedLine {
  readonly frames: ReadonlyArray<AudioFrame>;
  readonly sampleRate: number;
  readonly channels: number;
  readonly cached: boolean;
}

/**
 * `cacheKey` must capture everything that changes the audio (provider, model, voice), or a provider
 * switch replays the wrong voice.
 */
export const synthesizeCached = async (tts: ttsBase.TTS, text: string, cacheKey: string): Promise<SynthesizedLine> => {
  const path = wavPathFor(`${cacheKey}::${text}`);
  if (existsSync(path)) {
    const { pcm, sampleRate, channels } = readWav(path);
    return { frames: toFrames(pcm, sampleRate, channels), sampleRate, channels, cached: true };
  }

  const raw: AudioFrame[] = [];
  const stream = tts.stream();
  stream.pushText(text);
  stream.flush();
  stream.endInput();
  for await (const ev of stream) {
    if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
    raw.push(ev.frame);
  }
  stream.close();
  const first = raw[0];
  if (!first) throw new Error(`TTS produced no audio for ${JSON.stringify(text)}`);
  const pcm = concat(raw);
  writeWav(path, pcm, first.sampleRate, first.channels);
  return { frames: toFrames(pcm, first.sampleRate, first.channels), sampleRate: first.sampleRate, channels: first.channels, cached: false };
};
