FROM node:20-alpine

WORKDIR /app

# better-sqlite3 has no musl prebuild, so it compiles from source here. The
# toolchain is removed again in the same layer to keep the image small.
RUN apk add --no-cache --virtual .build-deps python3 make g++

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && apk del .build-deps

# Copy source
COPY src/ ./src/

# The image already ships a non-root `node` user at uid/gid 1000, so reuse it
# rather than creating a second user at the same ids (which fails the build).
#
# Create the data directory and hand it to that user. Docker copies this
# ownership onto a fresh named volume; without it the volume arrives root-owned
# and the app cannot open its SQLite database, which is a crash loop at startup
# rather than a degraded feature. Bind mounts are *not* copied, so a host
# directory must be chowned to 1000:1000 — see UNRAID_SETUP.md.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/app.js"]
