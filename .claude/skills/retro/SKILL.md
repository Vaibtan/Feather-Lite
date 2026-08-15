---
name: retro
description: Engineering retrospective over a time window — metrics, work patterns, per-person praise and growth, saved snapshot for trends.
disable-model-invocation: true
---

# Retro

A retrospective on real shipped work, for a senior builder using AI as a force
multiplier. Team-aware: `git config user.name` is "you"; every other author is a
teammate who gets their own section. All narrative goes to the conversation; the
only file written is the snapshot (and optional learnings).

Arguments: default window 7d; accept `24h`, `14d`, `30d`, `4w`; `compare
[window]` = current window vs the prior same-length window.

## Guards (before any analysis)

- **Window math:** for day/week units anchor at local midnight —
  `--since="YYYY-MM-DDT00:00:00"` computed from an absolute date. Take "today"
  from the conversation's current-date context, NEVER from the `date` command
  (container clocks lie).
- **Stale-base guard:** fetch origin; compare the newest commit on the default
  branch against the window. If the newest commit predates the window entirely,
  STOP and say so — otherwise the retro will fabricate a coherent-looking
  narrative from nothing. No origin remote or detached HEAD → note it and analyze
  what exists.
- Zero commits in window → say so, suggest a different window, stop.

## Gather (parallel git calls)

Log with author/timestamp/shortstat; per-commit numstat split into test files
(`test/|spec/|__tests__/`) vs production; commit timestamps; file-change
frequency; PR numbers; per-author shortlog and hotspots.

## Compute

**Summary table** — order encodes the philosophy: features shipped leads (what
users got, from CHANGELOG/merged PR titles), then commits, then logical SLOC;
raw LOC is demoted to context because AI inflates it — ten lines of a good fix is
not less shipping than ten thousand lines of scaffold. Include test-LOC ratio,
active days, version range, AI-assisted commit count (from `Co-Authored-By`
trailers — AI co-authors are a metric, never a teammate).

**Sessions:** split on 45-minute gaps between commits. Deep = 50+ min, medium =
20-50, micro = <20 (single-commit fire-and-forget). Report total active time,
average session, LOC per active hour.

**Commit-type mix** by conventional prefix; flag fix ratio >50% as "ship fast,
fix fast" — may indicate review gaps. **Hotspots:** top 10 files; 5+ changes =
churn hotspot; note fix-chains (consecutive fix commits on one subsystem).
**Focus score:** % of commits in the single most-touched top-level directory —
higher = deeper focus, lower = scattered context-switching. **Ship of the week:**
the biggest merged PR, and why it matters. **Streaks:** consecutive days with a
commit to the default branch — team and personal. **Hour histogram:** peak hours,
dead zones, late-night clusters.

## Team sections

For each contributor: commits/LOC, top 3 areas, type mix, test discipline,
biggest ship — then **Praise** (1-2 specifics anchored in actual commits: "every
PR under 200 LOC — disciplined decomposition," never "great work") and **one
growth opportunity** framed as investment advice ("this is worth your time
because…", never "you failed at…"). Tone: encouraging but candid, no coddling.
Praise should feel like something you'd actually say in a 1:1. Never compare
teammates against each other negatively. Solo repo → skip team sections. "You"
gets the deepest treatment: What you did well / Where to level up.

## Trends

Read the most recent snapshot in `.context/retros/` (if any) and show deltas with
↑/↓: test ratio, sessions, LOC/hour, fix ratio, commits, deep sessions. First
run → "first retro recorded — run again next week to see trends." Windows ≥14d
also get week-over-week buckets.

## Save

Write `.context/retros/<date>-<seq>.json`:

```json
{ "date": "…", "window": "7d",
  "metrics": { "commits": 0, "contributors": 0, "prs_merged": 0,
    "insertions": 0, "deletions": 0, "test_ratio": 0.0, "active_days": 0,
    "sessions": 0, "deep_sessions": 0, "avg_session_minutes": 0,
    "feat_pct": 0.0, "fix_pct": 0.0, "peak_hour": 0, "ai_assisted_commits": 0 },
  "authors": { "Name": { "commits": 0, "insertions": 0, "test_ratio": 0.0, "top_area": "" } },
  "streak_days": 0, "tweetable": "one-line stat digest" }
```

Omit any field with no source data — an absent field beats a fabricated zero.

If the session surfaced a genuinely non-obvious insight (the gate: would this save
time in a future session?), append it to `.context/learnings.jsonl` as
`{"type":"pattern|pitfall|preference|architecture|tool|operational",
"key":"…","insight":"…","confidence":1-10,"source":"observed|user-stated|inferred",
"files":[…]}` — honest confidence: verified-in-code 8-9, unsure inference 4-5,
explicit user statement 10.

## Narrative order

Tweetable one-liner first. Then: summary table → trends → time & sessions →
shipping velocity → test health (ratio <20% is a growth area: tests make vibe
coding safe) → focus & highlights → **Your week** → team breakdown → top 3 wins →
3 things to improve → 3 habits for next week (each adoptable in under 5 minutes,
at least one team-oriented). Target 3000-4500 words; every claim anchored in a
commit, a number, or a quote.
