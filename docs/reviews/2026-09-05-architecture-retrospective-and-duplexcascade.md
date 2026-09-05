# Architecture retrospective, and what DuplexCascade (2603.09180) offers this pipeline

2026-09-05. Written at `7bc4bc3` (main, 8 ahead of origin). Inputs: the code as the source of
truth (surveyed file by file), the 2026-08-30 research doc and spec, ADRs 0001–0010, the loadtest
README through the wait-ladder gate, the 09-04 and 09-05 handoffs, the installed
`@livekit/agents@1.6.4` dist, and the paper *DuplexCascade: Full-Duplex Speech-to-Speech Dialogue
with VAD-Free Cascaded ASR–LLM–TTS Pipeline and Micro-Turn Optimization* (Yang, Fujita, Sudo;
SB Intuitions, March 2026), plus its two nearest neighbours found through Papers With Code
(SoulX-Duplug 2603.14877, Full-Duplex-Bench-v2 2510.07838).

This is an assessment. It changes no code. §6 lists the decisions that are the user's to make.

---

## 1. The system as it actually stands

### 1.1 Shape

Two processes, one ledger. The **control plane** owns every decision: T1 claims the turn under a
row lock and appends `USER_TURN_FINAL`; `decide` runs outside any transaction (`matchOverride`,
then the OpenAI decider); T2 re-locks, validates transition and tool fail-closed, executes, appends
`AGENT_TURN`, and only then are `say`/`turn_end` frames emitted (ADR 0003). The **voice worker**
turns audio into `user_text` and frames into speech and decides nothing (ADR 0001) — except that
it now owns two things the spec pushed onto it: the *only* silence clock (`userAwayTimeout: null`;
the SDK's own timer wedges after one firing), and the `resume` decision on backchannels, because
that must happen inside the SDK's pause machinery.

Two turn-taking decisions were added ahead of T1 since 2026-08-30 and both are control-plane:
`held` (a pre-T1 poll every 150 ms, bounded by the segment's `tts_audio_ms` + 400 ms, cap 12 s,
until the non-interruptible segment's `AGENT_TURN_PLAYOUT` lands) and `wait` (the `holdRequest`
lexicon with `bare`/`errand` kinds sizing a 5 s / 15 s window, a second consecutive hold answered).

### 1.2 What the 2026-08-30 spec asked for, against the code

| Spec item | Code |
|---|---|
| D0 instruments | built |
| W11 native VAD | built (Linux/containers; unusable on Windows host) |
| D1 `respond` / `wait` / `held` | built; `wait` reshaped 09-05 into the nudge-then-close ladder |
| D1 `resume` | built in the worker via the SDK's private `_activity` seam; **reads finals as well as interims because a backchannel produces no interim at all**; gate p50 378 ms vs < 300 ms, not met, the residue is Deepgram finalisation. `disposition: "resume"` is a declared value the control plane never assigns; the evidence is `resumed_ms[]` on `turn_metrics`. |
| D2 deterministic fast path | **not built.** No `classifyIntent`, no `fast_path` decider, `TurnDecisionSource` is `override \| model \| scripted \| none`. `Queries.ts:161-163` already explains segmentation in terms of a fast path that does not exist. |
| D3 biasing + entity gate | built (`biasTermsFor`, gated on `unlockedThisTurn`, sent once on `turn_end`; `entityErrors` + `--max-amount-errors 0`) |
| D4 tier 3 | four runnable scenarios (`clean-happy-path`, `yes-during-read-back`, `backchannel-mid-line`, `hold-request`); `third-party-pickup` and `accent-noise-ablation` are stubs although the five personas and the degradation model exist; the six turn-taking numbers are computed by the harness only, not surfaced on the Quality page |
| D5 knobs | D5.1 answered as a config correction (adaptive never ran — 401 from hosted inference — **every barge-in number is a VAD number**); D5.2 `minDuration` 700 ms measured, did not help, kept at 500; D5.3–D5.6 (`unlikelyThreshold`, first-clause TTS, `tts_connect_ms`, `service_tier`) not run — the session sets no `turnDetection`/`endpointing` at all |
| D6 judge abstention / corrected prevalence | not built; `confidence` is captured and never read |
| D7 ADR 0011 | not written |

### 1.3 The numbers that matter

Waterfall at N=10 (the only run with a computed SLO verdict), p50 / p95, ms:

| stage | p50 | p95 | target |
|---|---|---|---|
| `eou_delay_ms` | 578 | 647 | 700 |
| `transcription_delay_ms` | 522 | 645 | 600 |
| `ttft_ms` | 975 | 1489 | 1500 |
| `tts_ttfb_ms` | 385 | 406 | 600 |
| `total_ms` | 2440 | 2933 | 2500 |

Verdict `breach` on `total_ms` and `transcription_delay_ms`. Equivalence 10/10, WER 0/0,
compliance scores 1.0. The four gates hold except the SLO, which has never held at p95.

Recent N=5 gates: cleanup 4/5 twice, wait-ladder 3/5. Every failure is one of two shapes — a
two-clause borrower line split into two finals (the second half supersedes the offer), or a
read-back playout booked to the following turn id so the fully-heard guard refuses the promise.
Both are attribution/ordering defects between worker and control plane, not model defects.

Tier-3 turn-taking (single calls, VAD interruption): `yield_latency_ms` ~680–1000,
`agent_interrupt_rate` 0.33 on the happy path, `response_rate` 0.67–0.75, and 8 stretches with no
playout evidence excluded on the N=5 baseline — the six numbers are not yet a stable baseline.

---

## 2. The paper, read carefully

### 2.1 What it does

DuplexCascade keeps ASR → LLM → TTS but removes the VAD as the turn authority. Streaming ASR
partials are flushed every Δt = 0.6 s into a "micro-turn"; the LLM is invoked on **every**
micro-turn, including silent ones (`<no voice>`), and its first output is a control token:

| token | meaning | our vocabulary |
|---|---|---|
| `<user is speaking>` | stay silent, utterance incomplete | (the EOU model's "unlikely" branch → `maxDelay`) |
| `<user finish speaking>` + text | take the turn | `respond` |
| `<user is interrupting>` | stop generation now | barge-in (VAD today) |
| `<user backchannel>` | ignore, keep speaking | `resume` |
| `<user is thinking>` | post-response silence, do nothing | the silence clock's window |
| `<system backchannel>` | play a canned "uh-huh" during user speech | **nothing** |

The LLM (Qwen2-7B) is LoRA-adapted for 5k steps on 50k **text-only** UltraChat dialogues rewritten
into micro-turn sequences by simulation: micro-turn length 1–7 tokens, natural pauses inserted with
p = 0.10 (1–5 silent turns), user interruption at a random system micro-turn boundary with
p = 0.30, user backchannel with p = 0.01 per system micro-turn, 1–20 silent "thinking" turns after
each system reply, and system-backchannel markers inserted by Qwen2-72B. Loss is weighted toward
the rare tokens (`<user finish speaking>` ×10, `<user is interrupting>` ×5). 8×H100, 5 hours.

### 2.2 What it measured

- Best *Averaged Turn-Taking Accuracy* among open systems on Full-Duplex-Bench (0.858 for the
  variant with system backchannels; Freeze-Omni 0.759 as the VAD-cascade comparator).
- VoiceBench: 65.8 overall vs 69.7 for the same LLM behind plain ASR — the text-only adaptation
  keeps most of the backbone's intelligence, which is the paper's real point.
- **Latency is the weak column.** Smooth-turn-taking latency 1.72 s (Freeze-Omni 0.27 s, Moshi
  0.35 s); user-interruption latency 1.23 s. The Δt sweep (Fig. 3) shows accuracy peaking at
  Δt = 1.2 s and latency rising monotonically with Δt; 0.6 s is chosen as the compromise.
- The system-backchannel variant scores second-best on backchannel frequency/JSD while holding
  turn-taking accuracy — the one result with no analogue in our pipeline.

### 2.3 The honest reading

The paper's target is a cascade whose turn authority is a **plain VAD**. This pipeline is not that:
LiveKit's audio-native turn detector already runs an in-process transformer on the transcript
context at every pause (`audio_recognition.js:1005-1140`), which is the "modular state-driven"
category SoulX-Duplug's taxonomy puts next to DuplexCascade, not the category it beats. The gap
the paper closes here is narrower than its abstract suggests — and its own latency (1.7 s to take
a smooth turn on local H100 inference) is not a number to chase from behind hosted APIs.

What the paper *does* establish that we can use:

1. Turn-taking is a **six-way** decision, not the four-way one the spec adopted. We have no
   analogue for `<user is thinking>` beyond a fixed silence window, and none for `<system
   backchannel>`.
2. A small synthetic **text-only** corpus is enough to teach a language model the turn-taking
   tokens. That collapses the cost of the spec's Q3 escape hatch ("a model-backed classifier is a
   later spec if the `unclear` share is high").
3. Its data-simulation table is a usable **prior for the simulator's event mix** (§4.3).

### 2.4 Why the mechanism itself does not transfer

- **The decider is behind an API.** `ttft_ms` p50 is 975 ms; a Δt of 600 ms would have the next
  micro-turn's request in flight before the last one answered. Even at the paper's accuracy-optimal
  Δt = 1.2 s the loop would run at the edge of TTFT with no margin.
- **Cost.** One call at Δt = 0.6 s is ~100 decider requests a minute against a 1–2k-token prompt,
  most of them answering "stay silent". Today a call is ~8–12 requests.
- **No special tokens on a hosted model.** They could be emulated with a first-line enum or a
  tool call, but the behaviour has to be *trained* (the paper fine-tunes; a prompt-only version is
  the "LLM-decided turn-taking" the spec ruled out for reproducibility, and every decision would
  cost a model call).
- **The compliance surface.** The LLM deciding *when* to speak, in a domain where what it says is
  tool-gated and judged, adds a second unaudited decision to every turn. The control plane's
  reason to exist (ADR 0001) is that these decisions are recorded and replayable.
- **VAD-free is not our problem.** Our EOU is already semantic; our barge-in is VAD-only because
  the ML interruption classifier needs LiveKit Cloud credentials (§4.6), not because the design
  lacks one.

So the question is not "should we run DuplexCascade" but "which of its six decisions do we make
badly or not at all, and what is the cheapest instrument that makes each one".

---

## 3. What the survey found about the architecture itself

Ordered by how much they are costing today.

### 3.1 Turn attribution in the worker is inferred, and the inference has two paths

The control plane names every turn, but the worker decides *which turn a spoken item belongs to*
by (a) a stamp set through the SDK internal `_addItemAddedCallback` on `say` handles, and (b) a
fallback to the mutable `currentTurnId` for anything unstamped — and the model reply built from
`delta` frames is **never stamped** (`feather-agent.ts:244-252`, `:354-365`). A second inline
attribution path in `llmNode` (`:338-349`) builds a `playout` from `chatCtx`'s last assistant item
and writes `lastReportedTurnId` / `ttsProducedAudio` from a different data source than
`reportTurnPlayout` does. Both gate failures in §1.3 sit here. Handoff item 2c (collapse five maps
into one `TurnRecord`) is the right instinct but is still an *inference*. The structural fix is to
stop inferring: the control plane already knows each `say` segment; give each a `segment_id` on
the frame, have the worker report playout **per segment id**, and let the control plane fold
segments into turns (it holds `AGENT_TURN` and can key `AGENT_TURN_PLAYOUT` by segment). The
`delta` reply becomes one implicit segment named by the turn. Attribution then lives in the
contract, `held`'s "unreported non-interruptible segment" query becomes exact, and the fully-heard
guard reads the read-back's own segment rather than the turn's concatenated parts.

### 3.2 The wire does not carry the decisions the ledger records

`turn_end` has no `disposition`, no `decider`, no `speak_mode` (`turnFrames.ts:43-84`); the
simulator re-fetches them from `/latency` after the fact. The worker only sees
`allow_interruptions: boolean` per `say`. Cheap to fix, and it removes a second source of truth.

### 3.3 Built but stranded

`turnTakingMetrics`, `bargeInT90`, `entityErrors`, the judge's `confidence` field — all pure,
all tested, none visible where an operator looks. The Quality page still has no turn-taking card,
so "it talks over people" is a JSON file in `docs/loadtest/`, not a number on a page.

### 3.4 Vocabulary drift

`TurnDecisionSource` says `model`; `conversations.decider` says `openai`; `TurnDisposition`
declares `resume` and nothing assigns it; `scenarios-tier3.ts` still says `resume` "does not exist
yet" and points `backchannel-mid-line`'s `until` at a D5.2 sweep that already ran and failed.
None of these break anything; together they make the next reader re-derive facts.

### 3.5 The largest SLO lever is the unbuilt one

At p50 the four stages sum to 2460 against 2500. `ttft_ms` is 975 p50 / 1489 p95 and is the only
stage with a deterministic alternative: in `CONFIRMING_OUTCOME` the acceptable answers are
enumerable and the fast path (D2) would take ~1 s out of roughly one turn in four — including the
turn the borrower is most impatient on. It is also what `Queries.ts` already segments for. Nothing
in the paper changes this; it reinforces it (the paper's own result is that the LLM's *content*
capability is what to preserve, and the control decision is cheap once it is explicit).

### 3.6 Things that are right and should not be re-opened

One silence clock owned by the worker with the window sized by the control plane; `held` decided
from ledger playout truth rather than by discarding audio; `discardAudioIfUninterruptible: false`;
the fully-heard guard fail-closed on voice; the account-facts gate shared by prompt and STT bias;
simulator calls as their own segment; rules with confidence ∈ {0,1} for `wait`/`resume`.

---

## 4. What to take from the paper, ranked

Each item names the paper's token it answers, the mechanism we already have, the gate, and the
cost. Nothing here relaxes the four gates or re-proposes research §5.

### 4.1 `<user is thinking>` — a state-conditioned silence window (cheap, domain-only)

The wait ladder fires on a fixed clock: 12 s ordinary, 5 s / 15 s after a hold. The paper's
observation is that post-response silence has a *type*: the borrower is processing what was said.
In this domain the type is knowable from the ledger: after an open question ("what can you
manage?") a longer pause is expected; after a yes/no read-back a shorter one is; after a Mini-
Miranda disclosure the pause is the borrower deciding whether to hang up. `waitPolicy.ts` already
holds the constants as domain values; make `extend_away_ms` a function of (state, last agent
act) rather than of the hold kind alone. Table-tested, no new prompt copy, no live-behaviour
change beyond the window sizes. **Gate:** tier-3 `hold-request` and a new `post-question-pause`
scenario show no `NO_INPUT` nudge inside the expected thinking window; N=5 unchanged.
**Ask before changing:** the numbers are live-call behaviour (standing instruction).

### 4.2 Record the EOU decision we already make (free instrument, unlocks D5.3)

The SDK emits `eot_prediction` on the session at every end-of-turn inference
(`agent_activity.js:1253-1255`, `events.d.ts:157-175`) with `probability`, `threshold`,
`inferenceDurationMs` and `delayMs`. Nothing subscribes. This *is* the paper's
`<user is speaking>` vs `<user finish speaking>` decision, already made in-process and thrown
away. Subscribe, attach the last prediction to `turn_metrics` (`eou_probability`,
`eou_unlikely`), persist on the turn. Then: the `unlikelyThreshold` sweep (D5.3) becomes an
offline replay over recorded probabilities instead of three N=5 runs; the split-final defect
(§1.3) gets a diagnostic — was the first half committed at `minDelay` with a high probability, or
at `maxDelay` with a low one; and the `wait` lexicon gets a second opinion to compare against.
Note it is per-pause, not a Δt stream: the detector runs when VAD sees silence, not every 600 ms.
**Gate:** the field appears on every voice turn; no latency change (it is a listener).

### 4.3 The paper's event mix as the simulator's "realistic" scenario

Tier 3 has one-event scenarios. The paper's data table is a prior for a mixed one: hesitation
pauses inside a borrower line with p ≈ 0.10, an interruption at a random agent-line boundary with
p ≈ 0.30, a backchannel with p ≈ 0.01 per agent clause, a thinking pause of 1–20 × Δt after each
agent reply. Seeded as the spec requires, so it stays reproducible. Full-Duplex-Bench's *pause
handling* condition — a mid-utterance pause the agent must not answer — is the one shape none of
the six existing scenarios exercises and is exactly the split-final failure the gate keeps hitting.
Add `mid-utterance-pause` first, `realistic-mix` second. **Gate:** both run green on the clean
persona as tripwires before any turn-taking change lands.

### 4.4 `<system backchannel>` — agent backchannels during long borrower turns (measure first)

Today a borrower explaining a hardship for twenty seconds hears nothing. The SDK has the hook
(`onAgentBackchannelOpportunity`) but it is a no-op in 1.6.4 and only the cloud EOT model produces
`backchannelProbability` (`languages.js:60-61`). A rule-based version is possible — borrower
speaking > N s, VAD pause, EOU probability below threshold, play a pre-synthesised clip through
`say` with `allowInterruptions: true` — and the paper shows canned clips are how it is done. But
in a regulated collections call the agent's tone is a compliance surface (research §3.5), and an
"uh-huh" through a hardship account can read as impatience or as attention. **Do not build until
the simulator can measure it**: add the agent-backchannel count to the turn-taking metrics, have
the judge's `empathy_professionalism` dimension see the transcript with the backchannels marked,
and decide on a labelled sample. This is a user decision (§6).

### 4.5 The escape hatch, re-priced

The spec's Q3 says a model-backed `wait`/`resume`/intent classifier comes only if the lexicons
miss too much, and research §5 rejects a second EOU model because a detector swap is a new fleet
baseline. Both stand. What the paper changes is the *cost* of the model-backed option if the
`unclear` and hold-miss shares ever justify it: 50k synthetic text dialogues and a LoRA on a small
open model, text-only, no audio alignment. SoulX-Duplug (2603.14877) is the other route — an
open, plug-in streaming state predictor with `incomplete` and `backchannel` states at ~240 ms —
and it is a detector swap. Record both as the named options behind the trigger; measure the
trigger first: log every `wait` miss and `resume` miss the simulator produces and every model
turn in `CONFIRMING_OUTCOME` that a rule would have answered.

### 4.6 Barge-in on a self-hosted media plane: what "best" is, and what Cloud would buy (user decisions 2026-09-05)

Self-hosted LiveKit is the primary, gated profile of this project: a portable architecture whose
default needs no data-residency caveat in a regulated domain. It is not a permanent exclusion of
LiveKit Cloud — ADR 0006 already made Cloud vs local an `.env` change, and the Cloud profile passes
with direct plugins. The decision (2026-09-05) is **self-hosted primary, Cloud measured once**: one
A/B on `backchannel-mid-line` and `yes-during-read-back` with `mode: "adaptive"` on, N=5, so ADR
0011 can state in numbers what ML barge-in buys and what self-hosting costs. So the question is what
the paper's `<user backchannel>` vs `<user is interrupting>` distinction can be on this box, and
what the one Cloud run has to show to change that. Checked 2026-09-05:

| option | what it gives | cost on this stack | verdict |
|---|---|---|---|
| LiveKit `mode: "adaptive"` + cloud EOT `backchannelProbability` | audio-side overlap classifier; agent-backchannel opportunities — the largest turn-taking gain available anywhere | Cloud-only; the open `livekit/turn-detector` is `v1-mini`, text-only, one probability; a hosted hop on the audio path with unmeasured latency from this box; media and transcripts leave the deployment | **measured once, not adopted by default**: the A/B number goes into ADR 0011 as the recorded price of self-hosting |
| `@livekit/agents` 1.7.0–1.8.0 (1.8.0 published 2026-09-05) | no local interruption or backchannel model; **four fixes on our races** — stale interrupted-speech cleanup no longer flips state to `listening` (#2341; that flip arms our silence clock early), superseded queued replies interrupted on a confirmed turn (#2342), `say()` transcripts timestamped at speech start (#2421), transcription-delay anchored on VAD speech-end not transcript arrival (#2382 — **changes the measurement of our breaching stage**) | new fleet baseline (ADR 0010 D1); our two private seams (`_activity.startFalseInterruptionTimer`, `_addItemAddedCallback`) must be re-verified | **upgrade as its own measured step**, after the attribution contract (§3.1) removes one seam |
| `livekit/livekit-server` v1.13.6 (from v1.13.5) | `AgentHandler.DrainConnections` deadlock fix on worker close; NACK/retransmit and ICE-TCP hardening; nothing in VAD/turn paths | container bump | **take it** with the next rebuild, re-baselined in the same run |
| Pipecat **Smart Turn v3** (8 MB int8, Whisper-tiny encoder, BSD-2, 12–65 ms CPU) | audio-native complete/incomplete — prosody the text-only `v1-mini` cannot see | a sidecar next to the worker; a detector *swap* is a new baseline | **shadow mode first**: log its verdict beside `eot_prediction` per pause; promote only if the log shows it would have stopped split finals |
| **Easy Turn** (2509.23938; 850 MB, ~2.5 GB VRAM, 263 ms on a 4090, Apache-2.0) | the only released 4-way `complete / incomplete / backchannel / wait` model | GPU host | the named GPU-tier option; not for this box |
| **SoulX-Duplug** 0.6B (Apache-2.0, Qwen3-0.6B + GLM-4-Voice tokenizer, evaluated on an L20) | streaming `idle / nonidle / backchannel / complete / incomplete` at ~240 ms | GPU host; CPU unbenchmarked | second GPU-tier option |
| Tencent semantic VAD, Phoenix-VAD, FlexDuo | exactly the distinction wanted | **no released weights** | not available |
| Deepgram knobs | `endpointing` is already 10 ms by default; `utterance_end_ms` ≥ 1000 is a fallback, not a speed-up; `interim_results` already on | none | the 378 ms `resume` residue is the vendor's finalisation and stays |

So on a CPU-only self-hosted deployment the current mechanism — VAD cut, SDK pause, `resume`
on a lexicon match within ~380 ms — **is** the best available, and the architecture should say
so plainly rather than apologise for it. Three things sharpen it without a new model:

1. **Explain D5.2.** A 700 ms `minDuration` cut the agent as often as 500 ms did, on N=2 per arm,
   although a backchannel is ~300–400 ms of speech. Either the VAD's speech span is longer than
   the word (the 550 ms `minSilenceDuration` extends it) or the interruption check keys on
   something other than speech duration. Log the VAD speech duration and the transcript at every
   interruption; one tier-3 run answers it, and it may move `minDuration` for a reason.
2. **Shadow Smart Turn v3** as above — the one open component that adds information the current
   detector lacks, at sidecar cost, without touching the decision until measured.
3. **Take the SDK fixes** — the stale-`listening` fix in particular bears on the silence clock's
   arming and on call03's late first strike — as a baseline step, not a drive-by.

The GPU tier (Easy Turn / SoulX-Duplug as a state-prediction sidecar feeding `wait`/`resume`) is
recorded as the path if a deployment has a GPU host; it is the DuplexCascade decision set without
the DuplexCascade LLM loop, which is what §2.3 argued for.

### 4.7 Not adopted, and why (so it is not re-proposed on the same evidence)

- **Micro-turn LLM invocation** at any Δt: TTFT ≥ Δt behind the API, ~10× request volume,
  untrained control behaviour, an unaudited decision per turn (§2.4).
- **Fine-tuning the decider** for control tokens: the decider is `gpt-4.1`; a fine-tuned
  `gpt-4.1-mini` would be a different model on the two states that carry the promise, and the
  paper's 3.9-point VoiceBench drop is the kind of regression the judge would have to catch.
- **VAD-free operation**: the EOU is already semantic; the VAD is the barge-in authority only
  because adaptive is unavailable (§4.6), which is a config fact not a design gap.
- **Full-Duplex-Bench as our benchmark**: its TOR metrics are for open S2S models on synthetic
  and Candor audio; τ-Voice's definitions (already adopted) measure a task-bearing agent. Borrow
  the *pause handling* scenario (§4.3), not the scoreboard.

---

## 5. Suggested order, given where the tree is

1. **1b as the segment-id contract** (§3.1) rather than a third ordering patch — this closes both
   gate shapes and folds handoff items 1b + 2c + 2e (`held: boolean`) into one change. Then the
   owed second clean N=5 for Phase 2.
2. **§4.2** (record `eot_prediction`) and **§3.2** (`disposition`/`decider`/`segment_id` on the
   wire) — instruments, no behaviour change, one commit each.
3. **§4.3** `mid-utterance-pause` tripwire, before any endpointing knob is touched.
4. **D2 fast path** (§3.5) — the SLO lever; unchanged from the spec.
5. **§4.1** state-conditioned silence windows — after a `grilling` round, because it is live-call
   behaviour.
6. `livekit-server` v1.13.6 with the next rebuild; the `@livekit/agents` 1.8.0 upgrade as its own
   N=5-twice step once §3.1 has removed the item-stamp seam; Smart Turn v3 in shadow mode and the
   D5.2 diagnostic alongside §4.2; the one Cloud A/B (§4.6) when the tier-3 set is green on the
   clean persona, so both arms are measured on the same scenarios.
7. §4.4 behind the simulator only (decided); §3.3/§3.4 hygiene alongside D7 (ADR 0011 should now
   record the six-way vocabulary and which two states this system deliberately does not act on).

---

## 6. Decisions that are the user's

1. **LiveKit Cloud** — decided 2026-09-05: **self-hosted primary, Cloud measured once.** Not a
   permanent exclusion (a free-tier project suffices for five calls). One N=5 A/B with adaptive
   interruption on the two backchannel/read-back scenarios; the number is recorded in ADR 0011 as
   what Cloud buys and what self-hosting costs. Alongside: the SDK upgrade to 1.8.0 as a measured
   step after §3.1; the server bump to v1.13.6; Smart Turn v3 in shadow mode; the D5.2 diagnostic.
2. **Agent backchannels in a collections call** — permitted to prototype behind the simulator, or
   ruled a compliance surface and closed like emotion-adaptive tone.
3. **Attribution by `segment_id` in the contract** — a contract change touching `turnFrames`,
   `AGENT_TURN_PLAYOUT`, the guard and the worker, versus the smaller `TurnRecord` collapse the
   handoff planned. The larger change is the one that makes the race unrepresentable.
4. **Silence windows by state** — the shape of the table (which states, which windows) before it
   is built, since the constants become live-call behaviour.
5. **Whether the escape-hatch trigger (§4.5) gets its counters now**, so the "is the lexicon
   enough" question is answered by a number when it is asked.

### Decisions taken 2026-09-05 (rounds 1–2, all as recommended)

Paper mechanism rejected, six-way vocabulary and simulation priors adopted, to be recorded in ADR
0011. Agent backchannels only behind the simulator with the judge seeing the marked transcript.
Attribution by `segment_id` in the contract, folding handoff items 1b, 2c, 2e. Silence windows keyed
on the last agent act, constants in `waitPolicy.ts`, built after a `post-question-pause` scenario
exists. Escape-hatch counters now. `@livekit/agents` 1.8.0 as its own N=5-twice step after the
contract change. Smart Turn v3 in shadow mode. GPU tier (Easy Turn / SoulX-Duplug) documented with
its entry cost, not built. `livekit-server` v1.13.6 with the next rebuild. D5.2 diagnostic logged.
Self-hosted primary, LiveKit Cloud measured once.
