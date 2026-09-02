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
   * **Empty since the token flip (2026-08-31), and read by nothing since 2026-09-02.** Until then
   * this carried the throwaway from `appsettings.Development.json`, and `SessionService.token` fell
   * back to it — which meant `usable()` was always true, the `canMatch` gate never redirected
   * anyone, and the app opened on Home no matter what. Emptying it is the change that turned the
   * login screens from something you can navigate to into something you have to pass; deleting the
   * fallback is what makes putting a value back here inert as well as red.
   *
   * A laptop now activates the same way a phone does: `zoran.jovanovic` / `DEM0-TEST` against a
   * seeded database. The API still accepts `Auth:DeviceToken`, but only because `DemoSeeder`
   * provisions it as a real `device` row — it is the demo phone's credential, not a bypass.
   */
  deviceToken: '',
};
