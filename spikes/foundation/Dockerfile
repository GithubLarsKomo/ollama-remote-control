FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts=false && npm cache clean --force

COPY spikes/foundation/run.mjs ./spikes/foundation/run.mjs

ENV NODE_ENV=production
CMD ["node", "--version"]
