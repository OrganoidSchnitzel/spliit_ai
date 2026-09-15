FROM node:20-alpine

WORKDIR /app

# better-sqlite3 has no musl prebuild, so it compiles from source here. The
# toolchain is removed again in the same layer to keep the image small.
# su-exec stays: the entrypoint uses it to drop privileges.
RUN apk add --no-cache su-exec \
    && apk add --no-cache --virtual .build-deps python3 make g++

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apk del .build-deps

# Copy source
COPY src/ ./src/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data

# The container starts as root and the entrypoint immediately drops to
# PUID:PGID (default 99:100, Unraid's nobody:users) after making /app/data
# writable by that user. Pinning a uid in the image instead would mean the
# container only starts when the host directory happens to match it.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/app.js"]
