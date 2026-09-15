#!/bin/sh
set -e

# Start as root, fix ownership of the data directory, then drop privileges.
#
# Why: the image cannot know what uid owns the host directory you bind-mount at
# /app/data. On Unraid that is usually nobody:users (99:100); elsewhere it is
# often your own user. Baking a fixed uid into the image means the container
# only starts if the host directory happens to match it — and it silently stops
# starting if that uid ever changes between image versions.
#
# PUID/PGID follow the convention Unraid users already know from linuxserver.io
# images. Defaults are Unraid's nobody:users.

PUID=${PUID:-99}
PGID=${PGID:-100}
DATA_DIR=${DATA_DIR:-/app/data}

if [ "$(id -u)" = "0" ]; then
  # Reuse a group/user with these ids if one exists, otherwise create them.
  if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" spliitai 2>/dev/null || true
  fi
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    adduser -u "$PUID" -G "$(getent group "$PGID" | cut -d: -f1)" -D -H spliitai 2>/dev/null || true
  fi

  RUN_USER=$(getent passwd "$PUID" | cut -d: -f1)
  RUN_USER=${RUN_USER:-spliitai}

  mkdir -p "$DATA_DIR"

  # Only chown when it is actually wrong; on a large data directory a
  # recursive chown on every boot is wasted work.
  CURRENT=$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || echo "")
  if [ "$CURRENT" != "$PUID:$PGID" ]; then
    echo "[Entrypoint] Setting ownership of $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || \
      echo "[Entrypoint] WARNING: could not chown $DATA_DIR. If the app fails to" \
           "start, run: chown -R $PUID:$PGID /path/to/your/data"
  fi

  echo "[Entrypoint] Starting as $RUN_USER ($PUID:$PGID)"
  exec su-exec "$PUID:$PGID" "$@"
fi

# Already running unprivileged (e.g. `docker run --user`); nothing to do.
exec "$@"
