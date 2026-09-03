import { inject } from '@angular/core';
import { CanMatchFn, Router, UrlTree } from '@angular/router';

import { AdminSessionService } from './admin-session.service';
import { RETURN_URL_PARAM, safeReturnUrl } from './return-url';
import { SessionService } from './session.service';

/**
 * The gate (`plans/profile-and-identity.md` §10.3).
 *
 * ## Three shapes this could have had, and why it has this one
 *
 * **`canMatch`, not `canActivate`.** `canMatch` runs *before* the lazy chunk is fetched, so an
 * un-activated phone on 2G never downloads Home's bundle to be told it may not see it. It also
 * means a refused route falls through to the rest of the table rather than aborting the
 * navigation, which is what makes the wildcard behave — see below.
 *
 * **Not an `@if` in the shell.** `app.ts` is a bare `<router-outlet/>` on purpose. Swapping the
 * rendered screen while leaving the address bar saying `/confirm/<id>` would make the URL lie,
 * and `rescue.service.ts` reads `location.pathname` to decide which entry a foreman currently has
 * open and must therefore be exempt from the abandoned-draft sweep. A lying URL there is a
 * recording quietly force-queued mid-composition.
 *
 * **A pure boolean over one signal read.** `SessionService` reads the credential from
 * `localStorage` during construction, so this guard awaits nothing and calls nothing. That is
 * hazard H3 in the plan and invariant 1 in PROJECT.md: an activated phone renders the record
 * button on the first frame, in a basement, with the radio off. Anyone tempted to make this
 * `async` — to ask `/api/me` whether the credential is still good, say — should read
 * `device.guard.spec.ts`, which fails on the shape of the return value for exactly that reason.
 *
 * ## What is deliberately *not* checked here, and what changed on 2026-09-03
 *
 * **Revocation, still.** This guard reads one `localStorage` row and asks the server nothing — an
 * `async` guard on this path is hazard H3, and it would put a network round trip in front of the
 * record button.
 *
 * What it used to mean, and no longer does, is that *nothing* shut the door. This comment said "a
 * revoked device keeps its session and keeps reaching the record button... revocation surfaces as
 * a notice on Home and the pending screen (F8), never as a locked door", on the reasoning that a
 * foreman whose admin fat-fingered a revoke at four in the afternoon must still capture the day.
 * **The founder reversed that on 2026-09-03** — he revoked a worker's phone from
 * `/company/worker/:workerId`, watched the phone carry on as if nothing had happened, was offered
 * the milder policies with that reasoning stated, and chose a full sign-out. It is a decision, not
 * drift.
 *
 * So the door *is* shut now, and this guard is still not the thing that shuts it. A refusal is a
 * fact only the server holds; it reaches the phone as a 401 on the next contact, and
 * `core/session/device-refusal.service.ts` acts on it by discarding the credential. One frame
 * later this guard answers "no session" and behaves exactly as it always has. **Nothing local is
 * deleted** — PROJECT.md principle 3 is untouched, the unsent day waits on the phone, and
 * re-activating as the same worker sets it moving again.
 */

/**
 * Everything that is not an auth screen: the record button, the archive, the queue.
 *
 * An un-activated phone is sent to `/welcome` carrying the URL it was trying to reach, so a link
 * to one entry survives an activation instead of dumping the man on Home to find it himself.
 */
export const requiresDevice: CanMatchFn = (): true | UrlTree => {
  const sessions = inject(SessionService);
  if (sessions.activated()) {
    return true;
  }

  const router = inject(Router);
  // `getCurrentNavigation()` and not the `segments` argument: `CanMatchFn` is handed the path
  // segments alone, with no query string, and the archive opens a record as `?entry=<id>`. A
  // `next` built from segments would return a foreman to the list every time.
  const attempted = router.getCurrentNavigation()?.extractedUrl;
  // Validating what *this app* is about to write is redundant today — an in-app navigation the
  // router already parsed cannot be `//evil.com` — and it stays anyway, because the value it
  // produces then travels through a URL bar, Welcome and Login before anything navigates to it.
  // **It is not a guarantee any consumer may lean on:** `safeReturnUrl` is applied again at every
  // read (`requiresNoDevice` below, `welcome-page.ts`, `login-page.ts`, `activate-page.ts`), and
  // those are the checks that matter, because the parameter arrives from outside far more often
  // than it arrives from here. Do not simplify a reader on the strength of this line.
  const next = attempted ? safeReturnUrl(router.serializeUrl(attempted)) : null;

  return router.createUrlTree(
    ['/welcome'],
    next ? { queryParams: { [RETURN_URL_PARAM]: next } } : {},
  );
};

/**
 * `/login`: the password door, for anybody who is not already through it.
 *
 * ## Why this is not `requiresNoDevice`, which is what guarded it until 2026-09-01
 *
 * **A browser is not a phone.** `requiresNoDevice` answers "does this browser hold a *device*
 * session", and it guarded `/login` on the reasoning that an activated phone belongs to a foreman,
 * who has no password. That reasoning is sound about a foreman and wrong about the machine this
 * product is actually administered from: the founder's browser is the demo phone **and** the
 * platform console at the same time, and on it every door to a password sign-in was shut.
 *
 * The failure was total and silent. `/login` bounced to Home; `/welcome`, which is where the only
 * "sign in" link lives, bounced to Home for the same reason; `session-link.ts` renders nothing at
 * all for a browser with a device session; and `/platform` answers an activated device with a
 * redirect to Home, so even typing the URL did not help. **Every route into the admin and platform
 * surfaces was closed, and no spec noticed, because each guard is individually correct.** That is
 * what "the pages aren't wired in" meant, and it was never about the pages.
 *
 * A foreman who follows a stale link now sees the login screen rather than being bounced off it.
 * That screen was built for him — `login-page.ts` carries the join-by-code path in plain sight for
 * exactly this man — and a door he does not need is a far smaller harm than a door the
 * administrator cannot open.
 *
 * ## The question it asks instead, and the loop it must not create
 *
 * Only "is somebody already signed in here". If so he is sent to **his own surface**, decided by
 * his role — and **never to `?next=`**, which is the one detail here that is load-bearing. A super
 * admin arriving at `/login?next=/company` would otherwise be forwarded to `/company`, which
 * `requiresCompanyAdmin` answers with `/login?next=/company`, for ever: a blank screen and no
 * error, the same infinite-redirect shape `pathMatch: 'full'` exists to prevent on Home. A stale
 * deep link is worth less than a screen that loads.
 *
 * Still a pure boolean over one signal read, for the reason the file comment gives.
 */
export const requiresNoAdminSession: CanMatchFn = (): true | UrlTree => {
  const role = inject(AdminSessionService).role();
  if (role === null) {
    return true;
  }

  // His own surface. `role()` applies the session's expiry, so an expired admin falls into the
  // branch above and gets the form rather than a redirect to a screen full of 401s.
  return inject(Router).parseUrl(role === 'super_admin' ? '/platform' : '/company');
};

/**
 * Welcome: the screen that only makes sense before this phone belongs to anyone.
 *
 * An activated worker who follows a stray link — a shared URL, a bookmark from the day he joined
 * — must never be shown a sign-in screen for a sign-in he does not have and cannot perform. He is
 * sent on to wherever the link said he was going, or to the record button.
 *
 * `/activate` is deliberately **not** guarded by this: it is the re-activation door, and it has to
 * open for a phone that still holds a session. Until 2026-09-03 the phone that needed it most was
 * one holding a session the server had already revoked; since the sign-out decision that phone
 * arrives here with no session at all and would be admitted anyway. The rule stands for the case
 * that remains — a working phone being handed to another worker, and a man who taps the pending
 * screen's "Unesi novi kod" before the next 401 has landed. `/login` is no longer guarded by this
 * either — see {@link requiresNoAdminSession} for the day that cost.
 *
 * **This now guards exactly one route.** Keep it that way, or read that comment first: the
 * question it asks is about a *phone*, and only Welcome is a screen about a phone.
 */
export const requiresNoDevice: CanMatchFn = (): true | UrlTree => {
  const sessions = inject(SessionService);
  if (!sessions.activated()) {
    return true;
  }

  const router = inject(Router);
  const attempted = router.getCurrentNavigation()?.extractedUrl;
  const next = safeReturnUrl(attempted?.queryParams[RETURN_URL_PARAM]);

  // `parseUrl`, not `createUrlTree(['/…'])`: the return URL is a whole URL and may carry the
  // archive's `?entry=<id>`, which a segment array would drop.
  return router.parseUrl(next ?? '/');
};

/**
 * `/company`: the office surface, for a signed-in **company admin** and nobody else (F6).
 *
 * ## Three ways to be turned away, and why they are not one way
 *
 * **A worker's phone goes to Home, not to the login screen.** This is the branch that matters, and
 * it is not politeness — it is the only arrangement that does not loop. `/login` is guarded by
 * {@link requiresNoDevice}, which sends an *activated* phone straight back to wherever `?next=`
 * says. Answering an activated worker with `/login?next=/company` would therefore bounce him to
 * `/company`, which would answer with `/login?next=/company`, for ever, with a blank screen and no
 * error — the same infinite-redirect shape `pathMatch: 'full'` exists to prevent on Home. A
 * foreman who taps a stale link belongs at the record button anyway.
 *
 * **Nobody signed in goes to `/login`, carrying where he was going.** He has no device session, so
 * `requiresNoDevice` admits him, and a successful sign-in as a company admin follows `?next=`
 * back here.
 *
 * **A super admin signed in also goes to `/login`.** He has no company by construction
 * (`ck_app_user_company_scope`), so there is nothing on this screen for him to see, and his own
 * surface is F7. The login screen is where he can sign in as somebody who does have one; it does
 * not loop, because nothing there redirects on the strength of an *admin* session.
 *
 * ## Still a pure boolean over one signal read
 *
 * `AdminSessionService` reads the credential from `localStorage` during construction and applies
 * the session's own expiry, so this awaits nothing and calls nothing — hazard H3, which is about
 * the record button but is not made less true by the screen being an admin's. Anyone tempted to
 * ask `/api/me` whether the role is still what it was should note that the server asks that
 * question itself on every request this screen makes, and answers `403` in the one place that is
 * allowed to.
 */
export const requiresCompanyAdmin: CanMatchFn = (): true | UrlTree => {
  const admins = inject(AdminSessionService);
  if (admins.isCompanyAdmin()) {
    return true;
  }

  const router = inject(Router);

  // A foreman's phone. Home, not a sign-in screen he has no password for — and see above for why
  // any other answer is an infinite redirect rather than merely a discourtesy.
  if (inject(SessionService).activated()) {
    return router.parseUrl('/');
  }

  const attempted = router.getCurrentNavigation()?.extractedUrl;
  const next = attempted ? safeReturnUrl(router.serializeUrl(attempted)) : null;

  return router.createUrlTree(
    ['/login'],
    next ? { queryParams: { [RETURN_URL_PARAM]: next } } : {},
  );
};

/**
 * `/platform` — Teren's own surface, for Teren's own staff (F7).
 *
 * The twin of {@link requiresCompanyAdmin}, and it answers the same three ways for the same
 * reasons:
 *
 * - **A foreman's phone goes to Home**, not to a sign-in screen he has no password for. He cannot
 *   have one: `ck_app_user_worker_has_no_password` makes it unstorable.
 * - **A company admin goes to `/login`** carrying where he was. He may not see this surface — the
 *   server would refuse him with a 403 from `RoleFilter` — and `/login` is where he can sign in as
 *   somebody who may. It does not loop: nothing on the login screen redirects on the strength of
 *   an *admin* session, and `requiresNoDevice` admits him.
 * - **Anyone else goes to `/login`** with `?next=`, so a deep link survives the round trip.
 *
 * **Not "company admin or better".** The roles are not a hierarchy: a super admin has no company
 * and is refused by every evidence route on purpose, so a gate written as a rank would be the
 * first step towards Teren staff reading a customer's diary. Two questions, asked separately.
 *
 * Still a pure boolean over one signal read — `AdminSessionService` reads the credential from
 * `localStorage` during construction and applies the session's own expiry, so this awaits nothing.
 */
export const requiresSuperAdmin: CanMatchFn = (): true | UrlTree => {
  const admins = inject(AdminSessionService);
  if (admins.isSuperAdmin()) {
    return true;
  }

  const router = inject(Router);

  if (inject(SessionService).activated()) {
    return router.parseUrl('/');
  }

  const attempted = router.getCurrentNavigation()?.extractedUrl;
  const next = attempted ? safeReturnUrl(router.serializeUrl(attempted)) : null;

  return router.createUrlTree(
    ['/login'],
    next ? { queryParams: { [RETURN_URL_PARAM]: next } } : {},
  );
};
