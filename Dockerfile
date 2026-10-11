FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY data ./data

RUN chown -R node:node /app && chmod 700 /app/data && chmod 600 /app/data/db.json

RUN printf '%s\n' '#!/bin/sh' 'set -eu' 'mkdir -p /app/data' 'chown -R node:node /app/data' 'exec su-exec node:node node /app/server.js' > /entrypoint.sh \
  && chmod 755 /entrypoint.sh

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["/entrypoint.sh"]
