FROM node:20-alpine

WORKDIR /app

# better-sqlite3 ships prebuilds for most platforms but falls back to node-gyp
# on musl; these are needed for that path and are dropped again below.
RUN apk add --no-cache --virtual .build-deps python3 make g++

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apk del .build-deps

# Copy source
COPY src/ ./src/

# Non-root user for security.
RUN addgroup -S -g 1000 spliitai && adduser -S -u 1000 -G spliitai spliitai

# Create the data directory inside the image and give it to that user.
# Docker copies this ownership onto a fresh named volume; without it the volume
# arrives root-owned and the app cannot open its SQLite database, which is a
# crash at startup rather than a degraded feature.
RUN mkdir -p /app/data && chown -R spliitai:spliitai /app/data
VOLUME /app/data

USER spliitai

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/app.js"]
