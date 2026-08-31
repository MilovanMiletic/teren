import { InjectionToken, inject } from '@angular/core';

import { environment } from '../../../environments/environment';
import { SessionService } from '../session/session.service';

/**
 * Everything the app needs to reach its server, in one injectable value.
 *
 * The point of the token is not indirection for its own sake: it is the seam that keeps C5
 * (per-device tokens issued by a join code) from touching any call site. Today the factory reads
 * a build-time constant; tomorrow it reads a token the device was given at binding time, and
 * `TerenApiClient` does not change.
 */
export interface ApiConfig {
  /**
   * Absolute origin of the API, or `''` for the same origin as the app.
   *
   * Never ends in a slash — `url()` joins with one and a double slash would break the presigned
   * path style MinIO uses.
   */
  readonly baseUrl: string;

  /**
   * Bearer token sent on every `/api` request. Empty means this build has no credentials.
   *
   * **Still a plain readonly string, and this is load-bearing.** The default factory satisfies it
   * with a *getter* (below) so the value tracks the live session, but the type stays a value: a
   * dozen specs provide `API_CONFIG` as an object literal, and `TerenApiClient` reads it on every
   * call. Promoting this to a service would churn every one of those for no gain, and the only
   * thing that would force it — asynchronous token acquisition — does not exist by design.
   */
  readonly deviceToken: string;
}

/**
 * The default configuration: the API's address from the build, the bearer from the live session.
 *
 * `deviceToken` is a **getter**, so `TerenApiClient.configured` and `authHeaders()` — which both
 * already read it fresh on every call — see a new credential the instant an activation writes one.
 * Zero call sites change. A snapshot taken here instead would keep sending the token the app
 * booted with, and the phone would go on being rejected after the foreman had just fixed it.
 *
 * **Deliberately not an `HttpInterceptor`**, for three independent and individually fatal reasons:
 *
 * 1. `putObject()` must never carry an `Authorization` header. A presigned request carries its
 *    signature in the query string, and S3 rejects one that also has an auth header.
 * 2. `baseUrl` is `''` in production (same origin), so an interceptor matching on a URL prefix
 *    would match *every* request, object storage included — see reason 1.
 * 3. The seam already exists and costs one getter.
 */
export const API_CONFIG = new InjectionToken<ApiConfig>('API_CONFIG', {
  providedIn: 'root',
  factory: () => {
    const session = inject(SessionService);
    return {
      baseUrl: environment.apiBaseUrl.replace(/\/+$/, ''),
      get deviceToken(): string {
        return session.token();
      },
    };
  },
});
