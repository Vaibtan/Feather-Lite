# syntax=docker/dockerfile:1
#
# Feather-Lite voice worker (spec 2026-08-27, D6).
#
# Built from the repo root so the pnpm workspace and `patches/` are intact:
#   docker build -f apps/voice-worker/Dockerfile -t feather-lite-worker .
#
# Multi-arch (linux/amd64 + linux/arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 -f apps/voice-worker/Dockerfile -t feather-lite-worker .
#
# **arm64 is promised because it was checked, package by package**, which is the one thing a
# multi-arch claim can get silently wrong — an image that builds and then cannot load its addon:
#
#   @livekit/local-inference  -> @livekit/local-inference-linux-arm64-gnu   (optional dep, published)
#   @livekit/rtc-node         -> @livekit/rtc-ffi-bindings-linux-arm64-gnu  (optional dep, published)
#
# `bookworm-slim`, never Alpine: both are glibc builds, and `-linux-arm64-gnu` says so in its own
# name. On musl the addon simply does not resolve.
#
# `onnxruntime-node` was a third entry here until W11; it came in with
# `@livekit/agents-plugin-silero`, which the native VAD replaced.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- build ----
FROM base AS build

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# Both patches matter here and one of them is this app's whole memory story: the
# `@livekit/agents` patch keeps a 69 MB inference addon out of the main worker process (−740 MB
# under this bundle), and the Deepgram one gives its TTS websocket a connect timeout.
COPY patches ./patches
COPY packages/domain/package.json ./packages/domain/
COPY packages/contracts/package.json ./packages/contracts/
# A dev dependency of the worker, and pnpm needs every workspace package a manifest names to exist
# before it will resolve anything — `--prod` filters what is *installed*, not what is *resolved*.
# It is the resource sampler the fleet harness reports with; nothing in the image imports it.
COPY apps/load-test/package.json ./apps/load-test/
COPY apps/voice-worker/package.json ./apps/voice-worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY packages/domain ./packages/domain
COPY packages/contracts ./packages/contracts
COPY apps/load-test ./apps/load-test
COPY apps/voice-worker ./apps/voice-worker
COPY scripts ./scripts
RUN pnpm --filter @feather-lite/voice-worker build

RUN pnpm deploy --filter @feather-lite/voice-worker --prod --legacy /out

# There used to be a block here that hand-pruned `onnxruntime-node` — 513 MB of prebuilt binaries,
# 336 MB of it a CUDA execution provider this container has no GPU for. It was a transitive
# dependency of `@livekit/agents-plugin-silero` and there was no supported way to ask for less.
#
# W11 deleted the need for it: the VAD is now `inference.VAD`, the same Silero model in the same
# napi addon the end-of-turn detector already lives in, so the plugin and its ONNX runtime are gone
# from the tree entirely. A prune that has nothing to prune is a prune that will one day be wrong
# about something else.

# -------------------------------------------------------------- runtime ----
FROM node:22-bookworm-slim AS runtime

# Deepgram's STT and TTS websockets are TLS, and `slim` has no CA bundle.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app

USER node

# The agents framework's own health server, which production mode starts on 8081. It is also what
# `/` answers: healthy while the worker is registered with the SFU and its inference process is
# alive, 503 otherwise — which is the right liveness signal, because a worker that has lost the SFU
# cannot receive a job and should be replaced.
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `start`, not `dev`. Not because dev disables load shedding — it does not here: `ServerOptions`
# only forces `loadThreshold` to Infinity under `--simulation`, and this worker passes 0.75
# explicitly, which survives (`agents/dist/worker.js:166`). It is because `dev` is `tsx` with debug
# logging and the framework's development defaults, and every number in docs/loadtest was taken on
# `start`. The fleet harness refuses a dev-mode worker for the same reason.
CMD ["node", "dist/agent.js", "start"]
