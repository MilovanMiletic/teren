/**
 * Build-time configuration. **This file is the production/default one**; `ng build` (which
 * defaults to the `production` configuration) uses it, and `ng serve` swaps in
 * `environment.development.ts` through the `fileReplacements` entry in `angular.json`.
 *
 * Two values:
 *
 * - `apiBaseUrl` — empty means *same origin*, which is what staging (B3a) and production look
 *   like: Caddy serves the PWA and proxies `/api` on one hostname, so the phone never needs to
 *   know a second address and no CORS preflight happens at all. A dev machine runs the API on a
 *   different port, so the development file names it explicitly. This one really is per
 *   environment.
 * - `deviceToken` — **a retired seam, empty in both files and read by nothing.** M0 did bake a
 *   static device token into the build, as a temporary compromise for the distributor demo;
 *   D7/F9 emptied it (2026-08-31) and `SessionService.token` stopped falling back to it
 *   (2026-09-02), so the bearer now comes from the session a man activated. The property stays
 *   as the thing a spec pins empty — that spec is the only reason it is still here, and it is a
 *   good one: restoring a value would otherwise be an invisible one-line change.
 */
export const environment = {
  production: true,

  /** Empty = same origin. Staging/production serve the API under `/api` on the PWA's own host. */
  apiBaseUrl: '',

  /**
   * **Empty, and nothing reads it any more.** This is the increment the whole identity model was
   * for: a login screen secures nothing while a working credential is compiled into the bundle,
   * because anyone can read it out of devtools and call the API directly. Emptying it made
   * `usable()` false until a device is activated and the `canMatch` gate actually redirect;
   * deleting the fallback in `SessionService.token` means restoring a value here would no longer
   * even be sent.
   *
   * It stays as the tripwire. `session.service.spec.ts` pins it empty, so an edit that puts a
   * credential back in the bundle — "to make staging demo out of the box" — goes red instead of
   * shipping. Activate the box instead: `DemoSeeder` provisions the demo device and prints
   * `zoran.jovanovic` / `DEM0-TEST`. `deploy/web.Dockerfile` no longer has a token to substitute.
   */
  deviceToken: '',
};
