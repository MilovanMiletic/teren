import { HttpClient } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  ActivateRequest,
  ActivateResponse,
  LoginRequest,
  LoginResponse,
  RequestActivationCodeRequest,
  SetPasswordRequest,
  SetPasswordResponse,
} from './auth-types';

/**
 * How long an auth call may hang before it is abandoned.
 *
 * The same budget as every other small JSON call (`teren-api.client.ts`), and for the same
 * reason: a connection that neither answers nor fails leaves a man watching a spinner with his
 * thumb over a button. Unsubscribing aborts the underlying fetch, so the timeout really does
 * release the screen.
 */
const AUTH_TIMEOUT_MS = 30_000;

/**
 * The three unauthenticated routes, behind a seam.
 *
 * ## Why a token and not a service
 *
 * The same reason `PROJECT_SOURCE`, `INSTALL_PROMPT_SOURCE` and `TEREN_DB` are tokens: the screens
 * shipped before the endpoints did. D2 and D3 were being built in parallel and unmerged when F3
 * was written, so without a seam this increment could not have been written, let alone reviewed,
 * without a server that answers `/auth/activate`. The routes landed on 2026-08-31 and nothing
 * above this line changed — which is what the seam was for, and it keeps earning its place:
 * {@link MockAuthGateway} still stands in for the whole backend in every spec.
 *
 * ## Why these calls do not go through `TerenApiClient`
 *
 * `TerenApiClient` attaches `Authorization: Bearer …` to everything it sends. These are the only
 * two routes in the product that are reached *without* a credential — that is what they are for —
 * and a phone that has never been activated has no bearer worth sending. Worse, an activation
 * request carrying the build-time demo token would be authenticating as the demo device while
 * asking to become someone else, which is the sort of thing nobody notices until it is a
 * provenance bug on an evidence row. A separate gateway with its own bare `HttpClient` makes that
 * mistake unavailable rather than merely discouraged.
 */
export interface AuthGateway {
  /** Bind this phone to a worker. Rejects with an `HttpErrorResponse`; policy lives upstream. */
  activate(request: ActivateRequest): Promise<ActivateResponse>;

  /** Ask for a fresh single-use code. Always 202 — the answer never says whether the user exists. */
  requestActivationCode(request: RequestActivationCodeRequest): Promise<void>;

  /** Sign an admin in by email and password. */
  login(request: LoginRequest): Promise<LoginResponse>;

  /**
   * Set a password from an invite or reset link. Rejects with an `HttpErrorResponse`; what a 400
   * or a 401 *means* is policy and lives in `ActivationService`.
   */
  setPassword(request: SetPasswordRequest): Promise<SetPasswordResponse>;
}

/**
 * The real one: bare HTTP, no bearer, absolute or same-origin depending on the build.
 *
 * Errors are left exactly as the platform threw them. What a 401 or a 429 *means* is policy, and
 * policy lives in `ActivationService` next to the screen state it has to produce — the same split
 * `TerenApiClient` and `UploadService` already use.
 */
@Injectable({ providedIn: 'root' })
export class HttpAuthGateway implements AuthGateway {
  private readonly http = inject(HttpClient);

  /** Never ends in a slash: `url()` joins with one, and a double slash is a different route. */
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  async activate(request: ActivateRequest): Promise<ActivateResponse> {
    return this.post<ActivateResponse>('/auth/activate', request);
  }

  async requestActivationCode(request: RequestActivationCodeRequest): Promise<void> {
    await this.post<unknown>('/auth/activation-code', request);
  }

  async login(request: LoginRequest): Promise<LoginResponse> {
    return this.post<LoginResponse>('/auth/login', request);
  }

  async setPassword(request: SetPasswordRequest): Promise<SetPasswordResponse> {
    return this.post<SetPasswordResponse>('/auth/password', request);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return firstValueFrom(
      // No headers at all. Not "no Authorization header by convention" — none to forget.
      this.http.post<T>(`${this.baseUrl}${path}`, body).pipe(timeout(AUTH_TIMEOUT_MS)),
    );
  }
}

export const AUTH_GATEWAY = new InjectionToken<AuthGateway>('AUTH_GATEWAY', {
  providedIn: 'root',
  factory: () => inject(HttpAuthGateway),
});
