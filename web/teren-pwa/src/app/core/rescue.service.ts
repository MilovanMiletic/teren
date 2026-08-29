import { DestroyRef, Injectable, inject } from '@angular/core';

import { AppStatus } from './app-status.service';
import { EntryStore } from './db/entry-store';

/**
 * Picks up after every interruption the web platform can inflict.
 *
 * There is no background upload and no guarantee a tab lives long enough to finish what it
 * started (ARCHITECTURE.md §11), so the app assumes it was killed mid-sentence and checks: is
 * there a recording whose chunks were never assembled, or a draft nobody came back to? It runs at
 * start and again whenever the app returns to the front — the moment a discarded tab is revisited
 * is exactly when the evidence needs rescuing.
 *
 * The entry whose screen is open is always exempt. A foreman standing on the saved screen picking
 * photos has not abandoned anything, no matter how long his phone was in his pocket.
 */
@Injectable({ providedIn: 'root' })
export class RescueService {
  private readonly entries = inject(EntryStore);
  private readonly status = inject(AppStatus);
  private running: Promise<void> = Promise.resolve();

  /** Start listening for the app coming back to the front. Called once, at bootstrap. */
  watch(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void this.run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  }

  /**
   * Sweep once. Never rejects: a rescue that cannot run must degrade to "nothing was rescued",
   * never to a broken app — the data it failed to reach is still on disk for the next attempt.
   */
  run(): Promise<void> {
    this.running = this.running
      .then(() => this.entries.rescue({ except: openEntryIds() }))
      .then(() => undefined)
      .catch(() => {
        this.status.reportStorageFailure();
      });
    return this.running;
  }
}

/** The entry the user is looking at right now, read from the URL (`/unos/:entryId`). */
export function openEntryIds(pathname = typeof location === 'undefined' ? '' : location.pathname) {
  const match = /^\/unos\/([^/?#]+)/.exec(pathname);
  return match ? [decodeURIComponent(match[1])] : [];
}
