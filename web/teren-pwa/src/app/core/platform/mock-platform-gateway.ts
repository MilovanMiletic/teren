import { HttpErrorResponse } from '@angular/common/http';

import { PlatformGateway } from './platform-gateway';
import {
  CreateAdminRequest,
  CreateAdminResponse,
  CreateCompanyRequest,
  InviteUserResponse,
  PlatformCompanyListResponse,
  PlatformCompanyResponse,
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

    return { user, invite: this.mintInvite('invite', 0) };
  }

  async invite(userId: string): Promise<InviteUserResponse> {
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user || user.role === 'worker') {
      throw notFound('No account that can hold a password was found.');
    }
    return this.mintInvite(user.password_pending ? 'invite' : 'reset', 0);
  }

  async disableUser(userId: string): Promise<PlatformUserResponse> {
    return this.setDisabled(userId, new Date().toISOString());
  }

  async enableUser(userId: string): Promise<PlatformUserResponse> {
    return this.setDisabled(userId, null);
  }

  private mintInvite(purpose: string, superseded: number): InviteUserResponse {
    const token = `trn_p_${crypto.randomUUID().replace(/-/g, '')}`;
    return {
      purpose,
      token,
      url: `https://teren.example/set-password?token=${token}`,
      expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
      superseded,
    };
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
