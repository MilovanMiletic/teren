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

/**
 * The entry the user is looking at right now, read from the URL.
 *
 * **This is a hard coupling to `app.routes.ts` and it has no compiler to protect it.** The saved
 * screen is `entry/:entryId` (it was `unos/:entryId` until F4b). Rename the route without
 * touching this line and nothing fails to build — a foreman standing on the saved screen picking
 * photos simply stops being exempt, and his draft gets swept out from under him. That surfaces a
 * week later as "the app lost my recording", which is the worst bug this product can have. It is
 * not hypothetical: the F4 back-out left this regex on `/entry/` while the table still said
 * `unos/:entryId`, so the exemption was dead on main and no spec noticed.
 *
 * The only thing keeping this pattern honest is therefore a spec that *derives* the path from the
 * route table by component identity rather than restating it — `rescue.service.spec.ts` via
 * `testing/route-table.ts`. Hardcoded strings on both sides do not count: they agree with each
 * other while both disagree with the app.
 *
 * Read from `location.pathname` rather than from the router on purpose: this runs at bootstrap,
 * before the first navigation has resolved, and it must answer synchronously.
 */
export function openEntryIds(pathname = typeof location === 'undefined' ? '' : location.pathname) {
  const match = /^\/entry\/([^/?#]+)/.exec(pathname);
  return match ? [decodeURIComponent(match[1])] : [];
}
