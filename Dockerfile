# ─── DistriCache Node Container ──────────────────────────────────────
#
# Minimal image for a single cache node.
#
# WHY node:20-alpine?
# Alpine-based images are ~5x smaller than Debian-based (node:20) —
# ~180MB vs ~900MB. For a cache node that only runs stdlib code,
# there's no reason to carry the larger image.
#
# WHY npm ci --omit=dev?
# DistriCache has ZERO runtime dependencies (only Jest in devDependencies).
# `--omit=dev` skips Jest entirely, making the image even smaller.
#
# WHY COPY package*.json BEFORE COPY src/?
# Docker caches each layer. By copying package files first and running
# npm ci, the dependency layer is cached and won't be rebuilt when only
# source code changes. This makes rebuilds fast during development.

FROM node:20-alpine

WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install production dependencies only (currently none — Jest is devDep)
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Default port (overridable via environment variable)
EXPOSE 7000

# Start the cache node
CMD ["node", "src/server.js"]
