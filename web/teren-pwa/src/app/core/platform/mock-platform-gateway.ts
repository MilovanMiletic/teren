import { HttpErrorResponse } from '@angular/common/http';

import { ACTIONS } from '../telemetry/actions';
import { PlatformGateway } from './platform-gateway';
import {
  CreateAdminRequest,
  CreateAdminResponse,
  CreateCompanyRequest,
  InviteSentResponse,
  PlatformCompanyListResponse,
  PlatformCompanyResponse,
  PlatformLogExport,
  PlatformLogListResponse,
  PlatformLogQuery,
  PlatformLogResponse,
  PlatformUserListResponse,
  PlatformUserResponse,
} from './platform-types';

/**
 * A standing-in platform backend: two customers and the people in them.
 *
 * ## Why it exists
 *
 * The same reason `MockCompanyGateway` does — a developer can click through `/platform` with no
 * server, and a spec can exercise the paths that matter without `HttpTestingController` ceremony.
 * It models **the endpoints that shipped**, not the plan: every shape here was written against
 * `PlatformContracts.cs`, which is the discipline this feature learned the expensive way when §8
 * and `/auth/activate` disagreed and a foreman paid for it.
 *
 * ## It is not wired into the app
 *
 * `PLATFORM_GATEWAY`'s factory returns {@link HttpPlatformGateway}, always. Nothing provides this
 * class in `app.config.ts`, so it is not in the production bundle. That is deliberate: a mock the
 * app could fall back to on its own is a mock that will one day answer a real founder.
 *
 * ## What it enforces
 *
 * The rules the server enforces, because a mock that is more permissive than the server is a mock
 * that certifies a screen which cannot work: a duplicate email is a 409, a `company_admin` with no
 * company and a `super_admin` with one are both 400, and a worker cannot be created at all.
 */
export class MockPlatformGateway implements PlatformGateway {
  // The ids the fixture ships with, named so a spec never spells a UUID out twice and a change
  // here reaches every spec that acts on one of these rows — the same reason `MockCompanyGateway`
  // publishes its own.
  static readonly VODOINSTAL_ID = '33333333-3333-3333-3333-333333333333';
  static readonly ELEKTRO_ID = '44444444-4444-4444-4444-444444444444';
  static readonly FOUNDER_ID = '11111111-1111-1111-1111-111111111111';
  static readonly PETAR_ID = '22222222-2222-2222-2222-222222222222';
  static readonly ZORAN_ID = '55555555-5555-5555-5555-555555555555';

  private companies: PlatformCompanyResponse[] = [
    {
      id: MockPlatformGateway.VODOINSTAL_ID,
      name: 'Vodoinstal Petrović d.o.o.',
      created_at: '2026-08-01T09:00:00.000Z',
      suspended_at: null,
      user_count: 3,
      active_user_count: 3,
    },
    {
      id: MockPlatformGateway.ELEKTRO_ID,
      name: 'Elektro Nikolić d.o.o.',
      created_at: '2026-08-20T14:30:00.000Z',
      suspended_at: '2026-08-28T11:00:00.000Z',
      user_count: 1,
      active_user_count: 0,
    },
  ];

  private users: PlatformUserResponse[] = [
    {
      id: MockPlatformGateway.FOUNDER_ID,
      company_id: null,
      company_name: null,
      role: 'super_admin',
      username: null,
      display_name: 'Milovan Miletić',
      email: 'osnivac@teren.rs',
      language: 'sr',
      created_at: '2026-07-01T08:00:00.000Z',
      last_login_at: '2026-09-01T07:30:00.000Z',
      disabled_at: null,
      password_pending: false,
    },
    {
      id: MockPlatformGateway.PETAR_ID,
      company_id: MockPlatformGateway.VODOINSTAL_ID,
      company_name: 'Vodoinstal Petrović d.o.o.',
      role: 'company_admin',
      username: null,
      display_name: 'Petar Petrović',
      email: 'petar.petrovic@vodoinstal-petrovic.example.com',
      language: 'sr',
      created_at: '2026-08-01T09:05:00.000Z',
      last_login_at: null,
      disabled_at: null,
      // Invited and never finished — the state the founder chases, on screen by default so the
      // filter that finds it is exercised rather than theoretical.
      password_pending: true,
    },
    {
      id: MockPlatformGateway.ZORAN_ID,
      company_id: MockPlatformGateway.VODOINSTAL_ID,
      company_name: 'Vodoinstal Petrović d.o.o.',
      role: 'worker',
      username: 'zoran.jovanovic',
      display_name: 'Zoran Jovanović',
      email: 'zoran.jovanovic@vodoinstal-petrovic.example.com',
      language: 'sr',
      created_at: '2026-08-02T06:15:00.000Z',
      last_login_at: '2026-08-31T05:40:00.000Z',
      disabled_at: null,
      password_pending: true,
    },
  ];

  /**
   * A day of the server's log, newest first — the order the endpoint returns rows in.
   *
   * Deliberately not uniform. There is an error with a stack trace, a warning with properties, an
   * ordinary information line, a row belonging to no company (the platform's own), and two client
   * events with `source` beginning `web.` — because the screen has to be legible when a founder is
   * looking at a foreman's presses and a Hangfire failure in the same list, which is the whole
   * reason the two live in one table.
   */
  private logs: PlatformLogResponse[] = [
    {
      id: '80425',
      at: '2026-09-02T18:14:02.004Z',
      level: 'Information',
      source: 'web.capture',
      // The vocabulary itself, not a copy of it. A slug spelled out here is a slug that can drift
      // from the one the app really sends, and this row exists to look like a real one.
      template: ACTIONS.captureSend,
      message: `Zoran Jovanović pressed ${ACTIONS.captureSend} on /record`,
      properties: { route: '/record', outcome: 'ok', duration_ms: 31200 },
      exception: null,
      company_id: MockPlatformGateway.VODOINSTAL_ID,
      entry_id: '8f0d3a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f',
      correlation: 'c1a1f0e2-0000-4000-8000-000000000001',
    },
    {
      id: '80424',
      at: '2026-09-02T18:13:44.910Z',
      level: 'Information',
      source: 'web.nav',
      template: 'nav.route.enter',
      message: 'Entered /record',
      properties: { route: '/record' },
      exception: null,
      company_id: MockPlatformGateway.VODOINSTAL_ID,
      entry_id: null,
      correlation: 'c1a1f0e2-0000-4000-8000-000000000002',
    },
    {
      id: '80423',
      at: '2026-09-02T18:12:03.221Z',
      level: 'Error',
      source: 'Teren.Infrastructure.Reporting.EntryReporter',
      template: 'Report {ReportId} delivery failed after {Attempts} attempts',
      message: 'Report 3f2a1c delivery failed after 3 attempts',
      properties: { ReportId: '3f2a1c', Attempts: 3 },
      exception:
        'System.Net.Sockets.SocketException: Connection refused\n' +
        '   at Teren.Infrastructure.Mail.SmtpSender.SendAsync(MailMessage message)\n' +
        '   at Teren.Infrastructure.Reporting.EntryReporter.DeliverAsync(Guid reportId)',
      company_id: MockPlatformGateway.VODOINSTAL_ID,
      entry_id: '8f0d3a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f',
      correlation: 'c1a1f0e2-0000-4000-8000-000000000003',
    },
    {
      id: '80422',
      at: '2026-09-02T17:58:10.010Z',
      level: 'Warning',
      source: 'Teren.Api.Pipeline.EntryProcessor',
      template: 'Entry {EntryId} parked in needs_review: {Reason}',
      message: 'Entry 8f0d3a parked in needs_review: extraction_not_configured',
      properties: { EntryId: '8f0d3a', Reason: 'extraction_not_configured' },
      exception: null,
      company_id: MockPlatformGateway.ELEKTRO_ID,
      entry_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      correlation: 'c1a1f0e2-0000-4000-8000-000000000004',
    },
    {
      id: '80421',
      at: '2026-09-02T09:00:00.000Z',
      level: 'Information',
      source: 'Teren.Api.Hosting.Startup',
      template: 'Teren API started on {Urls}',
      message: 'Teren API started on http://localhost:5080',
      properties: { Urls: 'http://localhost:5080' },
      exception: null,
      // No company: this is the platform talking about itself, not about a customer.
      company_id: null,
      entry_id: null,
      correlation: null,
    },
    {
      id: '80420',
      at: '2026-09-01T22:15:00.000Z',
      level: 'Debug',
      source: 'Teren.Api.Jobs.RetentionSweeper',
      template: 'Deleted {Rows} log rows older than {Days} days',
      message: 'Deleted 1284 log rows older than 14 days',
      properties: { Rows: 1284, Days: 14 },
      exception: null,
      company_id: null,
      entry_id: null,
      correlation: null,
    },
  ];

  /**
   * Replace the fixture's day of log with a longer one.
   *
   * The fixture is six legible lines, not a load test, so keyset paging never engages on its own
   * and a ten-row pager has nothing to page. A spec that needs a real stream hands one over here
   * rather than stubbing `listLogs`, which would take the keyset arithmetic — the very thing under
   * test on that screen — out of the picture. **Newest first, ids descending**, exactly as the
   * endpoint returns them; a caller that hands over rows in another order is describing a server
   * that does not exist.
   */
  useLogs(rows: PlatformLogResponse[]): void {
    this.logs = rows;
  }

  async listCompanies(query: { q?: string } = {}): Promise<PlatformCompanyListResponse> {
    const q = (query.q ?? '').trim().toLowerCase();
    return {
      companies: this.companies.filter(
        (company) => q === '' || (company.name ?? '').toLowerCase().includes(q),
      ),
      next_cursor: null,
    };
  }

  async createCompany(request: CreateCompanyRequest): Promise<PlatformCompanyResponse> {
    const company: PlatformCompanyResponse = {
      id: crypto.randomUUID(),
      name: request.name,
      created_at: new Date().toISOString(),
      suspended_at: null,
      // Nothing else is created with a company — no admin, no project. An empty customer is a
      // truthful state, and inventing an account nobody asked for is how a credential ends up
      // somewhere nobody remembers.
      user_count: 0,
      active_user_count: 0,
    };
    this.companies = [company, ...this.companies];
    return company;
  }

  async suspendCompany(companyId: string): Promise<PlatformCompanyResponse> {
    return this.setSuspended(companyId, new Date().toISOString());
  }

  async resumeCompany(companyId: string): Promise<PlatformCompanyResponse> {
    return this.setSuspended(companyId, null);
  }

  async listUsers(
    query: { companyId?: string; role?: string; status?: string; q?: string } = {},
  ): Promise<PlatformUserListResponse> {
    const q = (query.q ?? '').trim().toLowerCase();

    return {
      users: this.users.filter((user) => {
        if (query.companyId && user.company_id !== query.companyId) {
          return false;
        }
        if (query.role && user.role !== query.role) {
          return false;
        }
        if (query.status === 'pending' && user.password_pending !== true) {
          return false;
        }
        if (query.status === 'active' && user.disabled_at !== null) {
          return false;
        }
        if (query.status === 'disabled' && user.disabled_at === null) {
          return false;
        }
        if (q === '') {
          return true;
        }
        return [user.display_name, user.email, user.username].some((field) =>
          (field ?? '').toLowerCase().includes(q),
        );
      }),
      next_cursor: null,
    };
  }

  async createAdmin(request: CreateAdminRequest): Promise<CreateAdminResponse> {
    if (request.role !== 'super_admin' && request.role !== 'company_admin') {
      throw badRequest('role must be super_admin or company_admin.');
    }
    if (request.role === 'company_admin' && !request.company_id) {
      throw badRequest('company_id is required for a company_admin.');
    }
    if (request.role === 'super_admin' && request.company_id) {
      throw badRequest('a super_admin has no company by construction.');
    }
    if (this.users.some((user) => user.email === request.email.toLowerCase())) {
      throw conflict(`${request.email} already has an account.`);
    }

    const company = this.companies.find((c) => c.id === request.company_id) ?? null;
    const user: PlatformUserResponse = {
      id: crypto.randomUUID(),
      company_id: request.company_id ?? null,
      company_name: company?.name ?? null,
      role: request.role,
      username: null,
      display_name: request.display_name,
      email: request.email.toLowerCase(),
      language: request.language ?? 'sr',
      created_at: new Date().toISOString(),
      last_login_at: null,
      disabled_at: null,
      password_pending: true,
    };
    this.users = [user, ...this.users];

    return { user, emailed: true };
  }

  async invite(userId: string): Promise<InviteSentResponse> {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || user.role === 'worker') {
      throw notFound('No account that can hold a password was found.');
    }
    return { email: user.email ?? null, emailed: true };
  }

  /**
   * One keyset page of the log, filtered the way the server filters it.
   *
   * The rules are copied rather than approximated, because a mock that is more permissive than the
   * server certifies a screen that cannot work: `q` searches the message **and the template** and
   * **never the exception** — an operator hunting for a word must not be able to fish in a stack
   * trace — `source` is a contains, `to` is exclusive where `from` is inclusive, and the cursor is
   * keyset over `(at DESC, id DESC)` rather than an offset.
   */
  async listLogs(query: PlatformLogQuery = {}): Promise<PlatformLogListResponse> {
    const matching = this.logs.filter((row) => matchesLogQuery(row, query));
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const start = query.cursor ? matching.findIndex((row) => row.id === query.cursor) + 1 : 0;
    const page = matching.slice(start, start + limit);
    const nextIndex = start + page.length;

    return {
      logs: page,
      // Null on the last page, and only there. A cursor that pointed past the end would make the
      // screen offer a "load more" that answers with nothing.
      next_cursor: nextIndex < matching.length ? (page[page.length - 1].id ?? null) : null,
    };
  }

  /**
   * The same query as a CSV file, with the columns and the BOM the contract names.
   *
   * The BOM is not decoration: without it Excel renders `č`, `ć` and `š` as mojibake, and the
   * founder opens this in Excel.
   *
   * **It refuses a cursor or a limit rather than ignoring one**, exactly as contract §2 says the
   * export does: the whole point of the file is that it is not the page on screen, and a client
   * that sent `limit=50` would be asking for a download of the fifty lines he is already looking
   * at. The server only *appears* to tolerate it today because its parse for those two sits inside
   * the paged branch — a mock that copied the tolerance rather than the contract would certify a
   * client that breaks the day the parse moves.
   */
  async exportLogs(query: PlatformLogQuery = {}): Promise<PlatformLogExport> {
    if (query.cursor !== undefined || query.limit !== undefined) {
      throw badRequest('The export takes the filters only — no cursor and no limit.');
    }

    const rows = this.logs.filter((row) => matchesLogQuery(row, query));
    const header =
      'at,level,source,message,template,company_id,entry_id,correlation,properties,exception';
    const body = rows
      .map((row) =>
        [
          row.at,
          row.level,
          row.source,
          row.message,
          row.template,
          row.company_id,
          row.entry_id,
          row.correlation,
          row.properties ? JSON.stringify(row.properties) : '',
          row.exception,
        ]
          .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
          .join(','),
      )
      .join('\n');

    return {
      body: new Blob([`\uFEFF${header}\n${body}\n`], { type: 'text/csv; charset=utf-8' }),
      contentDisposition: 'attachment; filename="teren-logs-20260902-1812.csv"',
    };
  }

  async disableUser(userId: string): Promise<PlatformUserResponse> {
    return this.setDisabled(userId, new Date().toISOString());
  }

  async enableUser(userId: string): Promise<PlatformUserResponse> {
    return this.setDisabled(userId, null);
  }

  private setSuspended(companyId: string, at: string | null): PlatformCompanyResponse {
    const company = this.companies.find((candidate) => candidate.id === companyId);
    if (!company) {
      throw notFound('That company was not found.');
    }
    // Idempotent, like the server: the column answers "since when", so a second press must not
    // rewrite the answer.
    company.suspended_at = at === null ? null : (company.suspended_at ?? at);
    return company;
  }

  private setDisabled(userId: string, at: string | null): PlatformUserResponse {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw notFound('That account was not found.');
    }
    user.disabled_at = at === null ? null : (user.disabled_at ?? at);
    return user;
  }
}

/**
 * The server's answers, as the platform really throws them.
 *
 * `HttpErrorResponse` and not a bare `Error`: `classifyApiError` reads the status off it, and a
 * mock that threw something else would exercise the `unavailable` branch on every path — so every
 * spec would be testing the wrong sentence.
 */
function problem(status: number, statusText: string, detail: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText, error: { title: statusText, detail } });
}

function badRequest(detail: string): HttpErrorResponse {
  return problem(400, 'Bad Request', detail);
}

function conflict(detail: string): HttpErrorResponse {
  return problem(409, 'Conflict', detail);
}

function notFound(detail: string): HttpErrorResponse {
  return problem(404, 'Not Found', detail);
}

/**
 * The server's own filter rules, restated.
 *
 * A mock that is more permissive than the server certifies a screen that cannot work — the
 * discipline this feature learned when plan §8 and `/auth/activate` disagreed and a foreman paid
 * for it. Three of these clauses are the ones a screen would otherwise get wrong:
 *
 * - `q` covers the message **and the template**, so a founder can search for the shape of a line
 *   (`Report {ReportId} delivery failed`) as well as for one instance of it;
 * - `q` **never** covers the exception. An operator searching for a word must not be able to fish
 *   in a stack trace, and that is a privacy rule rather than a performance one;
 * - `to` is exclusive where `from` is inclusive, so two adjacent ranges cannot show one row twice.
 */
function matchesLogQuery(row: PlatformLogResponse, query: PlatformLogQuery): boolean {
  if (query.levels && query.levels.length > 0 && !query.levels.includes(row.level ?? '')) {
    return false;
  }
  if (query.source && !contains(row.source, query.source)) {
    return false;
  }
  if (query.q && !contains(row.message, query.q) && !contains(row.template, query.q)) {
    return false;
  }
  if (query.companyId && row.company_id !== query.companyId) {
    return false;
  }
  if (query.entryId && row.entry_id !== query.entryId) {
    return false;
  }
  if (query.from && (row.at ?? '') < query.from) {
    return false;
  }
  if (query.to && (row.at ?? '') >= query.to) {
    return false;
  }
  return true;
}

function contains(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}
