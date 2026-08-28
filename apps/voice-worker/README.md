# Feather-Lite voice worker

LiveKit Agents worker whose `llmNode` **is** the control plane (`POST /api/conversations/:id/turn`).
The model is never called from here; every spoken word arrives as a frame (`delta` = streamed model
text, `say` = deterministic segment) and every runtime fact (barge-in truncation, silence, hangup,
AMD) is reported back as a signal.

```
pnpm --filter @feather-lite/voice-worker dev              # registers with LiveKit Cloud (LIVEKIT_AGENT_NAME)
pnpm --filter @feather-lite/voice-worker start            # the same worker in production mode -- what every measurement uses
pnpm --filter @feather-lite/voice-worker fake-borrower    # automated speaking borrower: full call via /api/voice/sessions
```

**There are no model files to download.** `download-files` used to fetch the text turn-detector
weights; Phase 9 P4 replaced that detector with the audio-native one, whose model is compiled into
the `@livekit/local-inference` napi addon, and `silero_vad.onnx` ships inside its own plugin. If
`~/.cache/huggingface/hub/models--livekit--turn-detector` exists on your box it is 441 MB of the
deprecated model left by an old run and can be deleted.

Env (repo-root `.env`): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME`
(default `feather-lite-agent`), `CONTROL_PLANE_URL` (default `http://127.0.0.1:8080`),
`API_BEARER_TOKEN` (if the API requires it), optional `LIVEKIT_STT_MODEL`, `LIVEKIT_TTS_MODEL`,
`LIVEKIT_TTS_VOICE`, `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` (enables `mode: "sip"` sessions with AMD).

Design notes and the tracer-bullet findings: `docs/plans/2026-08-16-phase-1.5-tracer-findings.md`.
