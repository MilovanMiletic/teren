import { Injectable, signal } from '@angular/core';

import {
  AdminSession,
  clearAdminSession,
  hasExpired,
  persistAdminSession,
  readStoredAdminSession,
} from './admin-session';

/**
 * Who is signed in to the office surface in this browser, as far as the server is concerned.
 *
 * ## It injects nothing, exactly like `SessionService`
 *
 * Not a coincidence and not symmetry for its own sake: the gateway that sends this token depends
 * on this service, so a dependency back into the API layer would be a cycle. Orchestration — the
 * `POST /auth/login` call, deciding where a signed-in admin goes next — lives in
 * `ActivationService`, which is free to inject whatever it likes and writes the result here
 * through {@link adopt}.
 *
 * ## The read is synchronous, and must stay that way
 *
 * The credential is read from `localStorage` **during construction**, so `requiresCompanyAdmin`
 * (`device.guard.ts`) is a pure boolean over one signal read: no awaited promise, no network call,
 * no frame in which the app does not know who it is. `/api/me` would answer the same question more
 * authoritatively and is not allowed to, for the reason hazard H3 gives — a guard that awaits the
 * network is a guard that hangs when the network does.
 *
 * ## Signing out removes one `localStorage` row, and the worker's twin now does the same
 *
 * This file used to say a sign-out was real "here, and only here", because there was no worker
 * sign-out at all (PROJECT.md principle 3: a day of unsent evidence outranks a wrong name on a
 * screen). **That changed by founder decision on 2026-09-03**: a phone whose credential the server
 * refuses discards it through `SessionService.discard`, which is this method's twin and carries the
 * identical guarantee.
 *
 * What has not changed is the asymmetry that matters. This is a password-backed credential, often
 * on a shared office tablet, guarding no local evidence at all, and a person chooses to end it;
 * over there the *server* ends it and the phone is full of evidence. Either way {@link signOut}
 * removes exactly one `localStorage` row. **It must never touch Dexie**, and there is nothing in
 * this file that could.
 */
@Injectable({ providedIn: 'root' })
export class AdminSessionService {
  private readonly state = signal<AdminSession | null>(readStoredAdminSession());

  /**
   * The stored session, for the screens that name the admin or his company.
   *
   * **A description, not an authorisation.** Expiry is deliberately not applied here — a signal
   * cannot recompute because a clock moved — so every question of the form "may he" goes through
   * the methods below, which read the clock at the moment they are asked. A screen can only be
   * looking at this after the gate has already answered one of those.
   */
  readonly session = this.state.asReadonly();

  /**
   * The bearer to send, or `''` when nobody is signed in.
   *
   * There is **no build-time fallback** here, unlike `SessionService.token()`. The demo device
   * token in `environment.ts` is a *device* credential bound to a worker; handing it to an admin
   * route would produce a 403 from `RoleFilter` and a screen full of "you may not do this" for a
   * man who simply is not signed in. An empty string is the honest answer and the gateway reports
   * it as `not_configured`.
   */
  token(): string {
    return this.current()?.token ?? '';
  }

  /** The role the server reported at sign-in, or `null` when nobody is signed in. */
  role(): AdminSession['role'] | null {
    return this.current()?.role ?? null;
  }

  /** Whether anyone is signed in to the office surface at all. */
  signedIn(): boolean {
    return this.current() !== null;
  }

  /**
   * The route gate's single question: may this browser open `/company`?
   *
   * A method rather than a `computed`, deliberately. Expiry is a function of the clock, and a
   * computed signal would cache an answer that was true when the session was adopted and stay
   * true for thirty days of wall-clock time whether or not the token still worked. This is read
   * at navigation time, when the answer is actually needed.
   */
  isCompanyAdmin(): boolean {
    return this.current()?.role === 'company_admin';
  }

  /**
   * The other route gate's single question: may this browser open `/platform`?
   *
   * A method rather than a `computed`, for the reason above — and the two are deliberately
   * separate questions rather than one `role()` comparison at the call site, because the roles are
   * not a hierarchy. **A super admin is not a company admin with more.** He has no company by
   * construction (`ck_app_user_company_scope`), so `/company` has nothing on it for him, and the
   * evidence routes refuse him by design (`RoleGates.Evidence`). Writing this as "at least
   * company_admin" would be the first step towards a super admin who can read diaries.
   */
  isSuperAdmin(): boolean {
    return this.current()?.role === 'super_admin';
  }

  /**
   * The live session, with an expired one resolved to `null`.
   *
   * **It reads and never writes.** Clearing the stored row from here would be a signal write on a
   * path the template calls during change detection, which Angular is right to complain about; the
   * expired row is dropped where dropping it is free instead — `readStoredAdminSession()` refuses
   * it on the next construction, and a sign-out removes it outright. What matters is that no
   * caller can ever be handed a credential the server would refuse on grounds of time.
   */
  private current(): AdminSession | null {
    const session = this.state();
    return session && !hasExpired(session) ? session : null;
  }

  /**
   * Take on a credential. Persisted first, then published: a signal update that outlived the write
   * would leave the app believing it is signed in in a way that does not survive the next reload.
   */
  adopt(session: AdminSession): void {
    persistAdminSession(session);
    this.state.set(session);
  }

  /** Forget the credential. Touches `localStorage` and nothing else — never Dexie, never evidence. */
  signOut(): void {
    clearAdminSession();
    this.state.set(null);
  }
}
