import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

import { classifyApiError } from '../api/api-failure';
import { AdminSessionService } from '../session/admin-session.service';
import { COMPANY_GATEWAY } from './company-gateway';
import {
  ActivationCodeResponse,
  DeviceResponse,
  ShareTextResponse,
  WorkerResponse,
} from './company-types';

/**
 * How a call to the company surface went, in the words the screen is allowed to use.
 *
 * The B3 taxonomy (`core/api/api-failure.ts`) sorts failures by *whether a retry can help*, which
 * is the question an outbox asks. An admin looking at a list of his men asks a different one:
 * **is it the network, is it my sign-in, or did the server say no?** These are the answers to
 * that, and they are deliberately five rather than one.
 *
 * This project has shipped a screen claiming to know something it did not seven times. The
 * distinctions below are the ones that stop the eighth:
 *
 * - `offline` — nothing reached the server. Whatever was being asked for is unchanged.
 * - `signedOut` — **401.** The credential is not accepted at this moment: the session expired, or
 *   it was withdrawn. Signing in again fixes it, and nothing else does.
 * - `forbidden` — **403.** The credential is fine and this role may not do this. Signing in again
 *   changes nothing, so the screen must not offer it as the remedy.
 * - `notSignedIn` — this browser holds no admin credential at all. Never sent, never a 401.
 * - `refused` — 400/404/409/422. The server looked at the request and would answer the same way
 *   again.
 * - `unavailable` — 5xx, a timeout, or something unrecognised. The server is unwell, not the
 *   request.
 */
export type CompanyStatus =
  | 'ok'
  | 'offline'
  | 'signedOut'
  | 'forbidden'
  | 'notSignedIn'
  | 'refused'
  | 'unavailable';

/**
 * Every member as a value, kept complete by a `Record` the compiler checks.
 *
 * The screen builds `company.reason.${status}` by concatenation, so no scan of string literals in
 * `i18n.spec.ts` can see the keys it produces — the same hazard `AUTH_FAILURES`, `CONFIRM_FAILURES`
 * and `PROFILE_ROLES` exist for, and the same fix. Add a status and the suite stays red until both
 * dictionaries can name it.
 */
const ALL_COMPANY_STATUSES: Record<CompanyStatus, true> = {
  ok: true,
  offline: true,
  signedOut: true,
  forbidden: true,
  notSignedIn: true,
  refused: true,
  unavailable: true,
};

export const COMPANY_STATUSES = Object.keys(ALL_COMPANY_STATUSES) as readonly CompanyStatus[];

/**
 * Whether the server actually looked at the request and answered.
 *
 * **This is the difference between "it did not work" and "we do not know whether it worked", and
 * it is not cosmetic.** Issuing an activation code supersedes the one the worker is holding, so an
 * admin who is told "failed" after a request that in fact succeeded will press the button again
 * and kill a code that was already on its way to a man's phone. A revoke that timed out may well
 * have revoked. Where the server gave no verdict, the screen says so and tells him to reload
 * before acting again.
 */
export function serverAnswered(status: CompanyStatus): boolean {
  return status !== 'offline' && status !== 'unavailable' && status !== 'notSignedIn';
}

/** One foreman, narrowed. */
export interface Worker {
  id: string;
  displayName: string;
  /** His durable identity (decision 7). Absent only from a server that broke its own constraint. */
  username: string | null;
  /** Optional but the normal case: without one he cannot ask for his own replacement code. */
  email: string | null;
  language: string | null;
  /** Taken out of service. A stamp, never a delete — a man who authored evidence stays nameable. */
  disabled: boolean;
  /** Phones still allowed to record as him. Zero until he has activated at all. */
  activeDeviceCount: number;
  lastSeenAt: string | null;
  /** True when there is a code he could type right now — the cue to read it, not to issue one. */
  hasLiveCode: boolean;
}

/** A live activation code, as an admin reads it aloud. */
export interface ActivationCode {
  /** Display form, `XKD4-7HMP`. */
  code: string;
  expiresAt: string | null;
  /** `not_configured` | `no_address` | `queued`, or null from a server that did not say. */
  emailDelivery: string | null;
}

/** One phone. */
export interface Phone {
  id: string;
  name: string;
  userId: string | null;
  workerDisplayName: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface WorkersResult {
  status: CompanyStatus;
  workers: Worker[];
}

export interface DevicesResult {
  status: CompanyStatus;
  devices: Phone[];
}

/**
 * One worker's code and the message that carries it.
 *
 * `noLiveCode` is information rather than failure — the server answered plainly that there is
 * nothing he could type right now, and the admin's next move is to issue one. Modelled the way
 * `ArchiveService.getEntry` models a 404: a state the screen renders, not an error it apologises
 * for.
 */
export interface CodeResult {
  status: CompanyStatus;
  code: ActivationCode | null;
  /** The ready-made Serbian message. Null when the server sent a code but no text. */
  shareText: string | null;
  noLiveCode: boolean;
}

export interface RevokeResult {
  status: CompanyStatus;
  device: Phone | null;
}

/** Which unique index a `POST /api/workers` lost against, when the server said. */
export type AddWorkerConflict = 'username' | 'email' | null;

export interface AddWorkerResult {
  status: CompanyStatus;
  worker: Worker | null;
  code: ActivationCode | null;
  conflict: AddWorkerConflict;
}

/**
 * The company admin's connection to his own company.
 *
 * **Best effort by construction**, exactly as `ArchiveService` and `ProfileService` are: no method
 * throws, and every one returns a status alongside whatever it managed to get. A rejected promise
 * reaching the component would leave an admin looking at a spinner with no sentence under it.
 *
 * Nothing here is on the capture path and nothing awaits it. `/company` is not reachable from a
 * foreman's phone at all unless he is also signed in as an admin, and even then the route gate
 * answers from `localStorage` synchronously (`core/session/device.guard.ts`).
 */
@Injectable({ providedIn: 'root' })
export class CompanyService {
  private readonly gateway = inject(COMPANY_GATEWAY);
  private readonly admins = inject(AdminSessionService);

  /** The company's foremen. */
  async listWorkers(): Promise<WorkersResult> {
    if (!this.admins.token()) {
      return { status: 'notSignedIn', workers: [] };
    }
    try {
      const response = await this.gateway.listWorkers();
      return { status: 'ok', workers: (response.workers ?? []).flatMap(toWorker) };
    } catch (error) {
      return { status: classify(error), workers: [] };
    }
  }

  /** The company's phones, revoked ones included — the admin needs both to tell them apart. */
  async listDevices(): Promise<DevicesResult> {
    if (!this.admins.token()) {
      return { status: 'notSignedIn', devices: [] };
    }
    try {
      const response = await this.gateway.listDevices();
      return { status: 'ok', devices: (response.devices ?? []).flatMap(toPhone) };
    } catch (error) {
      return { status: classify(error), devices: [] };
    }
  }

  /**
   * Read one worker's live code and the message that carries it. **Never issues one.**
   *
   * The whole shape of this feature turns on that sentence. `GET /share-text` returns the live
   * code and the ready-made message together, and it answers `409 no_live_activation_code` when
   * there is nothing to read — which is why one call serves both the "here is his code" and the
   * "he has none, offer to issue one" states without ever risking a code the man is holding.
   */
  async readCode(workerId: string): Promise<CodeResult> {
    if (!this.admins.token()) {
      return { status: 'notSignedIn', code: null, shareText: null, noLiveCode: false };
    }
    try {
      const response = await this.gateway.shareText(workerId);
      return {
        status: 'ok',
        code: toCode(response.activation_code),
        shareText: text(response.text),
        noLiveCode: false,
      };
    } catch (error) {
      // A 409 carrying `no_live_activation_code` is the server telling us a fact about the worker,
      // not refusing the request. Branching on the problem `code` and never on the English detail
      // string is the rule B3 settled and CLAUDE.md restates.
      if (problemCode(error) === 'no_live_activation_code') {
        return { status: 'ok', code: null, shareText: null, noLiveCode: true };
      }
      return { status: classify(error), code: null, shareText: null, noLiveCode: false };
    }
  }

  /**
   * Issue a fresh code, **superseding whatever he had**.
   *
   * The share text is fetched immediately afterwards so the admin gets the message as well as the
   * code, and its failure is swallowed: the code in hand is the thing that matters, and a second
   * call that did not answer must not make a successful issue look like a failed one.
   */
  async issueCode(workerId: string): Promise<CodeResult> {
    if (!this.admins.token()) {
      return { status: 'notSignedIn', code: null, shareText: null, noLiveCode: false };
    }

    let issued: ActivationCode | null;
    try {
      issued = toCode(await this.gateway.issueCode(workerId));
    } catch (error) {
      return { status: classify(error), code: null, shareText: null, noLiveCode: false };
    }

    if (!issued) {
      // A 200 this build could not read. The code **was** issued and the worker's previous one is
      // dead, so the screen has to say "reload" rather than "try again" — pressing the button
      // again would supersede a code that exists.
      return { status: 'unavailable', code: null, shareText: null, noLiveCode: false };
    }

    const message = await this.gateway
      .shareText(workerId)
      .then((response) => text(response.text))
      .catch(() => null);

    return { status: 'ok', code: issued, shareText: message, noLiveCode: false };
  }

  /**
   * Add a foreman and issue his first code, in one action.
   *
   * **The username is deliberately not sent.** The server proposes one from the display name
   * (`zoran.jovanovic`, then `zoran.jovanovic2`) and retries its own proposal once if it loses a
   * race, so an admin adding a man never meets a "that name is taken" fight he did not pick (§4).
   * A field for it would be a field to get wrong, on the screen whose whole point is that
   * onboarding a foreman takes one minute rather than a database session.
   */
  async addWorker(displayName: string, email: string | null): Promise<AddWorkerResult> {
    if (!this.admins.token()) {
      return { status: 'notSignedIn', worker: null, code: null, conflict: null };
    }
    try {
      const response = await this.gateway.addWorker({
        display_name: displayName.trim(),
        ...(email && email.trim().length > 0 ? { email: email.trim().toLowerCase() } : {}),
      });
      const worker = toWorker(response.worker ?? {})[0] ?? null;
      return {
        status: worker ? 'ok' : 'unavailable',
        worker,
        code: toCode(response.activation_code),
        conflict: null,
      };
    } catch (error) {
      const code = problemCode(error);
      return {
        status: classify(error),
        worker: null,
        code: null,
        conflict:
          code === 'email_taken' ? 'email' : code === 'username_taken' ? 'username' : null,
      };
    }
  }

  /**
   * Withdraw a phone's credential. A stamp, never a delete, and idempotent server-side.
   *
   * The idempotence matters to the screen rather than to the server: revoking a phone that is
   * already revoked answers exactly as revoking it the first time, so an admin who taps twice —
   * or retries after a timeout — cannot do damage or be told something false.
   */
  async revokeDevice(deviceId: string): Promise<RevokeResult> {
    if (!this.admins.token()) {
      return { status: 'notSignedIn', device: null };
    }
    try {
      const response = await this.gateway.revokeDevice(deviceId);
      return { status: 'ok', device: toPhone(response)[0] ?? null };
    } catch (error) {
      return { status: classify(error), device: null };
    }
  }
}

/**
 * The B3 taxonomy, reduced to the six things this surface can say.
 *
 * Reusing `classifyApiError` rather than reading statuses again is the choice `ArchiveService`,
 * `ProfileService` and `ActivationService` all made, for the same reason: what a status *means* —
 * status 0 is a network failure and not the server's answer, every 5xx is the server being unwell
 * — was settled at B3 and is binding. Two places deciding it independently is how two screens end
 * up disagreeing about whether the server is down.
 *
 * **401 and 403 are kept apart here**, unlike on the archive and the profile screen, and that is
 * the point of having a separate function. Those two screens say "the server did not accept this
 * phone" either way because there is nothing the reader can do about it. Here there is: a 401 is
 * fixed by signing in again and a 403 is not, and offering the wrong remedy is a screen lying
 * about what it knows.
 */
function classify(error: unknown): CompanyStatus {
  const failure = classifyApiError(error);
  switch (failure.kind) {
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
 * The stable `code` token on a problem-details body, or null.
 *
 * `ApiProblems.Conflict(code, detail)` puts it there precisely so a client can branch without
 * reading English prose — the lesson B3 wrote down as "a 409 is never judged alone... never on the
 * English detail string". Absent, unreadable or the wrong type, this answers null and the caller
 * falls back to treating the response as a plain refusal.
 */
function problemCode(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse)) {
    return null;
  }
  const body = error.error as { code?: unknown } | null;
  return body && typeof body.code === 'string' ? body.code : null;
}

/**
 * One worker, or nothing.
 *
 * `flatMap`-shaped — it returns zero or one — because a row with no id is a row with no actions:
 * every button on this screen addresses a worker by id, and rendering a name that cannot be acted
 * on would be a row that silently does nothing when tapped. A display name is required for the
 * same reason in reverse: an id with no name is a row nobody can identify.
 *
 * Unlike a session, this is deliberately **not** all-or-nothing beyond those two fields. A worker
 * with no email is the ordinary case, and a missing `last_seen_at` means "never called home" — a
 * screen that dropped him for it would hide the very man who most needs a code.
 */
function toWorker(response: WorkerResponse): Worker[] {
  const id = text(response.id);
  const displayName = text(response.display_name);
  if (!id || !displayName) {
    return [];
  }

  return [
    {
      id,
      displayName,
      username: text(response.username),
      email: text(response.email),
      language: text(response.language),
      disabled: text(response.disabled_at) !== null,
      activeDeviceCount:
        typeof response.active_device_count === 'number' && response.active_device_count > 0
          ? response.active_device_count
          : 0,
      lastSeenAt: text(response.last_seen_at),
      hasLiveCode: response.has_live_activation_code === true,
    },
  ];
}

/** One phone, or nothing. Same rule as {@link toWorker}: no id means no revoke button. */
function toPhone(response: DeviceResponse): Phone[] {
  const id = text(response.id);
  if (!id) {
    return [];
  }
  return [
    {
      id,
      // A phone that reached activation without a name is possible — `device_name` is optional on
      // the wire — and it still has to be revocable, so the name falls back at the screen.
      name: text(response.name) ?? '',
      userId: text(response.user_id),
      workerDisplayName: text(response.worker_display_name),
      lastSeenAt: text(response.last_seen_at),
      revokedAt: text(response.revoked_at),
    },
  ];
}

/** A code, or null. The code string itself is the one field without which there is nothing to show. */
function toCode(response: ActivationCodeResponse | null | undefined): ActivationCode | null {
  const code = text(response?.code);
  return code
    ? {
        code,
        expiresAt: text(response?.expires_at),
        emailDelivery: text(response?.email_delivery),
      }
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
