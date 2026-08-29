import { InjectionToken } from '@angular/core';

import { environment } from '../../../environments/environment';

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

  /** Bearer token sent on every `/api` request. Empty means this build has no credentials. */
  readonly deviceToken: string;
}

export const API_CONFIG = new InjectionToken<ApiConfig>('API_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    baseUrl: environment.apiBaseUrl.replace(/\/+$/, ''),
    deviceToken: environment.deviceToken,
  }),
});
