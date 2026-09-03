import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, VersionEvent } from '@angular/service-worker';

import { AudioRecorderService } from '../media/audio-recorder.service';

/**
 * Whether a newer build of the app is sitting on this device, waiting to be used.
 *
 * ## The problem it solves
 *
 * An installed PWA does not run new code because a deploy happened. The service worker downloads
 * the new bundle in the background and then keeps serving the old one until every tab of the app
 * has been **closed and reopened** — so the ordinary experience of a phone that lives on a home
 * screen and is never really shut is: the fix went out on Tuesday, the foreman gets it on Friday.
 * There was no `SwUpdate` handling anywhere in this app, so that was the shipped behaviour, and it
 * becomes visible the moment there is a server to deploy to.
 *
 * ## Why it is an offer and never an act
 *
 * Activating an update means reloading the page. This app's whole promise is that a recording in
 * progress is safe, and a reload during one destroys the only thing in the product that is *not*
 * on disk: the live `MediaRecorder`. Everything else survives — entries, chunks written a second
 * at a time, the outbox, a confirmation draft — because all of it is in Dexie before any of it is
 * anywhere else (PROJECT.md principle 3). **That is why the recorder is the one thing consulted
 * here and the store is not:** a queue of unsent days is exactly as safe after a reload as before,
 * while thirty seconds of speech is not.
 *
 * So: no automatic reload, ever; nothing on screen while the microphone is live; and a way to say
 * "not now" that is remembered until the *next* version is ready, because a card he has already
 * declined re-appearing on every navigation is the sort of thing that gets an app deleted.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  /**
   * Optional on purpose. `provideServiceWorker` supplies this even with `enabled: false`, but a
   * spec, or a bootstrap that drops the service worker, must not turn a missing
   * provider into a blank app. The whole feature is a convenience; none of it is load-bearing.
   */
  private readonly updates = inject(SwUpdate, { optional: true });
  private readonly recorder = inject(AudioRecorderService);
  private readonly document = inject(DOCUMENT);

  /** A new version is installed and waiting. Set once per version, never cleared by a dismissal. */
  private readonly waiting = signal(false);
  /** He said "not now" about the version currently waiting. */
  private readonly declined = signal(false);
  private readonly applying = signal(false);

  /**
   * Whether to put the card on screen.
   *
   * The recorder check is the load-bearing half. `starting` counts as busy as much as `recording`
   * does: the permission sheet is up, his attention is on it, and a card sliding in underneath is
   * both a distraction and — once he taps through — a reload over a live take.
   */
  readonly offered = computed(
    () => this.waiting() && !this.declined() && !this.busy() && !this.applying(),
  );

  private busy(): boolean {
    const state = this.recorder.state();
    return state === 'starting' || state === 'recording' || state === 'stopping';
  }

  constructor() {
    this.updates?.versionUpdates
      .pipe(takeUntilDestroyed())
      .subscribe((event: VersionEvent) => this.onVersionEvent(event));
  }

  /**
   * `VERSION_READY` and nothing else.
   *
   * `VERSION_DETECTED` means a download has started, which is not news anybody can act on, and
   * `VERSION_INSTALLATION_FAILED` is a diagnostic. Only `VERSION_READY` means there is a complete
   * newer app on this device that one reload away.
   */
  private onVersionEvent(event: VersionEvent): void {
    if (event.type !== 'VERSION_READY') {
      return;
    }
    // A *new* version resets a previous "not now": he declined the last one, not this one.
    this.declined.set(false);
    this.waiting.set(true);
  }

  /** Take the new version. Activates it, then reloads so the running tab is the new build. */
  async apply(): Promise<void> {
    if (this.applying()) {
      return;
    }
    this.applying.set(true);
    try {
      await this.updates?.activateUpdate();
    } catch {
      // The activation failed — a network blip mid-swap, or the worker went away. Nothing is
      // broken: the old build keeps running and the next start picks the new one up. Reloading
      // anyway is still correct and still safe, and is what the button promised.
    }
    this.reload();
  }

  /** Not now. Remembered until a newer version arrives. */
  decline(): void {
    this.declined.set(true);
  }

  /**
   * The reload itself, as its own method so a spec can watch it happen.
   *
   * jsdom's `location.reload` throws "Not implemented", so there is no way to assert on this
   * except by making it a seam. It is also the honest shape: this is the single line in the app
   * that throws the running page away.
   */
  protected reload(): void {
    this.document.defaultView?.location.reload();
  }
}
