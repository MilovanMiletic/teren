import { Injectable, inject } from '@angular/core';

import { classifyApiError } from '../api/api-failure';
import { EntryStore } from '../db/entry-store';
import { PROJECT_CACHE_KEY } from '../projects/api-project-source';
import { ProjectService, SELECTED_PROJECT_KEY } from '../projects/project.service';
import { AdminSession } from '../session/admin-session';
import { AdminSessionService } from '../session/admin-session.service';
import { Session } from '../session/session';
import { SessionService } from '../session/session.service';
import { UploadService } from '../sync/upload.service';
import { foldActivationCode } from './activation-code';
import { AUTH_GATEWAY } from './auth-gateway';
import { ActivateResponse, LoginResponse } from './auth-types';

/**
 * Why an activation or a sign-in did not go through, in the words a screen is allowed to use.
 *
 * The B3 taxonomy (`core/api/api-failure.ts`) sorts errors by *whether a retry can help*, which
 * is the question the outbox asks. A man standing in front of a code field asks a different one —
 * *is it me, is it the phone, or is it them?* — so this union is a translation of the same
 * verdicts into the three answers he can act on, plus the two that are specific to a login
 * surface.
 *
 * One union serves both screens, and the copy differs because the key prefixes do:
 * `auth.code.error.*` and `auth.login.error.*`. `rejected` is "that code is not right" on one and
 * "that email or password is not right" on the other — the same server verdict, two sentences,
 * neither of which the other screen may borrow.
 */
export type AuthFailure =
  /** No network, or a connection that hung. Nothing was sent, and nothing was consumed. */
  | 'offline'
  /** 5xx. The server is unwell; the code in his hand is still good. */
  | 'server'
  /**
   * The credential was not accepted — 401, 403, or a 400/422 the server would repeat.
   *
   * Deliberately one value rather than "wrong code" / "expired" / "already used". The server is
   * specified to answer every credential failure identically (§7), because "revoked" versus
   * "unknown" is an account-enumeration oracle, and a screen that claimed to know which one it
   * was would be inventing the distinction.
   */
  | 'rejected'
  /**
   * **404** — this server has no such route.
   *
   * The routes exist now (D2/D3 shipped 2026-08-31), so this is no longer the normal answer — it
   * is the answer from a phone pointed at an older server: a stale staging box, a cached origin,
   * an install that has not seen a new deploy. Telling a foreman "wrong code" when the server
   * never looked at his code would send him to his boss for a replacement he does not need.
   *
   * It follows that the server must never answer 404 to a bad username or a bad code. §7 says it
   * answers 401; this classification is the client half of that contract.
   */
  | 'notAvailable'
  /** 429 — the rate limiter (§7: 10 attempts / 5 minutes by IP). Waiting genuinely fixes it. */
  | 'tooManyAttempts'
  /**
   * **The server said yes and this build could not read the answer.**
   *
   * Its own member rather than `unknown`, because it is the one failure where the usual reassurance
   * is a lie. Every other sentence on the code screen can honestly end "the code is not used up" —
   * nothing was sent, or the server refused it. Here the opposite is true: a 200 means the code
   * **was** spent and the device row **does** exist, and only the client's reading of the response
   * failed. That is not a hypothetical; it is what the founder met on a real phone on 2026-08-31,
   * where the screen told him his code was untouched and he burned a second single-use code
   * proving otherwise.
   *
   * The known trigger — the nested-versus-flat divergence between the plan and the endpoint — is
   * fixed. The member stays because the shape can drift again, and the next drift must not be able
   * to produce that sentence.
   */
  | 'unreadable'
  | 'unknown';

/**
 * Every member of {@link AuthFailure}, as a value rather than a type.
 *
 * Both screens build their message key by concatenation — `auth.code.error.${failure}` — so no
 * scan of string literals in `i18n.spec.ts` can see the keys they produce. `Record<AuthFailure,
 * true>` is the one construct TypeScript checks for *completeness*, so a new member does not
 * compile until it is listed here, and the i18n spec does not pass until both dictionaries can
 * name it on both screens. This is the same guard `CONFIRM_FAILURES` and `FAILURE_KINDS` carry,
 * for the same reason: a missing key is not an error, it is a raw `auth.code.error.rejected` in
 * front of a foreman.
 */
const ALL_AUTH_FAILURES: Record<AuthFailure, true> = {
  offline: true,
  server: true,
  rejected: true,
  notAvailable: true,
  tooManyAttempts: true,
  unreadable: true,
  unknown: true,
};

/** Every failure the auth screens may be asked to name, for the specs that check they can. */
export const AUTH_FAILURES = Object.keys(ALL_AUTH_FAILURES) as readonly AuthFailure[];

export interface ActivationResult {
  ok: boolean;
  failure: AuthFailure | null;
  /** The credential this phone now holds. Null on every failure. */
  session: Session | null;
  /**
   * How many stuck entries started moving again because of this activation.
   *
   * **Nothing shows this yet, and that is a deferral rather than an oversight.** The activation
   * screen used to end on a success panel that could have carried it; F4 replaced that with an
   * immediate navigation to wherever he was going, which is the right trade — a man who has just
   * typed a code wants the record button, not a receipt. The sentence it was written for ("your 6
   * entries are on their way") belongs on the revocation surface, which is **F8**: Home and the
   * pending screen, where the stuck entries are actually visible.
   *
   * It is computed and returned regardless, because the count is only knowable at the moment of
   * release and `activate()` is the only place that holds it.
   */
  released: number;
}

export interface RequestCodeResult {
  ok: boolean;
  failure: AuthFailure | null;
}

export interface LoginResult {
  ok: boolean;
  failure: AuthFailure | null;
  /** `company_admin` | `super_admin`, as the server said it. Null on failure. */
  role: string | null;
  displayName: string | null;
  /**
   * The credential this browser now holds, or null when the sign-in produced none.
   *
   * Non-null does **not** mean there is a screen to go to: a super admin signs in perfectly well
   * and his surface is F7. The login screen branches on {@link LoginResult.role}, not on this.
   */
  adminSession: AdminSession | null;
}

/**
 * Everything that has to happen when a phone changes hands, in one place.
 *
 * ## Why it is not on `SessionService`
 *
 * `SessionService` injects **nothing**, and that is a constraint rather than a habit: `API_CONFIG`
 * depends on it, so a dependency back into the API layer would be a cycle. Orchestration lives
 * here, where injecting the store, the sync loop and the project list is free.
 *
 * ## Best effort by construction
 *
 * Modelled on `ArchiveService`: **no method throws**, and every one returns a typed failure
 * alongside whatever it managed to do. A rejected promise reaching a component would leave a
 * foreman looking at a spinner with no sentence under it, on the one screen that stands between
 * him and the record button.
 *
 * ## The four things a successful activation must do besides storing a token
 *
 * 1. **Clear the cached project list when the company changes.** It is another company's site
 *    list, and an entry captured against a foreign project id 404s for ever (§10.4).
 * 2. **`releaseBlockedByAuth()`, explicitly.** `UploadService` also watches for a credential
 *    change, but that effect keys on the token *string*: an idempotent re-activation that
 *    returned the same token would move nothing, in exactly the case where a foreman has most
 *    reason to expect his queue to start moving. `EntryStore.releaseBlockedByAuth`'s own comment
 *    records this obligation.
 * 3. **Wake the loop**, so he sees something happen while he is still looking at the screen.
 * 4. **Reload the project list**, never awaited — a network call on this path must not be able to
 *    hold the screen.
 *
 * ## There is no sign-out and nothing is ever deleted
 *
 * Re-activation replaces a credential. Evidence in Dexie belongs to the phone, not to the
 * credential that was current when it was recorded (PROJECT.md principle 3), and a phone handed
 * from one worker to another still holds the first man's unsent entries — which is a founder
 * question (§14.5), not something this service decides by quietly dropping rows.
 */
@Injectable({ providedIn: 'root' })
export class ActivationService {
  private readonly gateway = inject(AUTH_GATEWAY);
  private readonly sessions = inject(SessionService);
  private readonly admins = inject(AdminSessionService);
  private readonly entries = inject(EntryStore);
  private readonly uploads = inject(UploadService);
  private readonly projects = inject(ProjectService);

  /**
   * Bind this phone to a worker.
   *
   * `code` is expected in canonical folded form — `activation-code.ts` is the single description
   * of what a code is, and it is applied at the field. It is folded again here because this is
   * the last point before the wire, and a caller that forgot would otherwise send whatever was
   * typed.
   */
  async activate(
    username: string,
    code: string,
    deviceName = describeDevice(),
  ): Promise<ActivationResult> {
    let response: ActivateResponse;
    try {
      response = await this.gateway.activate({
        username: normaliseUsername(username),
        // Folded here as well as at the field. Folding is idempotent, so this costs nothing on
        // the normal path and closes the one that matters: a caller who passed the raw string
        // would send `XKD4-7HMP`, and the server hashes what it is given.
        activation_code: foldActivationCode(code),
        device_name: deviceName,
      });
    } catch (error) {
      return { ok: false, failure: classify(error), session: null, released: 0 };
    }

    const session = toSession(response);
    if (!session) {
      // A 200 this build cannot read. Storing part of it is the one outcome worse than failing:
      // the app would believe it is activated and send a bearer it cannot describe. `unreadable`
      // rather than `unknown` because the server accepted the code — the screen must not tell him
      // it is still good.
      return { ok: false, failure: 'unreadable', session: null, released: 0 };
    }

    // Before adopting: the cached site list belongs to whoever this phone was before.
    if (this.sessions.session()?.companyId !== session.companyId) {
      clearProjectCache();
    }

    this.sessions.adopt(session);

    // A store that will not open must not turn a good activation into a failed one. The phone is
    // activated either way; what is lost is the automatic release, and the pending screen's
    // "Pokušaj sve ponovo" still moves the same rows by hand.
    const released = await this.entries.releaseBlockedByAuth().catch(() => 0);

    // Released rows already nudge the loop through `watchOutboxBacklog()`; this covers the case
    // where nothing was released but the phone has ordinary queued work waiting on a credential.
    this.uploads.wake();

    // Fire and forget, deliberately. Awaiting a network call here would put a round trip between
    // a foreman and the record button — invariant 1, on the screen that leads straight to it.
    void this.projects.load().catch(() => undefined);

    return { ok: true, failure: null, session, released };
  }

  /**
   * Decision 14: he types his username alone and a fresh single-use code is emailed to him.
   *
   * The answer is uniform by design — 202 whether or not the username exists — so `ok` here means
   * "the request was accepted", never "an email is on its way to a real account". The screen's
   * sentence has to be written to match, or the app becomes the enumeration oracle the endpoint
   * refuses to be.
   */
  async requestCode(username: string): Promise<RequestCodeResult> {
    try {
      await this.gateway.requestActivationCode({ username: normaliseUsername(username) });
      return { ok: true, failure: null };
    } catch (error) {
      return { ok: false, failure: classify(error) };
    }
  }

  /**
   * Sign an admin in, and store the credential he just proved.
   *
   * ## Where it is stored, and where it deliberately is not
   *
   * In `AdminSessionService`, under its own `localStorage` key, **never in `SessionService`**.
   * `Session` describes a *device* bound to a worker — it carries a device id and a username, and
   * `API_CONFIG` hands its token to every `/api` call as this phone's bearer. Writing an admin
   * session token into that slot would make the app claim a device it does not have on the one
   * path where provenance ends up on an evidence row. Until F6 there was no second slot and this
   * method therefore stored nothing; the slot is the thing F6 added, and the separation is the
   * whole reason it is a second one rather than a wider first.
   *
   * ## Why an unreadable answer is a failure and not a partial sign-in
   *
   * Same rule as {@link activate}: a whole credential or none. A session token with no role would
   * have the app sending a bearer it cannot describe to a surface it cannot decide the shape of —
   * and unlike an activation, nothing is *spent* by a failed sign-in, so the honest thing costs
   * only a second attempt.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    let response: LoginResponse;
    try {
      response = await this.gateway.login({ email: normaliseEmail(email), password });
    } catch (error) {
      return { ok: false, failure: classify(error), role: null, displayName: null, adminSession: null };
    }

    const session = toAdminSession(response);
    if (!session) {
      // A 200 whose body this build cannot read. Nothing is spent by a sign-in, but the sentence
      // still has to say "the app could not read the answer" rather than invent a reason.
      return { ok: false, failure: 'unreadable', role: null, displayName: null, adminSession: null };
    }

    this.admins.adopt(session);

    return {
      ok: true,
      failure: null,
      role: session.role,
      displayName: session.displayName,
      adminSession: session,
    };
  }

  /**
   * Set a password from an invite or reset link.
   *
   * **It signs nobody in, and that is deliberate.** `POST /auth/password` revokes every existing
   * session for the account as part of setting the password — the reset path exists precisely for
   * the case where somebody else may hold a credential — so adopting one here would be adopting a
   * session the server has just withdrawn. He signs in afterwards, with the passphrase he chose,
   * which is also the only proof that it is the one he meant to type.
   *
   * The address comes back so the login screen can be handed it. That is not a leak: the caller
   * has just proved he holds a single-use token issued for that account.
   */
  async setPassword(token: string, password: string): Promise<SetPasswordResult> {
    try {
      const response = await this.gateway.setPassword({ token, password });
      return { ok: true, failure: null, email: text(response?.email) };
    } catch (error) {
      return { ok: false, failure: classify(error), email: null };
    }
  }
}

/**
 * How choosing a passphrase went.
 *
 * `rejected` covers a token that is unknown, already used, superseded or expired — the server
 * answers all four identically, because which of them it was is an oracle about who has been
 * invited. The screen says one sentence and offers the one remedy that exists: ask for a new link.
 */
export interface SetPasswordResult {
  ok: boolean;
  failure: AuthFailure | null;
  /** His address, for the login form he is about to see. Null when the call failed. */
  email: string | null;
}

/**
 * The B3 taxonomy, reduced to the answers an auth screen can give.
 *
 * Reusing `classifyApiError` rather than reading statuses again is deliberate, and is the same
 * choice `ArchiveService` made: the rules about what a status *means* — status 0 is a network
 * failure and not the server's answer, every 5xx is the server being unwell — were settled at B3
 * and are binding. Two places deciding that independently is how two screens end up disagreeing
 * about whether the server is down.
 */
function classify(error: unknown): AuthFailure {
  const failure = classifyApiError(error);
  switch (failure.kind) {
    case 'offline':
      return 'offline';
    case 'server':
      // 429 is the rate limiter and it is the one "server" answer that is about *him*: waiting
      // five minutes fixes it, and no other sentence on this screen would tell him to wait.
      return failure.status === 429 ? 'tooManyAttempts' : 'server';
    case 'unauthenticated':
    case 'unauthorized':
      return 'rejected';
    case 'rejected':
      // 400/404/409/422 all land in `rejected`; only 404 means "there is no such route here".
      return failure.status === 404 ? 'notAvailable' : 'rejected';
    default:
      return 'unknown';
  }
}

/**
 * Every field, or nothing — the same rule `readStoredSession()` applies to what is on disk, for
 * the same reason. A half-recognised session is worse than none: the app would believe it is
 * activated and the failure would surface as a 401 on the upload path rather than as a screen
 * asking for a code.
 */
function toSession(response: ActivateResponse): Session | null {
  // Flat, and only flat. This read tolerated a nested `worker` object as well until F4's last
  // gating item closed — see `auth-types.ts` for why that tolerance existed and why removing it
  // had to wait for the server-side field-name pin.
  const token = text(response.device_token);
  const deviceId = text(response.device_id);
  const userId = text(response.user_id);
  const username = text(response.username);
  const displayName = text(response.display_name);
  const companyId = text(response.company?.id);
  const companyName = text(response.company?.name);

  if (!token || !deviceId || !userId || !username || !displayName || !companyId || !companyName) {
    return null;
  }

  return {
    token,
    deviceId,
    userId,
    username,
    displayName,
    companyId,
    companyName,
    // The server does not send this; it is what *this phone* remembers about when it was bound,
    // and it is only ever shown back to its owner.
    activatedAt: new Date().toISOString(),
  };
}

/**
 * Every field, or nothing — the same all-or-nothing rule {@link toSession} applies, for the same
 * reason. A role this build has never heard of resolves to `null` rather than to an `unknown`
 * member: the profile screen *describes* a person and can say "a role this app does not
 * recognise", while this value *authorises* a screen, and a screen is not something to open on a
 * word nobody understood.
 */
function toAdminSession(response: LoginResponse): AdminSession | null {
  const token = text(response.session_token);
  const expiresAt = text(response.expires_at);
  const role = text(response.role);
  const userId = text(response.user_id);
  const displayName = text(response.display_name);

  if (!token || !expiresAt || !userId || !displayName) {
    return null;
  }
  if (role !== 'company_admin' && role !== 'super_admin') {
    return null;
  }

  return {
    token,
    expiresAt,
    role,
    userId,
    displayName,
    // Null for a super admin by construction, and narrowed rather than required for exactly that
    // reason (§4, `ck_app_user_company_scope`).
    companyId: text(response.company?.id),
    companyName: text(response.company?.name),
    // The server does not send this; it is what this browser remembers about when it signed in.
    signedInAt: new Date().toISOString(),
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Lowercased and trimmed, matching the server's normalise-on-write discipline (§4).
 *
 * A phone keyboard capitalises the first letter of a field by default, so `Zoran.jovanovic` is
 * not a hypothetical — it is what a man typing his own username produces on his first try.
 */
function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Same rule, same reason: `ck_app_user_email_normalised` stores emails lowercased and trimmed. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * What the admin will see in his device list: "Android · Chrome", "iPhone · Safari".
 *
 * Not a user-facing string and deliberately not translated — it is a row in a device table an
 * admin reads and can rename, the same way `device.name` holds "Zoranov telefon" in §4. Derived
 * from the user agent, which is a guess; the point is that a company with four phones can tell
 * them apart at all, not that the guess is exact.
 */
export function describeDevice(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;

  const platform = /iPhone/i.test(agent)
    ? 'iPhone'
    : /iPad/i.test(agent)
      ? 'iPad'
      : /Android/i.test(agent)
        ? 'Android'
        : /Windows/i.test(agent)
          ? 'Windows'
          : /Macintosh|Mac OS/i.test(agent)
            ? 'Mac'
            : /Linux/i.test(agent)
              ? 'Linux'
              : 'Telefon';

  // Order matters: every Chromium browser also says "Safari", and Edge also says "Chrome".
  const browser = /Edg\//i.test(agent)
    ? 'Edge'
    : /OPR\/|Opera/i.test(agent)
      ? 'Opera'
      : /Firefox\//i.test(agent)
        ? 'Firefox'
        : /Chrome\//i.test(agent)
          ? 'Chrome'
          : /Safari\//i.test(agent)
            ? 'Safari'
            : null;

  return browser ? `${platform} · ${browser}` : platform;
}

/**
 * Forget the previous holder's site list.
 *
 * Both keys, together: `teren.projects` is another company's names and ids, and
 * `teren.selectedProjectId` points into it. Leaving the selection behind would file this man's
 * first recording against a site that belongs to someone else — the one failure
 * `legacy-project-ids.ts` was written to avoid, arriving by a different door.
 *
 * The in-memory selection needs no clearing: `ProjectService.selected` resolves a stored id
 * against the loaded list and falls back to the first site when it matches nothing, so the reload
 * that follows an activation settles it.
 */
function clearProjectCache(): void {
  try {
    localStorage.removeItem(PROJECT_CACHE_KEY);
    localStorage.removeItem(SELECTED_PROJECT_KEY);
  } catch {
    // Private mode. The list is refetched under the new credential anyway; what is lost is the
    // cached copy, which was going to be replaced.
  }
}
