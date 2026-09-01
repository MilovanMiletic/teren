/**
 * Build-time configuration. **This file is the production/default one**; `ng build` (which
 * defaults to the `production` configuration) uses it, and `ng serve` swaps in
 * `environment.development.ts` through the `fileReplacements` entry in `angular.json`.
 *
 * Two values, both of which have to be settable per environment rather than compiled in as
 * constants:
 *
 * - `apiBaseUrl` — empty means *same origin*, which is what staging (B3a) and production look
 *   like: Caddy serves the PWA and proxies `/api` on one hostname, so the phone never needs to
 *   know a second address and no CORS preflight happens at all. A dev machine runs the API on a
 *   different port, so the development file names it explicitly.
 * - `deviceToken` — ARCHITECTURE §12 stages authentication honestly: **M0 bakes a static device
 *   token into the build**, as a deliberate temporary compromise for the distributor demo, with
 *   no real customer data in that environment. C5 replaces it with a per-device token issued by
 *   a join code. Keeping it here, behind `API_CONFIG`, is what makes C5 a change of *where the
 *   token comes from* rather than a rewrite of every call site: nothing outside
 *   `core/api/api-config.ts` reads this value.
 */
export const environment = {
  production: true,

  /** Empty = same origin. Staging/production serve the API under `/api` on the PWA's own host. */
  apiBaseUrl: '',

  /**
   * **Empty, and it must stay empty.** This is the increment the whole identity model was for: a
   * login screen secures nothing while a working credential is compiled into the bundle, because
   * anyone can read it out of devtools and call the API directly. With no token here,
   * `SessionService.token` has nothing to fall back on, `usable()` is false until a device is
   * activated, and the `canMatch` gate actually redirects.
   *
   * Do not restore a value to "make staging demo out of the box". Activate the box instead —
   * `DemoSeeder` provisions the demo device and prints `zoran.jovanovic` / `DEM0-TEST`.
   * `deploy/web.Dockerfile` no longer has a token to substitute.
   */
  deviceToken: '',
};
