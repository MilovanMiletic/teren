import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import { MeResponse } from '../api/api-types';
import { AdminSessionService } from '../session/admin-session.service';
import {
  ActivationCodeResponse,
  CreateWorkerRequest,
  CreateWorkerResponse,
  DeviceListResponse,
  DeviceResponse,
  ShareTextResponse,
  WorkerListResponse,
} from './company-types';

/**
 * The same budget every other small JSON call in this app uses (`teren-api.client.ts`), for the
 * same reason: a connection that neither answers nor fails leaves a man watching a spinner with
 * his thumb over a button. Unsubscribing aborts the underlying fetch, so this really does release
 * the screen.
 */
const COMPANY_TIMEOUT_MS = 30_000;

/**
 * The company-admin surface, behind a seam.
 *
 * ## Why this is not a method on `TerenApiClient`
 *
 * **`TerenApiClient` sends the device bearer, and these routes need the admin one.** That is not a
 * detail of plumbing; it is the whole reason the two credentials exist separately. A client that
 * chose its bearer per call would eventually choose wrong on the upload path, and the symptom
 * would be an evidence row whose provenance says an office tablet recorded it. Two clients, two
 * tokens, and no code path from one to the other makes that mistake unavailable rather than
 * merely discouraged — the same argument `HttpAuthGateway` already makes for the unauthenticated
 * routes.
 *
 * ## Why a token and not a bare service
 *
 * Specs. `MockCompanyGateway` stands in for the whole backend, so the screen can be exercised —
 * including the paths that matter most, a refused revoke and a code that could not be read — with
 * no server and no `HttpTestingController` ceremony. Same precedent as `AUTH_GATEWAY`,
 * `PROJECT_SOURCE` and `TEREN_DB`.
 *
 * ## Errors are left exactly as the platform threw them
 *
 * What a 401 or a 409 *means* is policy, and policy lives in `CompanyService` next to the screen
 * state it has to produce. This file speaks HTTP and decides nothing.
 */
export interface CompanyGateway {
  /**
   * The signed-in admin himself.
   *
   * `GET /api/me` is not a company route and it is deliberately here anyway, because **the bearer
   * is what the answer depends on**. Called through `TerenApiClient` it describes the phone; called
   * with the admin token it describes the man in the office. Those are two different people, and
   * putting the second call anywhere other than behind this seam would mean a screen for one of
   * them could reach the other's answer.
   */
  me(): Promise<MeResponse>;
  listWorkers(): Promise<WorkerListResponse>;
  addWorker(request: CreateWorkerRequest): Promise<CreateWorkerResponse>;
  /** Read the live code. **A GET, and it must stay one**: reading never kills a code. */
  shareText(workerId: string): Promise<ShareTextResponse>;
  /** Issue a fresh code, superseding whatever he had. The one destructive thing on this screen
   * that is not called revoke. */
  issueCode(workerId: string): Promise<ActivationCodeResponse>;
  listDevices(): Promise<DeviceListResponse>;
  revokeDevice(deviceId: string): Promise<DeviceResponse>;
}

@Injectable({ providedIn: 'root' })
export class HttpCompanyGateway implements CompanyGateway {
  private readonly http = inject(HttpClient);
  private readonly admins = inject(AdminSessionService);

  /** Never ends in a slash: the paths below start with one, and a double slash is another route. */
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  async me(): Promise<MeResponse> {
    return this.get<MeResponse>('/api/me');
  }

  async listWorkers(): Promise<WorkerListResponse> {
    return this.get<WorkerListResponse>('/api/workers');
  }

  async addWorker(request: CreateWorkerRequest): Promise<CreateWorkerResponse> {
    return this.send<CreateWorkerResponse>('POST', '/api/workers', request);
  }

  /**
   * **GET, never POST.** The single most important line in this file.
   *
   * The admin sends a code by Viber and taps back later to look at it. If looking issued a fresh
   * one, it would kill the code the worker is at that moment typing — which is precisely why the
   * server stores the plaintext of a live code (§5) instead of making "see the code" mean
   * "re-issue it". A refactor that merged this with {@link issueCode} would rebuild the trap the
   * database schema was changed to remove.
   */
  async shareText(workerId: string): Promise<ShareTextResponse> {
    return this.get<ShareTextResponse>(
      `/api/workers/${encodeURIComponent(workerId)}/share-text`,
    );
  }

  async issueCode(workerId: string): Promise<ActivationCodeResponse> {
    return this.send<ActivationCodeResponse>(
      'POST',
      `/api/workers/${encodeURIComponent(workerId)}/activation-code`,
      {},
    );
  }

  async listDevices(): Promise<DeviceListResponse> {
    return this.get<DeviceListResponse>('/api/devices');
  }

  async revokeDevice(deviceId: string): Promise<DeviceResponse> {
    return this.send<DeviceResponse>(
      'DELETE',
      `/api/devices/${encodeURIComponent(deviceId)}`,
      null,
    );
  }

  private async get<T>(path: string): Promise<T> {
    return firstValueFrom(
      this.http
        .get<T>(`${this.baseUrl}${path}`, { headers: this.authHeaders() })
        .pipe(timeout(COMPANY_TIMEOUT_MS)),
    );
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<T> {
    return firstValueFrom(
      this.http
        .request<T>(method, `${this.baseUrl}${path}`, { body, headers: this.authHeaders() })
        .pipe(timeout(COMPANY_TIMEOUT_MS)),
    );
  }

  /**
   * The **admin** bearer, read fresh on every call.
   *
   * Fresh rather than snapshotted for the same reason `API_CONFIG` uses a getter: a sign-in that
   * happens while this service is alive has to take effect without anybody re-creating it. An
   * empty token is not defended against here — `CompanyService` asks before it calls, and answers
   * "not signed in" rather than sending `Bearer ` and reading a 401 back.
   */
  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.admins.token()}` });
  }
}

export const COMPANY_GATEWAY = new InjectionToken<CompanyGateway>('COMPANY_GATEWAY', {
  providedIn: 'root',
  factory: () => inject(HttpCompanyGateway),
});
