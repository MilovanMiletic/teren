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
   * The M0 static device token. Deliberately the same throwaway string the API ships in
   * `appsettings.Development.json`, so a staging box that has not yet had `Auth__DeviceToken`
   * set still demos. **Set `Auth__DeviceToken` on the server and change this string together**
   * — the two are one shared secret, and neither is a secret worth protecting until C5.
   */
  deviceToken: 'teren-dev-device-token-not-a-secret',
};
