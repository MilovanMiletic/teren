/**
 * Local development. Swapped in for `environment.ts` by `angular.json` → `fileReplacements`
 * whenever the `development` build configuration is used, which is what `ng serve` defaults to.
 *
 * The API runs on its own port here (`dotnet run --project src/Teren.Api`), so unlike staging
 * this origin really is different from the API's and the request is a cross-origin one — the
 * API's `Cors:Origins` already lists `http://localhost:4200` for exactly this reason.
 */
export const environment = {
  production: false,

  apiBaseUrl: 'http://localhost:5080',

  /**
   * The token from `src/Teren.Api/appsettings.Development.json` (`Auth:DeviceToken`). Documented
   * there as a throwaway that "guards nothing but a laptop"; it is committed on both sides so
   * the stack works out of the box after `docker compose up -d`.
   */
  deviceToken: 'teren-dev-device-token-not-a-secret',
};
