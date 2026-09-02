/**
 * Agent speech as stretches, and the playout truth that says how each one ended (spec 2026-08-30,
 * D4; the `truncated` contract from 2026-09-01, Phase C0).
 *
 * The tier-2 harness only ever needed one instant: the first energetic frame after the borrower
 * fell silent, which is what response latency is. Turn-taking is a different question — every one
 * of {@link turnTakingMetrics}'s six numbers is about a stretch of agent audio with a beginning
 * *and* an end — so this is the piece the tier-3 harness adds, and it is here rather than in the
 * harness for the same reason the metrics are: the harness is the thing being judged.
 *
 * **The subscribed audio track carries frames continuously, silence included**, so frame arrival
 * says nothing about speech and frame *energy* says everything. That is the same observation the
 * onset detector in `scripted-call.ts` rests on, and the same threshold: measured on this system,
 * Aura TTS speech peaks around 250 and channel silence stays under ~25.
 *
 * Pure, and over a list of samples rather than a live stream, so a scenario's timing can be
 * hand-written in a test and a real call can be replayed through the same code.
 */

/** One audio frame reduced to the only thing that matters here: when, and how loud. */
export interface RmsSample {
  readonly atMs: number;
  /** Root-mean-square over the frame's int16 samples. The harness strides by 4 (W8). */
  readonly rms: number;
}

/** A stretch of agent audio: energy in, energy out. */
export interface SpeechWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The level that splits speech from an idle channel.
 *
 * 80, measured: agent TTS speech peaks around 250 and channel silence stays under ~25, so this sits
 * in the middle of a gap an order of magnitude wide. It is a *default*, not a constant of nature —
 * D4's telephony personas degrade the channel deliberately, and a quieter voice moves the level —
 * which is why {@link speechWindows} takes it as an argument.
 */
export const SPEECH_RMS = 80;

/**
 * How long the channel may go quiet before the stretch is considered over.
 *
 * The number has to separate two gaps that are not close together, and it does: the pauses *inside*
 * an agent line at the measured 13 characters per second are a few hundred milliseconds, while the
 * gap *between* two agent turns is the whole latency waterfall — 2 440 ms at p50 on the N=10 run
 * (end-of-turn, transcription, decide, then TTS first byte). 700 ms is above every intra-line pause
 * observed and nowhere near the inter-turn gap, so a line is one stretch and two turns are two.
 *
 * It is deliberately **not** added to the stretch: the hangover decides whether the agent has
 * stopped, and the stretch ends at the last frame that actually carried speech. Adding it would put
 * 700 ms of silence inside every yield latency.
 */
export const SILENCE_HANGOVER_MS = 700;

export interface SpeechWindowOptions {
  readonly speechRms?: number;
  readonly silenceHangoverMs?: number;
}

/**
 * Reduce a call's frames to the stretches in which the agent was speaking.
 *
 * The end of a stretch is the last energetic frame, not the moment the hangover expired — see
 * {@link SILENCE_HANGOVER_MS}. A stretch still open when the samples run out is closed at its last
 * energetic frame too: a call that ends mid-sentence still has a stretch, and it has an end.
 */
export const speechWindows = (samples: ReadonlyArray<RmsSample>, options: SpeechWindowOptions = {}): ReadonlyArray<SpeechWindow> => {
  const speechRms = options.speechRms ?? SPEECH_RMS;
  const hangover = options.silenceHangoverMs ?? SILENCE_HANGOVER_MS;
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);

  const windows: SpeechWindow[] = [];
  let startMs: number | null = null;
  let lastLoudMs = 0;

  for (const s of ordered) {
    if (s.rms > speechRms) {
      if (startMs === null) startMs = s.atMs;
      lastLoudMs = s.atMs;
      continue;
    }
    if (startMs !== null && s.atMs - lastLoudMs >= hangover) {
      windows.push({ startMs, endMs: lastLoudMs });
      startMs = null;
    }
  }
  if (startMs !== null) windows.push({ startMs, endMs: lastLoudMs });
  return windows;
};

/** What the ledger says about one agent turn's audio: when it was reported, and whether it was cut off. */
export interface PlayoutReport {
  /** When `AGENT_TURN_PLAYOUT` was appended — just after the audio it describes ended. */
  readonly atMs: number;
  readonly interrupted: boolean;
}

/**
 * Attach the ledger's playout truth to each stretch, which is what makes them
 * {@link AgentSpeech} rather than a pair of timestamps.
 *
 * **Joined by time, bounded by the next stretch's onset** — the same rule `harness-scores.ts` uses
 * to join per-turn scores, and for the same reason: the harness observes media and the ledger
 * observes the control plane, and there is no shared identifier between them. Without the upper
 * bound a stretch whose playout signal never arrived silently takes the *next* one's and reports
 * its truncation as its own.
 *
 * A stretch with no playout in its window is `truncated: false`. That is not a default standing in
 * for missing data — it is what the absence means: `AGENT_TURN_PLAYOUT` is written when a turn's
 * audio finishes, and the one line that reliably has no turn behind it is the opening, which
 * nothing interrupts. Assuming truncation instead would manufacture false interrupts out of
 * silence, which is precisely the failure Phase C0 removed from the other end of this contract.
 */
/**
 * How far a playout report may appear to precede the stretch it belongs to (issue #4, H11).
 *
 * The same quantity, and the same reasoning, as `harness-scores.ts`'s join: the harness stamps the
 * stretch from audio it is receiving and the control plane stamps the report from its own clock, and
 * a few milliseconds either way is skew rather than evidence. Without it a report that landed a
 * millisecond before its stretch's first energetic frame was booked to the *previous* stretch, and
 * both stretches then carried the wrong truth.
 */
export const CLOCK_GRACE_MS = 250;

export const withPlayoutTruth = (
  windows: ReadonlyArray<SpeechWindow>,
  playouts: ReadonlyArray<PlayoutReport>,
): ReadonlyArray<SpeechWindow & { readonly truncated: boolean | null }> => {
  const ordered = [...windows].sort((a, b) => a.startMs - b.startMs);
  const reports = [...playouts].sort((a, b) => a.atMs - b.atMs);
  return ordered.map((w, i) => {
    const until = ordered[i + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    const hit = reports.find((p) => p.atMs >= w.startMs - CLOCK_GRACE_MS && p.atMs < until);
    /**
     * **`null`, not `false`, when nothing was joined** (issue #4, H11).
     *
     * This used to answer `false`, on the argument that the one line reliably without a turn behind
     * it is the opening, which nothing interrupts. That is true of the opening and false of the
     * others: `safeFallback`, the no-input prompt and any `say` the control plane emits outside a
     * turn all produce a stretch with no playout — and answering `false` for those asserts the agent
     * was *not* interrupted, which is a claim about audio nobody reported. On the hold-request
     * scenario that assertion is the metric under test.
     *
     * `turnTakingMetrics` excludes an unknown stretch from every rate and counts it, so a run whose
     * stretches mostly lack playout truth reads as thin rather than as clean.
     */
    return { ...w, truncated: hit === undefined ? null : hit.interrupted };
  });
};
