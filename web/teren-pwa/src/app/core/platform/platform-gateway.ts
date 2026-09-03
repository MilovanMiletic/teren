import { HttpClient, HttpHeaders, HttpResponse } from '@angular/common/http';
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
  PlatformHealthResponse,
  PlatformLogExport,
  PlatformLogListResponse,
  PlatformLogQuery,
  PlatformUserListResponse,
  PlatformUserResponse,
} from './platform-types';

/** The budget every small JSON call in this app uses. Unsubscribing aborts the fetch. */
const PLATFORM_TIMEOUT_MS = 30_000;

/**
 * The export's own budget, and it is longer for a reason rather than for symmetry.
 *
 * The server streams up to fifty thousand rows of stack traces. That is a real transfer over a
 * real connection, and killing it at thirty seconds would abandon a file that was arriving.
 */
const EXPORT_TIMEOUT_MS = 120_000;

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

  /**
   * What the pipeline is doing across every customer (F7's health screen).
   *
   * **No parameters, and no paging.** Everything on the response is an aggregate, so the reason
   * every other list on this surface is keyset-paged — a founder scrolling while a customer signs
   * up must not see a row twice — has nothing to bite on. The site list is capped at 500 by the
   * server and says how many it left out.
   */
  getHealth(): Promise<PlatformHealthResponse>;

  /**
   * One keyset page of the server's log (D5).
   *
   * **Filtered on the server, unlike every other list on this surface.** The other tables hold
   * tens of rows fetched whole and filter what is in hand (`ui/table-controls.ts` says why that is
   * the right answer there); this is a firehose the client holds one page of, so a filter that ran
   * on the page would narrow the wrong set and quietly lie about what exists.
   */
  listLogs(query?: PlatformLogQuery): Promise<PlatformLogListResponse>;

  /**
   * The same query, as a CSV file.
   *
   * Same parameters as {@link listLogs} by contract, so what he downloads is what he is looking
   * at. Fetched as a blob with the admin bearer rather than opened as a link: a plain `<a href>`
   * cannot carry an `Authorization` header, which is the same reason `downloadReport` exists.
   */
  exportLogs(query?: PlatformLogQuery): Promise<PlatformLogExport>;
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

  getHealth(): Promise<PlatformHealthResponse> {
    return this.get<PlatformHealthResponse>('/api/platform/health');
  }

  listLogs(query: PlatformLogQuery = {}): Promise<PlatformLogListResponse> {
    return this.get<PlatformLogListResponse>('/api/platform/logs', logParams(query));
  }

  /**
   * The export, as bytes.
   *
   * `observe: 'response'` because the filename is on `Content-Disposition` and the body alone
   * would lose it. Note that with `responseType: 'blob'` an error body arrives as a `Blob`, so the
   * server's problem document cannot be read as JSON downstream — which costs nothing: the status
   * carries every distinction this screen makes, and branching on an English detail string is
   * forbidden in this codebase anyway.
   */
  async exportLogs(query: PlatformLogQuery = {}): Promise<PlatformLogExport> {
    const response = await firstValueFrom(
      this.http
        .get(`${this.baseUrl}/api/platform/logs/export${queryString(logParams(query))}`, {
          headers: this.headers(),
          responseType: 'blob' as const,
          observe: 'response' as const,
        })
        .pipe(timeout(EXPORT_TIMEOUT_MS)),
    );

    return {
      body: (response as HttpResponse<Blob>).body,
      contentDisposition: response.headers.get('Content-Disposition'),
    };
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
    return firstValueFrom(
      this.http
        .get<T>(`${this.baseUrl}${path}${queryString(params)}`, { headers: this.headers() })
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

/**
 * A query string, or nothing at all.
 *
 * Only parameters that were actually given reach the URL. An empty `q` is not a search for the
 * empty string — it is no search — and sending it would make every idle render of a screen a
 * different request than the one before it, which on the log stream would mean a fresh keyset page
 * on every keystroke that changed nothing.
 */
function queryString(params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
    .join('&');
  return query ? `?${query}` : '';
}

/**
 * The log query as wire parameters — `snake_case`, exactly as every body this API exchanges.
 *
 * `level` is sent comma-separated rather than repeated. The contract accepts either, and one
 * parameter keeps this function's return type a flat map, which is what {@link queryString} and
 * the mock both work with. **The list is the same one the export is given**, which is the whole
 * point: what he downloads is what he is looking at.
 */
function logParams(query: PlatformLogQuery): Record<string, string | undefined> {
  return {
    level: query.levels && query.levels.length > 0 ? query.levels.join(',') : undefined,
    source: query.source,
    q: query.q,
    company_id: query.companyId,
    entry_id: query.entryId,
    from: query.from,
    to: query.to,
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : String(query.limit),
  };
}
