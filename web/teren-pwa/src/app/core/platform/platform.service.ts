import { Injectable, inject } from '@angular/core';

import { classifyApiError } from '../api/api-failure';
import { AdminSessionService } from '../session/admin-session.service';
import { PLATFORM_GATEWAY } from './platform-gateway';
import {
  CreateAdminRequest,
  InviteUserResponse,
  PlatformCompanyResponse,
  PlatformUserResponse,
} from './platform-types';

/**
 * How a call to the platform surface went, in the words the screen is allowed to use.
 *
 * The same seven-value taxonomy `CompanyService` uses, declared separately rather than imported.
 * That is the house pattern — `ArchiveService` and `ProfileService` each reduce the B3 taxonomy to
 * what *their* surface can say — and here it also keeps two lazily-loaded admin chunks from
 * dragging each other in for a type. The members are identical because the question is identical:
 * **is it the network, is it my sign-in, or did the server say no?**
 *
 * `emailTaken` is the one member `CompanyService` has no use for: creating an admin is the only
 * action on this surface that can be refused for a reason the founder can *fix in the form*, and
 * collapsing it into `refused` would make the screen say "the server would answer the same way
 * again" about a mistake that is one keystroke from working.
 */
export type PlatformStatus =
  | 'ok'
  | 'offline'
  | 'signedOut'
  | 'forbidden'
  | 'notSignedIn'
  | 'refused'
  | 'emailTaken'
  | 'unavailable';

/**
 * Every member as a value, kept complete by a `Record` the compiler checks.
 *
 * The screens build `platform.reason.${status}` by concatenation, so no scan of string literals in
 * `i18n.spec.ts` can see the keys they produce. Add a status and the suite stays red until both
 * dictionaries can name it.
 */
const ALL_PLATFORM_STATUSES: Record<PlatformStatus, true> = {
  ok: true,
  offline: true,
  signedOut: true,
  forbidden: true,
  notSignedIn: true,
  refused: true,
  emailTaken: true,
  unavailable: true,
};

export const PLATFORM_STATUSES = Object.keys(ALL_PLATFORM_STATUSES) as readonly PlatformStatus[];

/**
 * Whether the server actually looked at the request and answered.
 *
 * The difference between "it did not work" and "we do not know whether it worked", and on this
 * surface it is sharper than on any other: **inviting supersedes a live link**, and suspending a
 * customer stops every phone in it. A founder told "failed" after a request that in fact succeeded
 * will press again — and the second press retires a link that was already on its way to somebody.
 */
export function serverAnswered(status: PlatformStatus): boolean {
  return status !== 'offline' && status !== 'unavailable' && status !== 'notSignedIn';
}

/** One customer, narrowed. */
export interface Customer {
  id: string;
  name: string;
  createdAt: string | null;
  /** Non-null means withdrawn. Every credential of theirs 401s on next contact. */
  suspendedAt: string | null;
  userCount: number;
  activeUserCount: number;
}

/** One account, narrowed. */
export interface Person {
  id: string;
  companyId: string | null;
  companyName: string | null;
  /** `super_admin` | `company_admin` | `worker`, as the server said it. */
  role: string;
  username: string | null;
  displayName: string;
  email: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  /** Taken out of service. A stamp, never a delete — evidence stays nameable. */
  disabled: boolean;
  /** Invited and never finished. The state the founder chases. */
  passwordPending: boolean;
}

/** A set-password link, as the founder reads it down the phone. */
export interface Invite {
  /** `invite` — never had a password — or `reset`, which is the impersonation-shaped act (§13.6). */
  purpose: string | null;
  token: string;
  /** The whole link, or null when `Auth:AppUrl` is unset; the token still works. */
  url: string | null;
  expiresAt: string | null;
  /** Non-zero means a link already sent has just stopped working. Worth saying out loud. */
  superseded: number;
}

export interface CustomerListResult {
  status: PlatformStatus;
  customers: Customer[];
  nextCursor: string | null;
}

export interface PersonListResult {
  status: PlatformStatus;
  people: Person[];
  nextCursor: string | null;
}

export interface CustomerResult {
  status: PlatformStatus;
  customer: Customer | null;
}

export interface PersonResult {
  status: PlatformStatus;
  person: Person | null;
}

export interface CreateAdminResult {
  status: PlatformStatus;
  person: Person | null;
  invite: Invite | null;
}

export interface InviteResult {
  status: PlatformStatus;
  invite: Invite | null;
}

/**
 * Teren's own surface: customers, accounts, and the links that let people in.
 *
 * **Never sends without a credential.** Every method answers `notSignedIn` rather than issuing a
 * request that is guaranteed to 401 — which keeps a signed-out screen from reporting "your session
 * expired" when in truth it never had one, and keeps the rate limiter free of requests nobody
 * could have meant.
 */
@Injectable({ providedIn: 'root' })
export class PlatformService {
  private readonly gateway = inject(PLATFORM_GATEWAY);
  private readonly admins = inject(AdminSessionService);

  async listCustomers(query: { q?: string; cursor?: string } = {}): Promise<CustomerListResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', customers: [], nextCursor: null };
    }
    try {
      const response = await this.gateway.listCompanies(query);
      return {
        status: 'ok',
        customers: (response?.companies ?? []).map(toCustomer).filter(isPresent),
        nextCursor: text(response?.next_cursor),
      };
    } catch (error) {
      return { status: classify(error), customers: [], nextCursor: null };
    }
  }

  async createCustomer(name: string): Promise<CustomerResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', customer: null };
    }
    try {
      const customer = toCustomer(await this.gateway.createCompany({ name: name.trim() }));
      // A 200 whose body this build cannot read. **The customer may well exist**, so the honest
      // answer is "we could not confirm", never "it worked": `serverAnswered` is false for
      // `unavailable`, which is what makes the screen say *reload* instead of closing its dialog
      // over a customer that may not be there. Same doctrine as `CompanyService.addWorker`.
      return customer ? { status: 'ok', customer } : { status: 'unavailable', customer: null };
    } catch (error) {
      return { status: classify(error), customer: null };
    }
  }

  /**
   * Withdraw or restore a customer's access.
   *
   * **The heaviest action on this surface.** The authenticator joins `company.suspended_at` on
   * every request with no cache and no expiry, so the moment this lands every phone and every
   * session belonging to that customer starts getting a 401 on next contact. The foremen keep
   * recording — their entries queue and heal — but nothing already captured gets through until it
   * is resumed. The screen that offers it has to say so.
   */
  async setSuspended(companyId: string, suspended: boolean): Promise<CustomerResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', customer: null };
    }
    try {
      const response = suspended
        ? await this.gateway.suspendCompany(companyId)
        : await this.gateway.resumeCompany(companyId);
      return { status: 'ok', customer: toCustomer(response) };
    } catch (error) {
      return { status: classify(error), customer: null };
    }
  }

  async listPeople(
    query: { companyId?: string; role?: string; status?: string; q?: string; cursor?: string } = {},
  ): Promise<PersonListResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', people: [], nextCursor: null };
    }
    try {
      const response = await this.gateway.listUsers(query);
      return {
        status: 'ok',
        people: (response?.users ?? []).map(toPerson).filter(isPresent),
        nextCursor: text(response?.next_cursor),
      };
    } catch (error) {
      return { status: classify(error), people: [], nextCursor: null };
    }
  }

  /**
   * Create a company admin or another member of staff, and get his first link.
   *
   * **`company_id` is sent only for a company admin.** A super admin has none by constraint
   * (`ck_app_user_company_scope`), and sending one is a 400 rather than a value the server ignores
   * — so the screen must not send a stale selection from the other tab.
   */
  async createAdmin(input: {
    role: string;
    displayName: string;
    email: string;
    companyId?: string | null;
    language?: string;
  }): Promise<CreateAdminResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', person: null, invite: null };
    }

    const request: CreateAdminRequest = {
      role: input.role,
      display_name: input.displayName.trim(),
      email: input.email.trim().toLowerCase(),
    };
    if (input.companyId) {
      request.company_id = input.companyId;
    }
    if (input.language) {
      request.language = input.language;
    }

    try {
      const response = await this.gateway.createAdmin(request);
      const person = toPerson(response?.user ?? null);
      const invite = toInvite(response?.invite ?? null);
      // The account **exists** — the server said 200 — and this build could not read it, or could
      // not read the link minted with it. Reported as unconfirmed rather than as success, because
      // the dialog's success view is the link: told "ok" with nothing to show, it would re-render
      // its empty form over an account that was created, say nothing, and invite a second attempt
      // that can only 409. After a reload the account is on the list and `invite` mints a fresh
      // link, which is the recovery this status sends him to.
      if (!person || !invite) {
        return { status: 'unavailable', person: null, invite: null };
      }
      return { status: 'ok', person, invite };
    } catch (error) {
      return { status: classifyCreate(error), person: null, invite: null };
    }
  }

  /**
   * Mint a fresh set-password link.
   *
   * **This supersedes any live link**, so one already sent stops working — which is why
   * `Invite.superseded` is surfaced rather than swallowed. And for an account that already has a
   * password it is a `reset`, which plan §13.6 records as an open founder decision: it is a
   * working impersonation path, not merely a convenience.
   */
  async invite(userId: string): Promise<InviteResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', invite: null };
    }
    try {
      const invite = toInvite(await this.gateway.invite(userId));
      // The same reading as {@link createAdmin}, and here it is sharper: this call **superseded a
      // live link** whether or not the answer could be read. "ok" with nothing to show would have
      // the founder press again and retire a second link, while the one already sent is dead.
      return invite ? { status: 'ok', invite } : { status: 'unavailable', invite: null };
    } catch (error) {
      return { status: classify(error), invite: null };
    }
  }

  async setDisabled(userId: string, disabled: boolean): Promise<PersonResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', person: null };
    }
    try {
      const response = disabled
        ? await this.gateway.disableUser(userId)
        : await this.gateway.enableUser(userId);
      return { status: 'ok', person: toPerson(response) };
    } catch (error) {
      return { status: classify(error), person: null };
    }
  }
}

/**
 * The B3 taxonomy, reduced to what this surface can say.
 *
 * **401 and 403 are kept apart**, as on the company surface and for the same reason: a 401 is
 * fixed by signing in again and a 403 is not, and offering the wrong remedy is a screen lying
 * about what it knows.
 */
function classify(error: unknown): PlatformStatus {
  switch (classifyApiError(error).kind) {
    case 'offline':
      return 'offline';
    case 'unauthenticated':
      return 'signedOut';
    case 'unauthorized':
      return 'forbidden';
    case 'rejected':
      return 'refused';
    case 'not_configured':
      return 'notSignedIn';
    default:
      return 'unavailable';
  }
}

/**
 * The same, plus the one refusal the founder can fix without leaving the form.
 *
 * A 409 on create means the address already has an account. Telling him "the server refused it"
 * would be true and useless; telling him the address is taken is the same fact with the remedy
 * attached. Every other 4xx stays `refused`.
 */
function classifyCreate(error: unknown): PlatformStatus {
  const failure = classifyApiError(error);
  return failure.kind === 'rejected' && failure.status === 409 ? 'emailTaken' : classify(error);
}

function toCustomer(response: PlatformCompanyResponse | null): Customer | null {
  const id = text(response?.id);
  const name = text(response?.name);
  // Every field or nothing: a row this build cannot name is a row it must not draw. The same
  // all-or-nothing rule `toSession` applies to a credential, for the same reason — a half-read
  // customer would render as a nameless line the founder cannot act on.
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    createdAt: text(response?.created_at),
    suspendedAt: text(response?.suspended_at),
    userCount: count(response?.user_count),
    activeUserCount: count(response?.active_user_count),
  };
}

function toPerson(response: PlatformUserResponse | null): Person | null {
  const id = text(response?.id);
  const role = text(response?.role);
  const displayName = text(response?.display_name);
  if (!id || !role || !displayName) {
    return null;
  }
  return {
    id,
    companyId: text(response?.company_id),
    companyName: text(response?.company_name),
    role,
    username: text(response?.username),
    displayName,
    email: text(response?.email),
    createdAt: text(response?.created_at),
    lastLoginAt: text(response?.last_login_at),
    disabled: text(response?.disabled_at) !== null,
    passwordPending: response?.password_pending === true,
  };
}

function toInvite(response: InviteUserResponse | null): Invite | null {
  const token = text(response?.token);
  // The token is the whole point: a link with no token is not a link, and rendering one would
  // hand the founder something to read aloud that cannot work.
  if (!token) {
    return null;
  }
  return {
    purpose: text(response?.purpose),
    token,
    url: text(response?.url),
    expiresAt: text(response?.expires_at),
    superseded: count(response?.superseded),
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
