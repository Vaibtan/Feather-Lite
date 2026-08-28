# syntax=docker/dockerfile:1
#
# Feather-Lite control plane (spec 2026-08-27, D6).
#
# Built from the repo root so the pnpm workspace is intact:
#   docker build -f apps/server/Dockerfile -t feather-lite-server .
#
# Multi-arch (linux/amd64 + linux/arm64) — the server has no native dependency that would stop it:
#   docker buildx build --platform linux/amd64,linux/arm64 -f apps/server/Dockerfile -t feather-lite-server .
#
# `bookworm-slim`, never Alpine. `pg`, the Langfuse SDK's OTel stack and anything else that pulls a
# prebuilt binary want glibc, and musl either fails to resolve a binary or silently falls back to a
# slower path. The size difference is not worth finding out which.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# `corepack enable` pins pnpm from the root package.json's `packageManager`, so the image cannot
# build with a different pnpm from the one the lockfile was written by.
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- build ----
FROM base AS build

# The workspace's shape first, so a source edit does not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches ./patches
COPY packages/domain/package.json ./packages/domain/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/control-plane/package.json ./packages/control-plane/
COPY apps/server/package.json ./apps/server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Then the sources. `--frozen-lockfile` above is what makes the image reproducible; this layer is
# the one that changes on every commit.
COPY packages ./packages
COPY apps/server ./apps/server
COPY scripts ./scripts
RUN pnpm --filter @feather-lite/server build

# `pnpm deploy --prod` resolves the app's production dependencies into a self-contained tree with no
# symlinks out of it — which is exactly the list the bundler's own check enforces, because inlining
# the workspace packages makes their dependencies the app's.
# `allowUnusedPatches`: this image's dependency graph is the server's, which does not include the
# two `@livekit/*` packages the workspace patches for the voice worker. pnpm treats a declared patch
# with no matching package as an error, and it is right to in general — here it is the expected
# consequence of deploying one app out of a workspace.
RUN pnpm --config.allowUnusedPatches=true deploy --filter @feather-lite/server --prod --legacy /out

# -------------------------------------------------------------- runtime ----
FROM node:22-bookworm-slim AS runtime

# Explicit, not assumed: `slim` ships without a CA bundle, and every outbound call this process
# makes — OpenAI, Langfuse, LiveKit's server API — is TLS. Without it they fail at handshake with a
# message about self-signed certificates that sends people looking in the wrong place.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app

# The image ships the built bundle and its production dependencies; `src/` comes along because
# `pnpm deploy` copies the package, and it is a few hundred kilobytes of TypeScript that nothing
# reads at runtime.
USER node
EXPOSE 8080

# `/healthz` is liveness — the process is up. **Not `/readyz`**, which additionally requires every
# background loop to have ticked recently: a container whose outbox has stopped should be reported
# unready to a load balancer, not killed and restarted into the same state.
# `node -e` rather than curl: `slim` has no curl and adding one to run a health check is 10 MB.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
