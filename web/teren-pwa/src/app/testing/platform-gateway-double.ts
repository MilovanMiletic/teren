import { HttpErrorResponse } from '@angular/common/http';

import { MockPlatformGateway } from '../core/platform/mock-platform-gateway';
import { PlatformGateway } from '../core/platform/platform-gateway';
import {
  CreateAdminRequest,
  CreateAdminResponse,
  CreateCompanyRequest,
  InviteSentResponse,
  PlatformCompanyListResponse,
  PlatformCompanyResponse,
  PlatformUserListResponse,
  PlatformUserResponse,
} from '../core/platform/platform-types';

/** A promise a spec releases when it chooses, so it can look at the screen mid-flight. */
export interface PlatformDeferred {
  promise: Promise<void>;
  release: () => void;
}

export function platformDeferred(): PlatformDeferred {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The server's refusals, as `HttpErrorResponse` and never a bare `Error`.
 *
 * `classifyApiError` reads the status off it; anything else lands in `unavailable`, so a spec
 * built on a plain `Error` would assert the wrong sentence while looking correct.
 *
 * Declared here rather than imported from `company-gateway-double.ts` on purpose: the platform
 * specs must not depend on the office's test infrastructure, and three lines that say the same
 * thing are cheaper than a coupling between two features' doubles.
 */
export function platformHttpError(status: number, body: unknown = { detail: 'no' }): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'x', error: body });
}

/**
 * `MockPlatformGateway` with knobs, shared by the two screens of the platform surface.
 *
 * The mock already models the endpoints those screens were written against — two customers, three
 * accounts, a real 409 on a duplicate address, an idempotent suspend — so the happy paths run
 * through it untouched and a spec can assert on **what was actually asked for** rather than on a
 * `vi.fn()` that agreed with itself. What the mock cannot do is fail the way the network fails;
 * these knobs supply the verdicts the screens have to be honest about.
 *
 * Two properties are the reason it counts calls at all:
 *
 * - **`notSignedIn` means nothing is sent.** `PlatformService` promises never to issue a request
 *   that is guaranteed to 401, and a promise about a request that was *not* made can only be
 *   asserted by counting the ones that were.
 * - **A reload is not a repaint.** `/platform` re-reads after a successful create; without a
 *   counter that is indistinguishable from a screen redrawing the list it already had.
 *
 * Hand-written with plain fields, the same house choice `KnobbedGateway` makes: a `vi.mock` of the
 * module would replace the narrowing between the wire and the glass, which on these screens is
 * half of what is under test.
 */
export class KnobbedPlatformGateway implements PlatformGateway {
  readonly real = new MockPlatformGateway();

  companiesError: unknown = null;
  createCompanyError: unknown = null;
  suspendError: unknown = null;
  resumeError: unknown = null;
  usersError: unknown = null;
  createAdminError: unknown = null;

  /**
   * Whether the server has a mail relay to invite anybody with.
   *
   * False is the case worth having a knob for: the account is created and **no invite is sent**,
   * so the screen has to say so rather than imply a mail is on its way. Nothing else on the
   * surface behaves differently, which is exactly why it would go untested without this.
   */
  emailed = true;
  inviteError: unknown = null;
  disableError: unknown = null;
  enableError: unknown = null;

  /** Held open, a call lets a spec look at the screen while the request is still in flight. */
  usersGate: PlatformDeferred | null = null;
  createAdminGate: PlatformDeferred | null = null;
  suspendGate: PlatformDeferred | null = null;

  /** How many times each list was actually asked for, so a reload can be told from a repaint. */
  companyListings = 0;
  userListings = 0;

  /** Exactly what reached the wire, in order. Empty is the assertion `notSignedIn` needs. */
  readonly createdCompanies: CreateCompanyRequest[] = [];
  readonly createdAdmins: CreateAdminRequest[] = [];
  readonly suspended: string[] = [];
  readonly resumed: string[] = [];
  readonly invited: string[] = [];
  readonly disabled: string[] = [];
  readonly enabled: string[] = [];

  async listCompanies(query: { q?: string; cursor?: string } = {}): Promise<PlatformCompanyListResponse> {
    this.companyListings += 1;
    this.refuse(this.companiesError);
    return this.real.listCompanies(query);
  }

  async createCompany(request: CreateCompanyRequest): Promise<PlatformCompanyResponse> {
    this.refuse(this.createCompanyError);
    this.createdCompanies.push(request);
    return this.real.createCompany(request);
  }

  async suspendCompany(companyId: string): Promise<PlatformCompanyResponse> {
    await this.suspendGate?.promise;
    this.refuse(this.suspendError);
    this.suspended.push(companyId);
    return this.real.suspendCompany(companyId);
  }

  async resumeCompany(companyId: string): Promise<PlatformCompanyResponse> {
    this.refuse(this.resumeError);
    this.resumed.push(companyId);
    return this.real.resumeCompany(companyId);
  }

  async listUsers(
    query: { companyId?: string; role?: string; status?: string; q?: string; cursor?: string } = {},
  ): Promise<PlatformUserListResponse> {
    this.userListings += 1;
    await this.usersGate?.promise;
    this.refuse(this.usersError);
    return this.real.listUsers(query);
  }

  async createAdmin(request: CreateAdminRequest): Promise<CreateAdminResponse> {
    await this.createAdminGate?.promise;
    this.refuse(this.createAdminError);
    this.createdAdmins.push(request);
    return { ...(await this.real.createAdmin(request)), emailed: this.emailed };
  }

  async invite(userId: string): Promise<InviteSentResponse> {
    this.refuse(this.inviteError);
    this.invited.push(userId);
    return { ...(await this.real.invite(userId)), emailed: this.emailed };
  }

  async disableUser(userId: string): Promise<PlatformUserResponse> {
    this.refuse(this.disableError);
    this.disabled.push(userId);
    return this.real.disableUser(userId);
  }

  async enableUser(userId: string): Promise<PlatformUserResponse> {
    this.refuse(this.enableError);
    this.enabled.push(userId);
    return this.real.enableUser(userId);
  }

  private refuse(error: unknown): void {
    if (error) {
      throw error;
    }
  }
}
