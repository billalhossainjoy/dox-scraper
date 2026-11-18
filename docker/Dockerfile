# syntax=docker/dockerfile:1.7
# OCI multi-architecture index digest verified against the official Docker registry.
# Includes linux/amd64 and linux/arm64 (Raspberry Pi OS 64-bit).
# Tag is descriptive only; digest pins actual image contents.
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# Build on the TARGET platform, not BUILDPLATFORM. pnpm may install native
# optional packages (e.g. esbuild) and must not copy x86 binaries into ARM64.
FROM ${NODE_IMAGE} AS build

ENV CI=true
WORKDIR /app
RUN npm install --global pnpm@12.18.0

# A committed workspace pnpm-lock.yaml pins the dependency graph.
# Frozen installs fail rather than silently updating transitive versions.
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Provide an owned directory before Docker initializes the named volume.
RUN mkdir -p /data && chown node:node /data

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=node:node /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts/sqlite-backup.mjs ./scripts/sqlite-backup.mjs
COPY --from=build --chown=node:node /app/scripts/sqlite-restore-drill.mjs ./scripts/sqlite-restore-drill.mjs

USER node

FROM runtime AS api
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DOX_CRAWL_DB_PATH=/data/dox.sqlite
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS worker
ENV DOX_CRAWL_DB_PATH=/data/dox.sqlite
ENV DOX_WORKER_INTERVAL_SECONDS=60
ENV DOX_WORKER_HEARTBEAT=/tmp/dox-worker.heartbeat
CMD ["node", "apps/worker/dist/index.js"]
