#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create group with the requested GID
addgroup -g "${PGID}" appgroup 2>/dev/null || true

# Create user with the requested UID in that group
adduser -D -u "${PUID}" -G appgroup appuser 2>/dev/null || true

# Use numeric IDs so chown/su-exec work even when name creation was skipped
# (node:22-alpine already has uid/gid 1000 as 'node', so adduser/addgroup may no-op)
mkdir -p /data
chown "${PUID}:${PGID}" /data

echo "Running as uid=${PUID} gid=${PGID}"
exec su-exec "${PUID}:${PGID}" node /app/server.js
