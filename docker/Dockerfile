# syntax=docker/dockerfile:1.7
# OCI multi-architecture index digest verified against the official Docker registry.
# Debian 13 (trixie) is assessed against the previous Debian 12 (bookworm) base.
# Includes linux/amd64 and linux/arm64 (Raspberry Pi OS 64-bit).
# Tag is descriptive only; digest pins actual image contents.
ARG NODE_IMAGE=docker.io/library/node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
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

# Debian 13 security fix for CVE-2026-85091 identified by Trivy:
# install only the precisely pinned zlib1g version, not a blanket
# apt upgrade. This remains dependent on Debian apt repository availability.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
    && rm -rf /var/lib/apt/lists/*

# Provide an owned directory before Docker initializes the named volume.
# npm is needed only in the build stage (to install pnpm).
# Remove the globally bundled npm dependency tree from the final API/worker
# runtime images; the application uses node directly and needs no npm CLI.
# This also eliminates CVEs confined to npm's bundled undici/brace-expansion.
RUN rm -rf /usr/local/lib/node_modules/npm \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
    && mkdir -p /data && chown node:node /data

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
