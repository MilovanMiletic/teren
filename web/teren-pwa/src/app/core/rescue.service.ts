import { DestroyRef, Injectable, inject } from '@angular/core';

import { AppStatus } from './app-status.service';
import { EntryStore } from './db/entry-store';
import { AudioRecorderService } from './media/audio-recorder.service';

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
 *
 * ## And so is the take being recorded *right now* — which it was not until 2026-09-02
 *
 * This runs on `visibilitychange → visible`, and until that date the only exemption was the URL
 * of the saved screen. So every return to the foreground while the microphone was live — a
 * notification pulled down and dismissed, a screen lock, a glance at the clock, the phone handing
 * the tab back after the camera — swept the live capture: `finishCapture` assembled the chunks
 * recorded *so far* and deleted the session, after which every further chunk hit `appendChunk`'s
 * "no session, do nothing" branch and was dropped while the timer went on climbing. **Proven
 * against the production build: a six-second take with one tab switch at 2.5 s saved 2.2 s of
 * audio and told the foreman it had six.**
 *
 * There are two independent defences now, because this is the worst class of bug this product can
 * have and one guard is one edit away from being gone:
 *
 * 1. **Here** — {@link exempt} names the recorder's live capture alongside the open entry.
 * 2. **In the store** — `EntryStore.rescue` refuses to assemble a capture whose last chunk
 *    arrived seconds ago, whatever it was told to exempt. A recording that is still producing
 *    audio is not an orphan, and a sweep reached by some other path cannot take it either.
 */
@Injectable({ providedIn: 'root' })
export class RescueService {
  private readonly entries = inject(EntryStore);
  private readonly status = inject(AppStatus);
  /**
   * Read for one thing only: which capture is live. The recorder is the one place that knows,
   * because the URL does not — the recording screen is `/record` for every take, and a foreman
   * who left it mid-recording (the back gesture) has a take still being flushed on a URL that
   * says Home.
   */
  private readonly recorder = inject(AudioRecorderService);
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
      .then(() => this.entries.rescue({ except: this.exempt() }))
      .then(() => undefined)
      .catch(() => {
        this.status.reportStorageFailure();
      });
    return this.running;
  }

  /**
   * The entries this sweep may not touch: the one whose screen is open, and the one the
   * microphone is filling.
   *
   * Read at the moment the sweep runs rather than when it was scheduled — `run()` queues behind
   * whatever pass is already in flight, and a recording may well have started in between.
   *
   * `AudioRecorderService.entryId` is null whenever no capture is on disk (it is cleared with the
   * device), so a finished take does not stay exempt for the life of the tab. That matters: this
   * list is also handed to the abandoned-draft sweep, and a stale id there would quietly stop a
   * forgotten draft from ever reaching the queue.
   */
  private exempt(): string[] {
    const recording = this.recorder.entryId();
    const open = openEntryIds();
    return recording === null ? open : [...open, recording];
  }
}

/**
 * The entry the user is looking at right now, read from the URL.
 *
 * **This is half of the exemption and never all of it.** A URL names an entry only on the saved
 * screen; the recording screen is `/record` for every take and carries no id at all, so the take
 * in progress is exempted from the recorder instead — see {@link RescueService.exempt}. Reading
 * this function's answer as "everything that must not be swept" is precisely the mistake that
 * truncated live recordings until 2026-09-02.
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
