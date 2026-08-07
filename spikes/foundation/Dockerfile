FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts=false \
    && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY spikes/foundation/run.mjs ./spikes/foundation/run.mjs

ENV NODE_ENV=production
CMD ["node", "--version"]
