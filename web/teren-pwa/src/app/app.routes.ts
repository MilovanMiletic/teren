import { Routes } from '@angular/router';

/**
 * Serbian paths, because the address bar is part of the UI on a phone and this product speaks
 * Serbian. Capture is its own route rather than a hidden state of home so the phone's back
 * gesture means "leave the recording", not "leave Teren", and so a reload on the saved screen
 * comes back to the entry that was just written instead of losing the thread.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/home/home-page').then((m) => m.HomePage),
  },
  {
    path: 'snimanje',
    loadComponent: () =>
      import('./features/capture/capture-recording-page').then((m) => m.CaptureRecordingPage),
  },
  {
    path: 'unos/:entryId',
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
    path: 'potvrda/:entryId',
    loadComponent: () => import('./features/confirm/confirm-page').then((m) => m.ConfirmPage),
  },
  {
    /*
     * The archive. One route, not two: the open record is `?unos=<id>` rather than a path
     * segment, because two sibling route configs would rebuild the whole screen on every click
     * in the desktop list rail. `ArchivePage` explains the choice in full.
     */
    path: 'dnevnik',
    loadComponent: () => import('./features/archive/archive-page').then((m) => m.ArchivePage),
  },
  {
    path: 'cekaju',
    loadComponent: () => import('./features/pending/pending-page').then((m) => m.PendingPage),
  },
  /*
   * Identity (F3). **English paths, by founder decision (2026-08-30)**: routes are code, and
   * CLAUDE.md already makes code, comments and docs English. Every word the foreman *reads* still
   * goes through Transloco and still defaults to Serbian; this changes URLs, nothing else. The
   * six Serbian paths above are renamed in F4b — deliberately its own increment, because
   * `rescue.service.ts` parses `location.pathname` to work out which entry is open and a rescue
   * that silently stops recognising the confirm screen surfaces a week later as "the app lost my
   * recording".
   *
   * **No guard on any of them in this increment.** They are reachable by typing the URL and by
   * nothing else, so the distributor's demo is byte-identical; F4 adds the `canMatch` gate.
   *
   * Registered **before** the wildcard: `'**' → redirectTo: ''` re-runs matching, so a route
   * declared after it is never reached.
   */
  {
    path: 'welcome',
    loadComponent: () => import('./features/auth/welcome-page').then((m) => m.WelcomePage),
  },
  {
    /*
     * The re-activation door. It must keep working while a session exists — a revoked device is
     * exactly the phone that needs it — so when the gate lands at F4 this route stays unguarded.
     */
    path: 'activate',
    loadComponent: () => import('./features/auth/activate-page').then((m) => m.ActivatePage),
  },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  { path: '**', redirectTo: '' },
];
