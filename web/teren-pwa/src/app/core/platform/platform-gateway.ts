import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AdminSessionService } from '../session/admin-session.service';
import {
  CreateAdminRequest,
  CreateAdminResponse,
  CreateCompanyRequest,
  InviteSentResponse,
  PlatformCompanyListResponse,
  PlatformCompanyResponse,
  PlatformUserListResponse,
  PlatformUserResponse,
} from './platform-types';

/** The budget every small JSON call in this app uses. Unsubscribing aborts the fetch. */
const PLATFORM_TIMEOUT_MS = 30_000;

/**
 * Teren's own surface, behind a seam — the twin of `CompanyGateway`, and separate for the same
 * two reasons.
 *
 * **It sends the admin bearer, not the device one.** `TerenApiClient` carries the device token,
 * and a client that chose its bearer per call would eventually choose wrong on the upload path;
 * the symptom would be an evidence row whose provenance says an office tablet recorded it. Two
 * clients, two tokens, no path between them.
 *
 * **And a token rather than a bare service, for specs.** `MockPlatformGateway` stands in for the
 * whole backend so the screens can be exercised — including the paths that matter most, a refused
 * suspend and an address that already has an account — with no server. Same precedent as
 * `COMPANY_GATEWAY`, `AUTH_GATEWAY` and `TEREN_DB`.
 *
 * Errors are left exactly as the platform threw them. What a 401 or a 409 *means* is policy, and
 * policy lives in `PlatformService` next to the screen state it has to produce.
 */
export interface PlatformGateway {
  listCompanies(query?: { q?: string; cursor?: string }): Promise<PlatformCompanyListResponse>;
  createCompany(request: CreateCompanyRequest): Promise<PlatformCompanyResponse>;
  /** Withdraw a customer's access. Every credential of theirs 401s on next contact. */
  suspendCompany(companyId: string): Promise<PlatformCompanyResponse>;
  resumeCompany(companyId: string): Promise<PlatformCompanyResponse>;

  listUsers(query?: {
    companyId?: string;
    role?: string;
    status?: string;
    q?: string;
    cursor?: string;
  }): Promise<PlatformUserListResponse>;
  /** Create a company admin or another member of staff, with his first set-password link. */
  createAdmin(request: CreateAdminRequest): Promise<CreateAdminResponse>;
  /** Mint a fresh link. **Supersedes any live one**, so a link already sent stops working. */
  invite(userId: string): Promise<InviteSentResponse>;
  disableUser(userId: string): Promise<PlatformUserResponse>;
  enableUser(userId: string): Promise<PlatformUserResponse>;
}

export const PLATFORM_GATEWAY = new InjectionToken<PlatformGateway>('PLATFORM_GATEWAY', {
  providedIn: 'root',
  factory: () => inject(HttpPlatformGateway),
});

@Injectable({ providedIn: 'root' })
export class HttpPlatformGateway implements PlatformGateway {
  private readonly http = inject(HttpClient);
  private readonly admins = inject(AdminSessionService);

  /** Never ends in a slash: the paths below start with one, and a double slash is another route. */
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  listCompanies(query: { q?: string; cursor?: string } = {}): Promise<PlatformCompanyListResponse> {
    return this.get<PlatformCompanyListResponse>('/api/platform/companies', query);
  }

  createCompany(request: CreateCompanyRequest): Promise<PlatformCompanyResponse> {
    return this.send<PlatformCompanyResponse>('POST', '/api/platform/companies', request);
  }

  suspendCompany(companyId: string): Promise<PlatformCompanyResponse> {
    return this.send<PlatformCompanyResponse>(
      'POST',
      `/api/platform/companies/${encodeURIComponent(companyId)}/suspend`,
    );
  }

  resumeCompany(companyId: string): Promise<PlatformCompanyResponse> {
    return this.send<PlatformCompanyResponse>(
      'POST',
      `/api/platform/companies/${encodeURIComponent(companyId)}/resume`,
    );
  }

  listUsers(
    query: { companyId?: string; role?: string; status?: string; q?: string; cursor?: string } = {},
  ): Promise<PlatformUserListResponse> {
    // `company_id`, not `companyId`: the query string is part of the wire and follows the same
    // snake_case spelling as every body this API exchanges.
    return this.get<PlatformUserListResponse>('/api/platform/users', {
      company_id: query.companyId,
      role: query.role,
      status: query.status,
      q: query.q,
      cursor: query.cursor,
    });
  }

  createAdmin(request: CreateAdminRequest): Promise<CreateAdminResponse> {
    return this.send<CreateAdminResponse>('POST', '/api/platform/users', request);
  }

  invite(userId: string): Promise<InviteSentResponse> {
    return this.send<InviteSentResponse>(
      'POST',
      `/api/platform/users/${encodeURIComponent(userId)}/invite`,
    );
  }

  disableUser(userId: string): Promise<PlatformUserResponse> {
    return this.send<PlatformUserResponse>(
      'POST',
      `/api/platform/users/${encodeURIComponent(userId)}/disable`,
    );
  }

  enableUser(userId: string): Promise<PlatformUserResponse> {
    return this.send<PlatformUserResponse>(
      'POST',
      `/api/platform/users/${encodeURIComponent(userId)}/enable`,
    );
  }

  private headers(): HttpHeaders {
    // Read fresh on every call, never cached: a sign-out between two requests must not leave a
    // withdrawn bearer on the second.
    return new HttpHeaders({ Authorization: `Bearer ${this.admins.token()}` });
  }

  /**
   * Only parameters that were actually given reach the URL.
   *
   * An empty `q` is not a search for the empty string — it is no search — and sending it would
   * make every idle render of the screen a different request than the one before it.
   */
  private get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
      .join('&');

    return firstValueFrom(
      this.http
        .get<T>(`${this.baseUrl}${path}${query ? `?${query}` : ''}`, { headers: this.headers() })
        .pipe(timeout(PLATFORM_TIMEOUT_MS)),
    );
  }

  private send<T>(method: 'POST', path: string, body?: unknown): Promise<T> {
    return firstValueFrom(
      this.http
        .request<T>(method, `${this.baseUrl}${path}`, {
          body: body ?? {},
          headers: this.headers(),
        })
        .pipe(timeout(PLATFORM_TIMEOUT_MS)),
    );
  }
}
