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
  { path: '**', redirectTo: '' },
];
