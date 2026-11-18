# syntax=docker/dockerfile:1.7
# The official Node.js 24 image provides linux/arm64 and linux/amd64.
# Build TypeScript on the build host's architecture; compiled JS is portable.
ARG NODE_TAG=24-bookworm-slim
FROM --platform=$BUILDPLATFORM node:${NODE_TAG} AS build

ENV CI=true
WORKDIR /app
RUN npm install --global pnpm@12.18.0

# A committed workspace pnpm-lock.yaml pins the dependency graph.
# Frozen installs fail rather than silently updating transitive versions.
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm install --prod --frozen-lockfile

FROM node:${NODE_TAG} AS runtime
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
