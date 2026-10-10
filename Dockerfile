FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install -g npm@11.6.2
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/uploads \
  && chown -R node:node /app/uploads

USER node

ENV HOST=0.0.0.0
ENV PORT=3001
ENV UPLOADS_DIR=/app/uploads

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "server.js"]
