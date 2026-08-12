ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY release/version.json ./release/version.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/security/package.json ./packages/security/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/ssh/package.json ./packages/ssh/package.json
COPY packages/docker/package.json ./packages/docker/package.json
COPY packages/ollama/package.json ./packages/ollama/package.json

RUN npm ci --ignore-scripts=false

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN npm run build \
    && npm prune --omit=dev --ignore-scripts=false \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ARG ORC_VERSION=0.0.0-dev
ARG ORC_COMMIT_SHA=unknown

LABEL org.opencontainers.image.title="Ollama Remote Control" \
      org.opencontainers.image.version="${ORC_VERSION}" \
      org.opencontainers.image.revision="${ORC_COMMIT_SHA}"

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ORC_DATABASE_PATH=/data/ollama-remote-control.sqlite \
    ORC_WEB_DIST_PATH=/app/apps/web/dist \
    ORC_RELEASE_VERSION=${ORC_VERSION} \
    ORC_COMMIT_SHA=${ORC_COMMIT_SHA}

RUN mkdir -p /data \
    && chown node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/release/version.json ./release/version.json
COPY --from=build --chown=node:node /app/scripts/orc-data-backup.mjs ./scripts/orc-data-backup.mjs

COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/security/package.json ./packages/security/package.json
COPY --from=build --chown=node:node /app/packages/security/dist ./packages/security/dist
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /app/packages/ssh/package.json ./packages/ssh/package.json
COPY --from=build --chown=node:node /app/packages/ssh/dist ./packages/ssh/dist
COPY --from=build --chown=node:node /app/packages/docker/package.json ./packages/docker/package.json
COPY --from=build --chown=node:node /app/packages/docker/dist ./packages/docker/dist
COPY --from=build --chown=node:node /app/packages/ollama/package.json ./packages/ollama/package.json
COPY --from=build --chown=node:node /app/packages/ollama/dist ./packages/ollama/dist

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "apps/api/dist/production.js"]