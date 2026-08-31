import { Routes } from '@angular/router';

import {
  requiresCompanyAdmin,
  requiresDevice,
  requiresNoDevice,
} from './core/session/device.guard';

/**
 * **English paths, by founder decision (2026-08-30, F4b.)** Routes and query parameters are
 * identifiers, and CLAUDE.md already makes code, comments and docs English; the six Serbian paths
 * this table carried until F4b were the exception rather than the rule. Every word the foreman
 * *reads* still goes through Transloco and still defaults to Serbian — this is URLs only.
 *
 * Capture is its own route rather than a hidden state of home so the phone's back gesture means
 * "leave the recording", not "leave Teren", and so a reload on the saved screen comes back to the
 * entry that was just written instead of losing the thread.
 *
 * **Renaming a path here is never a local change.** Two consumers have no compiler between them
 * and this table: `capture-recording-page.ts` navigates to the saved screen by literal segment,
 * and `rescue.service.ts` parses `location.pathname` to work out which entry is open. A mismatch
 * builds clean and passes type-check; at runtime the wildcard below quietly redirects the foreman
 * to Home and his open draft stops being exempt from the abandoned-draft sweep. Both couplings
 * are pinned by specs that derive the path from this array (`app.spec.ts`,
 * `core/rescue.service.spec.ts`, `features/capture/capture-recording-page.spec.ts`) — rename a path
 * without its consumer and those go red. Keep it that way.
 *
 * **The gate (F4)** is `canMatch` and not `canActivate`, so an un-activated phone never fetches
 * the lazy chunk of a screen it may not see. `device.guard.ts` holds the reasoning; the shape of
 * the decision is here, in the table, where a new route has to say which side of it it is on.
 * `app.routes.spec.ts` fails on a route that declares neither.
 */
export const routes: Routes = [
  {
    path: '',
    /*
     * **`pathMatch: 'full'` is load-bearing, not tidiness.** Angular runs a route's `canMatch`
     * guards as part of *matching* it, before it works out that a leaf route with an empty path
     * has left segments unconsumed. So without this, `requiresDevice` runs on the way to every
     * URL in the app — and on an un-activated phone it answers with a redirect to `/welcome`,
     * which restarts matching, which runs it again: an infinite redirect that hangs the router
     * with a blank screen and no error. It cost an afternoon to find, and it is invisible in
     * every diff that does not navigate.
     */
    pathMatch: 'full',
    canMatch: [requiresDevice],
    loadComponent: () => import('./features/home/home-page').then((m) => m.HomePage),
  },
  {
    path: 'record',
    canMatch: [requiresDevice],
    loadComponent: () =>
      import('./features/capture/capture-recording-page').then((m) => m.CaptureRecordingPage),
  },
  {
    path: 'entry/:entryId',
    canMatch: [requiresDevice],
    loadComponent: () =>
      import('./features/capture/capture-saved-page').then((m) => m.CaptureSavedPage),
  },
  {
    /*
     * The confirmation gate (B5). A route of its own, and a path segment rather than a query
     * parameter — unlike the archive, which pairs a list with a record on one screen. This is a
     * single-entry screen with a form in it: the phone's back gesture must mean "leave this
     * entry", a reload must come back to the same one, and nothing else on screen depends on it.
     */
    path: 'confirm/:entryId',
    canMatch: [requiresDevice],
    loadComponent: () => import('./features/confirm/confirm-page').then((m) => m.ConfirmPage),
  },
  {
    /*
     * The archive. One route, not two: the open record is `?entry=<id>` rather than a path
     * segment, because two sibling route configs would rebuild the whole screen on every click
     * in the desktop list rail. `ArchivePage` explains the choice in full.
     *
     * That parameter is the one piece of the URL this table cannot pin, so it is named once in
     * `core/archive/archive-route.ts` (`ARCHIVE_ENTRY_PARAM`) and imported by both the three
     * screens that write it and the one that reads it. `app.routes.spec.ts` fails on any
     * navigation that spells a query parameter out as a literal instead.
     */
    path: 'diary',
    canMatch: [requiresDevice],
    loadComponent: () => import('./features/archive/archive-page').then((m) => m.ArchivePage),
  },
  {
    path: 'pending',
    canMatch: [requiresDevice],
    loadComponent: () => import('./features/pending/pending-page').then((m) => m.PendingPage),
  },
  {
    /*
     * His own account (F5): name, username, company, phone, language.
     *
     * Gated like every other screen inside the app, and **before** the wildcard. It is not an
     * auth screen — a man with no credential has no profile to read — but neither is it a locked
     * door: the guard asks only whether this phone holds a session, never whether the server
     * still accepts it (decision 8), so a revoked device opens this screen and reads the sentence
     * that says the server would not confirm it.
     */
    path: 'profile',
    canMatch: [requiresDevice],
    loadComponent: () => import('./features/profile/profile-page').then((m) => m.ProfilePage),
  },
  /*
   * Identity (F3). Already English when they landed; the six paths above joined them at F4b.
   *
   * Registered **before** the wildcard, and this is load-bearing rather than tidy: `'**' →
   * redirectTo: ''` re-runs matching, so a route declared after it is never reached — and the
   * redirect target `''` is itself gated, which is what sends a mistyped URL on an un-activated
   * phone to Welcome rather than to a Home it may not see.
   */
  {
    path: 'welcome',
    canMatch: [requiresNoDevice],
    loadComponent: () => import('./features/auth/welcome-page').then((m) => m.WelcomePage),
  },
  {
    /*
     * The re-activation door, and **the one route with no guard at all** (F4). It has to keep
     * working while a session exists, because the phone that needs it most is one whose
     * credential the server has already revoked: `requiresNoDevice` here would lock a revoked
     * foreman out of the only screen that can let him back in.
     */
    path: 'activate',
    loadComponent: () => import('./features/auth/activate-page').then((m) => m.ActivatePage),
  },
  {
    path: 'login',
    canMatch: [requiresNoDevice],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    /*
     * The office (F6): his foremen, their activation codes, their phones, and revoke.
     *
     * The **one route in the table gated on something other than this phone's device session**.
     * `requiresCompanyAdmin` reads the admin credential a password sign-in wrote, which is a
     * different key, a different bearer and a different lifetime from the device token — see
     * `core/session/admin-session.ts` for why the two must never become one. It is also the route
     * that most obviously has to sit before the wildcard: a company admin has no device session at
     * all, so `'**' → redirectTo: ''` would send him to Home, whose own guard would send him to
     * Welcome, and the app would answer a valid sign-in with a screen asking him for a code he
     * cannot have.
     */
    path: 'company',
    canMatch: [requiresCompanyAdmin],
    loadComponent: () => import('./features/company/company-page').then((m) => m.CompanyPage),
  },
  { path: '**', redirectTo: '' },
];
