# syntax=docker/dockerfile:1
#
# Frontend image — builds the Vite SPA with Node, serves the static bundle with
# nginx, and proxies /api to the backend so the browser sees a single origin.
# One origin means the bearer token is never sent cross-site and CORS is not
# involved in production.

# --------------------------------------------------------------------------- #
# Stage 1 — build
# --------------------------------------------------------------------------- #
FROM node:22-bookworm-slim AS builder

WORKDIR /src

# Dependencies first so that a source-only change does not re-resolve npm.
COPY package.json package-lock.json ./
RUN npm ci

# Copied by name rather than with `COPY . .`: this image's build context is
# ./frontend, so the repository's root .dockerignore does not apply to it, and
# an unfiltered copy would drag in the host's node_modules and any stale dist/.
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY postcss.config.js tailwind.config.js ./
COPY src/ ./src/

# package.json "build" runs `tsc --noEmit && vite build`, so a type error fails
# the image build rather than shipping a broken bundle.
RUN npm run build


# --------------------------------------------------------------------------- #
# Stage 2 — serve
# --------------------------------------------------------------------------- #
FROM nginx:1.27-alpine AS runtime

# Full replacement config: listens on 8080, proxies /api, sets security
# headers, and keeps every writable path under /tmp so nginx can run unprivileged.
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /src/dist /usr/share/nginx/html

# The image ships an "nginx" user (uid 101). Give it the few paths it writes to
# and drop the default root-owned config directory permissions.
RUN mkdir -p /tmp/nginx-cache \
 && chown -R nginx:nginx /tmp/nginx-cache /usr/share/nginx/html

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
