import { Injectable, inject } from '@angular/core';

import { classifyApiError } from '../api/api-failure';
import { FileSaver } from '../report/file-saver';
import { filenameFromContentDisposition, safeFilename } from '../report/report-filename';
import { AdminSessionService } from '../session/admin-session.service';
import { PLATFORM_GATEWAY } from './platform-gateway';
import {
  CreateAdminRequest,
  InviteSentResponse,
  PlatformCompanyResponse,
  PlatformDeliveryHealthResponse,
  PlatformFailureTallyResponse,
  PlatformHealthResponse,
  PlatformLogQuery,
  PlatformLogResponse,
  PlatformPipelineHealthResponse,
  PlatformSiteHealthResponse,
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

/**
 * How an invite went out.
 *
 * **It holds no credential, and that is the whole of the 2026-09-01 change.** This used to carry
 * the plaintext set-password token so the founder could read the link down the phone. The token is
 * minted on the server, inside the job that mails it, and never leaves the server again.
 */
export interface Invite {
  /** Who it went to. Null when the server did not say. */
  email: string | null;
  /** **Queued, not delivered.** False means no relay was configured, so nothing was sent at all. */
  emailed: boolean;
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
 * One line of the server's log, narrowed (D5).
 *
 * **`id` stays a string.** It is a `bigserial`, and a JSON number in a browser loses precision
 * above 2^53 — nothing here ever coerces it, because by the time it could the value would already
 * be wrong. It is a cursor key and a `track` expression, never arithmetic.
 *
 * `message` is required and everything else is not, which is the one judgement in this shape: a
 * row with no rendered message is a row the screen cannot draw a line for, and drawing an empty
 * one would read as a log the server failed to send rather than as a log line.
 */
export interface LogRecord {
  id: string;
  at: string | null;
  /** One of the six Serilog levels, as stored. Translated only where it is *shown*. */
  level: string;
  source: string | null;
  /** The template, `{Placeholders}` intact — what makes a hundred lines one kind of line. */
  template: string | null;
  message: string;
  properties: Record<string, unknown> | null;
  /** Scrubbed server-side. Shown on demand, and **never searched** (contract §1). */
  exception: string | null;
  companyId: string | null;
  entryId: string | null;
  correlation: string | null;
}

export interface LogListResult {
  status: PlatformStatus;
  logs: LogRecord[];
  /** Opaque and keyset. Null means this really is the last page of this filter. */
  nextCursor: string | null;
}

export interface LogExportResult {
  status: PlatformStatus;
  /** What the file was actually saved as. Null unless the bytes reached the browser. */
  filename: string | null;
}

/*
 * ---- The estate's health, narrowed (F7) ------------------------------------------------------
 *
 * Two rules are enforced *here*, once, rather than on the screen — because a screen that had to
 * remember them would eventually forget one and the forgetting would look like good news:
 *
 * 1. **`queue.available` is true only if the server said the literal `true`.** Anything else — a
 *    missing field, a body this build cannot read — is "I could not tell", never an empty queue.
 * 2. **A tally whose reason cannot be read becomes `unrecognised`**, which is the server's own
 *    token for a code it does not recognise. Dropping it would under-report failures on the one
 *    screen an owner opens because he already doubts what he is told.
 */

/** One number per state of the entry state machine (ARCHITECTURE §6). */
export interface PipelineHealth {
  entryCount: number;
  received: number;
  processing: number;
  awaitingConfirmation: number;
  needsReview: number;
  confirmed: number;
  reported: number;
}

/** The report state machine, counted. `sent` is custody, never readership. */
export interface DeliveryHealth {
  reportCount: number;
  sending: number;
  sent: number;
  failed: number;
}

/**
 * One reason and how many carry it.
 *
 * `reason` is always a code the server compiled in, or the literal {@link UNRECOGNISED_REASON}.
 * **Never free text**, which is what makes it safe for a screen to translate.
 */
export interface FailureTally {
  reason: string;
  count: number;
}

/** What the server calls a failure code it does not declare — and what this client calls one it
 *  cannot read. Same token, because they are the same fact to a reader. */
export const UNRECOGNISED_REASON = 'unrecognised';

/** The job queue. `available: false` means **unknown** — see the block comment above. */
export interface QueueHealth {
  available: boolean;
  /** A fixed token (`not_configured`, `unreadable`) when unavailable; null otherwise. */
  detail: string | null;
  enqueued: number;
  scheduled: number;
  processing: number;
  failed: number;
  servers: number;
}

/** One site of one customer, named. No address, no coordinates, no recipients — see the DTOs. */
export interface SiteHealth {
  companyId: string;
  companyName: string;
  projectId: string;
  projectName: string;
  pipeline: PipelineHealth;
  pipelineFailures: FailureTally[];
  delivery: DeliveryHealth;
  deliveryFailures: FailureTally[];
}

export interface Health {
  /** When the **server** computed it. Null only if it did not say; the screen then says so. */
  at: string | null;
  pipeline: PipelineHealth;
  pipelineFailures: FailureTally[];
  delivery: DeliveryHealth;
  deliveryFailures: FailureTally[];
  queue: QueueHealth;
  /** Capped at 500 by the server, **attention first**, so what is missing is always healthy. */
  sites: SiteHealth[];
  /** Non-zero means the screen is not showing the whole estate and has to say so. */
  sitesOmitted: number;
}

export interface HealthResult {
  status: PlatformStatus;
  health: Health | null;
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
  private readonly saver = inject(FileSaver);

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
      return { status: this.classify(error), customers: [], nextCursor: null };
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
      return { status: this.classify(error), customer: null };
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
      return { status: this.classify(error), customer: null };
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
      return { status: this.classify(error), people: [], nextCursor: null };
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
      const invite = toInvite(
        response === null || response === undefined
          ? null
          : { email: null, emailed: response.emailed },
      );
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
      return { status: this.classifyCreate(error), person: null, invite: null };
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
      return { status: this.classify(error), invite: null };
    }
  }

  /**
   * What the pipeline is doing across every customer.
   *
   * **A body this build cannot read is reported as `unavailable` with no health at all**, never as
   * an estate of zeroes. Same doctrine as {@link createCustomer}, and here it is the whole point of
   * the screen: "there is nothing wrong anywhere" and "I could not find out" are opposite claims,
   * and this is the screen a founder opens precisely because he does not trust what he is being
   * told. `serverAnswered` is false for `unavailable`, so the screen says *reload*.
   */
  async readHealth(): Promise<HealthResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', health: null };
    }
    try {
      const health = toHealth(await this.gateway.getHealth());
      return health ? { status: 'ok', health } : { status: 'unavailable', health: null };
    } catch (error) {
      return { status: this.classify(error), health: null };
    }
  }

  /**
   * One keyset page of the server's log.
   *
   * **Filtered on the server**, unlike every other list on this surface — see the gateway for why.
   * The cursor is passed straight back out again without being read: it is the server's own
   * bookmark, and a client that parsed it would be a client that breaks when the ordering changes.
   */
  async listLogs(query: PlatformLogQuery = {}): Promise<LogListResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', logs: [], nextCursor: null };
    }
    try {
      const response = await this.gateway.listLogs(query);
      return {
        status: 'ok',
        logs: (response?.logs ?? []).map(toLogRecord).filter(isPresent),
        nextCursor: text(response?.next_cursor),
      };
    } catch (error) {
      return { status: this.classify(error), logs: [], nextCursor: null };
    }
  }

  /**
   * The same query as a file, handed to the browser.
   *
   * The bytes are fetched with the admin bearer and only then given to the browser as a download,
   * because a plain `<a href>` cannot carry an `Authorization` header — the same reason
   * `ReportService` exists rather than a link on the archive screen, and the same `FileSaver`.
   *
   * A `200` with no bytes is reported as a failure rather than saved: an empty CSV looks to a
   * founder exactly like a log with nothing in it, which is the one wrong conclusion this screen
   * must never invite.
   */
  async exportLogs(query: PlatformLogQuery = {}): Promise<LogExportResult> {
    if (!this.admins.signedIn()) {
      return { status: 'notSignedIn', filename: null };
    }
    try {
      const download = await this.gateway.exportLogs(query);
      if (!download.body || download.body.size === 0) {
        return { status: 'unavailable', filename: null };
      }

      const filename = safeFilename(
        filenameFromContentDisposition(download.contentDisposition),
        // Neutral and untranslated, exactly as the report's fallback is: the file may be opened on
        // a machine that has never heard of this app, and a Serbian sentence in a filename is not
        // a name, it is a note.
        `teren-logs-${stamp()}`,
        'csv',
      );
      this.saver.save(download.body, filename);
      return { status: 'ok', filename };
    } catch (error) {
      return { status: this.classify(error), filename: null };
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
      return { status: this.classify(error), person: null };
    }
  }

  /**
   * {@link classifyStatus}, plus the consequence: **a 401 ends the session in this browser.**
   *
   * The twin of `CompanyService.classify`, which carries the full reasoning. The short version is
   * that a screen saying "sign in again" over a `localStorage` row the server has already refused
   * makes `requiresNoAdminSession` bounce the reader off `/login` and back to the 401s. One
   * `localStorage` row goes; nothing else is touched, and a 403 signs nobody out.
   */
  private classify(error: unknown): PlatformStatus {
    const status = classifyStatus(error);
    if (status === 'signedOut') {
      this.admins.signOut();
    }
    return status;
  }

  /**
   * The same, plus the one refusal the founder can fix without leaving the form.
   *
   * A 409 on create means the address already has an account. Telling him "the server refused it"
   * would be true and useless; telling him the address is taken is the same fact with the remedy
   * attached. Every other 4xx stays `refused` — and a 401 still ends the session, because it is
   * {@link classify} that decides the rest.
   */
  private classifyCreate(error: unknown): PlatformStatus {
    const failure = classifyApiError(error);
    return failure.kind === 'rejected' && failure.status === 409
      ? 'emailTaken'
      : this.classify(error);
  }
}

/**
 * The B3 taxonomy, reduced to what this surface can say.
 *
 * **401 and 403 are kept apart**, as on the company surface and for the same reason: a 401 is
 * fixed by signing in again and a 403 is not, and offering the wrong remedy is a screen lying
 * about what it knows.
 *
 * A pure function of the error. What a 401 *does* to the stored credential belongs to
 * `PlatformService.classify`, which is the wrapper every caller here uses.
 */
function classifyStatus(error: unknown): PlatformStatus {
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

/**
 * Narrowed from the wire, and **`emailed` is required rather than defaulted**.
 *
 * A body this build cannot read resolves to null, so the screen says "it did not go through"
 * instead of quietly claiming a mail is on its way. Defaulting a missing flag to false would look
 * the same on screen today and would hide a contract change tomorrow.
 */
function toInvite(response: InviteSentResponse | null): Invite | null {
  if (typeof response?.emailed !== 'boolean') {
    return null;
  }
  return { email: text(response.email), emailed: response.emailed };
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

/**
 * Narrowed from the wire.
 *
 * A row with no id or no rendered message is dropped rather than drawn: the id is what a keyset
 * cursor and a `track` expression are built on, and an empty line in a log reads as a server that
 * failed to send something rather than as a thing that happened.
 *
 * The level falls back to `Information` rather than to an empty string. A blank in the one column
 * that says how alarmed to be is worse than a slightly wrong guess, and a level this build has
 * never heard of still prints as itself.
 */
function toLogRecord(response: PlatformLogResponse | null): LogRecord | null {
  const id = text(response?.id);
  const message = text(response?.message);
  if (!id || !message) {
    return null;
  }
  return {
    id,
    at: text(response?.at),
    level: text(response?.level) ?? 'Information',
    source: text(response?.source),
    template: text(response?.template),
    message,
    properties:
      response?.properties && typeof response.properties === 'object' ? response.properties : null,
    exception: text(response?.exception),
    companyId: text(response?.company_id),
    entryId: text(response?.entry_id),
    correlation: text(response?.correlation),
  };
}

/**
 * The estate, narrowed — or null when the body says nothing this screen could draw.
 *
 * **All or nothing on the three aggregate blocks**, the same rule `toCustomer` applies to a row.
 * With `pipeline`, `delivery` or `queue` missing, every count would narrow to zero and the screen
 * would report a product in which nothing has ever happened and nothing is wrong. That is the most
 * reassuring possible rendering of a payload nobody could read, on the screen where reassurance is
 * the one thing that must be earned.
 *
 * `sites` is allowed to be absent or empty, because an estate with no site is a real state — a
 * fresh install has none — and a missing site list does not make the headline numbers untrue.
 */
function toHealth(response: PlatformHealthResponse | null | undefined): Health | null {
  const pipeline = response?.pipeline;
  const delivery = response?.delivery;
  const queue = response?.queue;
  if (!pipeline || !delivery || !queue) {
    return null;
  }

  return {
    at: text(response?.at),
    pipeline: toPipeline(pipeline),
    pipelineFailures: toTallies(response?.pipeline_failures),
    delivery: toDelivery(delivery),
    deliveryFailures: toTallies(response?.delivery_failures),
    queue: {
      // **The literal `true`, and nothing else.** A missing field is not permission to draw an
      // empty queue: `false` here means *the reader could not ask*, which is one of the worst
      // states the system has, and zero enqueued jobs is one of the best.
      available: queue.available === true,
      detail: text(queue.detail),
      enqueued: count(queue.enqueued),
      scheduled: count(queue.scheduled),
      processing: count(queue.processing),
      failed: count(queue.failed),
      servers: count(queue.servers),
    },
    sites: (response?.sites ?? []).map(toSite).filter(isPresent),
    sitesOmitted: count(response?.sites_omitted),
  };
}

function toPipeline(response: PlatformPipelineHealthResponse): PipelineHealth {
  return {
    entryCount: count(response.entry_count),
    received: count(response.received),
    processing: count(response.processing),
    awaitingConfirmation: count(response.awaiting_confirmation),
    needsReview: count(response.needs_review),
    confirmed: count(response.confirmed),
    reported: count(response.reported),
  };
}

function toDelivery(response: PlatformDeliveryHealthResponse): DeliveryHealth {
  return {
    reportCount: count(response.report_count),
    sending: count(response.sending),
    sent: count(response.sent),
    failed: count(response.failed),
  };
}

/**
 * The failure tallies, in the order the server sent them — **largest first, and never re-sorted.**
 *
 * A reason that cannot be read becomes {@link UNRECOGNISED_REASON} rather than being dropped: the
 * count is a real count either way, and a screen that silently discarded it would under-report
 * failures. A tally of zero is dropped, because "this failure happened no times" is not a fact
 * anybody needs a row for.
 */
function toTallies(rows: PlatformFailureTallyResponse[] | null | undefined): FailureTally[] {
  return (rows ?? [])
    .map((row) => ({ reason: text(row?.reason) ?? UNRECOGNISED_REASON, count: count(row?.count) }))
    .filter((tally) => tally.count > 0);
}

/**
 * One site, or null.
 *
 * Every naming field or nothing — the rule `toCustomer` applies, and for the sharper reason: a row
 * with no customer name and no site name is a line of numbers the founder cannot act on, on a
 * screen whose entire value is saying *whose* problem this is.
 */
function toSite(response: PlatformSiteHealthResponse | null): SiteHealth | null {
  const companyId = text(response?.company_id);
  const companyName = text(response?.company_name);
  const projectId = text(response?.project_id);
  const projectName = text(response?.project_name);
  if (!companyId || !companyName || !projectId || !projectName) {
    return null;
  }

  return {
    companyId,
    companyName,
    projectId,
    projectName,
    // A site whose blocks are missing narrows to zeroes rather than being dropped: the row still
    // names a real site, and the estate totals above it are computed by the server from the
    // aggregates themselves, so a row of zeroes cannot make the headline numbers wrong.
    pipeline: toPipeline(response?.pipeline ?? {}),
    pipelineFailures: toTallies(response?.pipeline_failures),
    delivery: toDelivery(response?.delivery ?? {}),
    deliveryFailures: toTallies(response?.delivery_failures),
  };
}

/** `20260902-1812` — the shape the server's own filename uses, for when it cannot be read. */
function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}
