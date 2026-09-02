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

# NO DEVICE TOKEN IS BAKED INTO THE BUNDLE, and there is deliberately no seam for one.
#
# Until D7/F9 (2026-08-31) this stage substituted a build-arg into a placeholder in
# src/environments/environment.ts, because the M0 compromise compiled one shared device token into
# the app. That token is gone — `environment.deviceToken` is '' in both environment files, and a
# spec pins it empty — so the substitution had nothing left to find and its fail-loud `grep`
# stopped every `deploy.sh` run on both targets with "FATAL: device-token placeholder not found".
#
# Do not put it back. A working credential compiled into a public bundle is readable from devtools
# by anyone, and while it existed the activation gate could not bite. A phone earns its own
# credential at /auth/activate; `Auth__DeviceToken` survives on the *server* only, as the demo
# device's token that `seed` provisions into the device table (ARCHITECTURE §12).

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
