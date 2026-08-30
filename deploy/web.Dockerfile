# Teren PWA + reverse proxy — production image.
#
# Build from the repository root, not from deploy/:
#   docker build -f deploy/web.Dockerfile -t teren-web:local .
#
# One container serves the built PWA *and* proxies /api to the API, because that is what makes
# `apiBaseUrl: ''` (same origin) in src/environments/environment.ts true: one hostname, one
# certificate, no CORS preflight, and no second address for the phone to know about.
#
# The Caddyfile is NOT baked in — it is bind-mounted by docker-compose.prod.yml. Cache headers
# and the SPA fallback are the part of this stack most likely to need a change without a
# rebuild, and a config you can edit on the box is worth more than a config you must re-ship.

# ---------------------------------------------------------------------------- build
FROM node:24-alpine AS build
WORKDIR /src

# npm ci against the committed lockfile: the same tree the founder's machine resolved, not
# whatever the registry considers current today.
COPY web/teren-pwa/package.json web/teren-pwa/package-lock.json ./
RUN npm ci

COPY web/teren-pwa/ ./

# The M0 static device token is compiled into the bundle (ARCHITECTURE §12), so a staging box
# that wants a token other than the committed throwaway has to substitute it at *build* time.
# This is the seam for that, and it is fail-loud: if the placeholder is not found — because the
# committed default changed — the build stops rather than silently shipping a bundle whose token
# does not match the server's Auth__DeviceToken. That mismatch would present as every upload
# returning 401 with the app insisting it is configured.
#
# Leave it empty and the committed default is used, which is the correct choice for a demo box
# holding no real data.
ARG TEREN_DEVICE_TOKEN=""
RUN if [ -n "$TEREN_DEVICE_TOKEN" ]; then \
      grep -q "teren-dev-device-token-not-a-secret" src/environments/environment.ts \
        || { echo "FATAL: device-token placeholder not found in src/environments/environment.ts" >&2; exit 1; }; \
      sed -i "s|teren-dev-device-token-not-a-secret|${TEREN_DEVICE_TOKEN}|g" src/environments/environment.ts; \
      echo "Device token substituted at build time."; \
    else \
      echo "Using the committed default device token."; \
    fi

# `ng build` defaults to the production configuration (angular.json), which is what turns on
# outputHashing and the service worker.
RUN npx ng build --configuration production

# ------------------------------------------------------------------------- runtime
FROM caddy:2-alpine AS runtime

# @angular/build:application writes the browser bundle to dist/<project>/browser.
COPY --from=build /src/dist/teren-pwa/browser /srv/teren

# Fail early and visibly rather than serving an empty site: the service worker manifest is the
# one file whose absence turns an installed PWA into a permanently stale shell.
RUN test -f /srv/teren/index.html && test -f /srv/teren/ngsw.json && test -f /srv/teren/ngsw-worker.js
