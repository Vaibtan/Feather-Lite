# Feather-Lite voice worker

LiveKit Agents worker whose `llmNode` **is** the control plane (`POST /api/conversations/:id/turn`).
The model is never called from here; every spoken word arrives as a frame (`delta` = streamed model
text, `say` = deterministic segment) and every runtime fact (barge-in truncation, silence, hangup,
AMD) is reported back as a signal.

```
pnpm --filter @feather-lite/voice-worker download-files   # silero + turn-detector models (once)
pnpm --filter @feather-lite/voice-worker dev              # registers with LiveKit Cloud (LIVEKIT_AGENT_NAME)
pnpm --filter @feather-lite/voice-worker fake-borrower    # automated speaking borrower: full call via /api/voice/sessions
```

Env (repo-root `.env`): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME`
(default `feather-lite-agent`), `CONTROL_PLANE_URL` (default `http://127.0.0.1:8080`),
`API_BEARER_TOKEN` (if the API requires it), optional `LIVEKIT_STT_MODEL`, `LIVEKIT_TTS_MODEL`,
`LIVEKIT_TTS_VOICE`, `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` (enables `mode: "sip"` sessions with AMD).

Design notes and the tracer-bullet findings: `docs/plans/2026-08-16-phase-1.5-tracer-findings.md`.
