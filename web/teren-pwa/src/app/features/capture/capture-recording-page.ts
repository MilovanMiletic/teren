import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { AppStatus } from '../../core/app-status.service';
import { EntryStore } from '../../core/db/entry-store';
import { AudioRecorderService, RecorderState } from '../../core/media/audio-recorder.service';
import { negotiateAudioMimeType } from '../../core/media/audio-mime';
import { GeolocationService } from '../../core/media/geolocation.service';
import { ProjectService } from '../../core/projects/project.service';
import { AppHeader } from '../../ui/app-header';
import { formatDuration } from '../../ui/duration.pipe';
import { Icon } from '../../ui/icon';

/** What is stopping this screen from recording, if anything. */
type Blocker = 'no-project' | 'no-storage' | null;

/**
 * Recording (`design/CaptureRecording.dc.html`).
 *
 * The rules that shape this screen:
 *
 * - **Audio is on disk before it is stopped.** The capture session is opened, and the entry id
 *   minted, before `MediaRecorder.start()`; every chunk is written as it arrives. Airplane mode
 *   changes nothing here, and neither does the tab being killed.
 * - **Leaving never destroys a take.** Navigating away — the back gesture included — stops the
 *   recording and keeps it as a draft. Only the explicit "Otkaži" throws a take away.
 * - **Every failure is a state.** Denial, a missing microphone, an interruption, a project that
 *   has not loaded, a store that will not open: each renders as an explainable card, and none of
 *   them loses anything.
 */
@Component({
  selector: 'app-capture-recording-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, Icon, TranslocoDirective],
  templateUrl: './capture-recording-page.html',
  styleUrl: './capture-recording-page.css',
})
export class CaptureRecordingPage implements OnDestroy {
  private readonly router = inject(Router);
  private readonly recorder = inject(AudioRecorderService);
  private readonly entries = inject(EntryStore);
  private readonly geolocation = inject(GeolocationService);
  private readonly projects = inject(ProjectService);
  private readonly status = inject(AppStatus);

  protected readonly project = this.projects.selected;
  protected readonly state = this.recorder.state;
  protected readonly levels = this.recorder.levels;
  protected readonly now = new Date();

  protected readonly elapsed = computed(() => formatDuration(this.recorder.elapsedMs()));
  protected readonly saving = signal(false);
  /** Shown when the recorder produced no usable audio — a mis-tap, not a failure of the app. */
  protected readonly tooShort = signal(false);
  /** Shown when assembling or saving the take failed; the chunks are still on disk. */
  protected readonly saveFailed = signal(false);
  /** Set once an interrupted take has been salvaged, so the user can open it. */
  protected readonly salvagedEntryId = signal<string | null>(null);

  /** Why recording cannot start, if it cannot. */
  protected readonly blocker = computed<Blocker>(() => {
    if (!this.status.storageAvailable()) {
      return 'no-storage';
    }
    return this.project() ? null : 'no-project';
  });

  /**
   * The entry id, generated the moment capture starts (PROJECT.md principle 3: the client UUID is
   * the idempotency key). Everything the recorder writes is keyed by it from the first chunk.
   */
  private entryId: string | null = null;
  private leaving = false;

  constructor() {
    // The recorder can lose the microphone at any moment — an incoming call, the OS reclaiming
    // the device. Whatever was captured is on disk; turn it into a draft and say so.
    effect(() => {
      if (this.state() === 'interrupted' && this.entryId && !this.salvagedEntryId()) {
        void this.salvageInterrupted();
      }
    });

    void this.begin();
  }

  ngOnDestroy(): void {
    // Leaving mid-recording — the back gesture, a route change, the app shell tearing down — must
    // keep the take. The chunks are already in the store, so this releases the microphone and
    // assembles them; if the page dies before that finishes, the start-up sweep does it instead.
    if (!this.leaving && (this.state() === 'recording' || this.state() === 'starting')) {
      const entryId = this.entryId;
      void (async () => {
        const finished = await this.recorder.stop();
        if (entryId) {
          await this.entries.finishCapture(entryId, { durationMs: finished?.durationMs });
        }
      })().catch(() => {
        // The screen is already gone, so there is nobody to tell. The chunks are still on disk
        // under this entry id and the next start-up sweep assembles them.
      });
    }
  }

  protected async begin(): Promise<void> {
    this.tooShort.set(false);
    this.saveFailed.set(false);
    this.salvagedEntryId.set(null);
    this.recorder.reset();

    const project = this.project();
    if (this.blocker() !== null || !project) {
      return;
    }

    const entryId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();
    const mimeType = negotiateAudioMimeType();

    try {
      // The session exists before the first byte does, so no chunk can arrive homeless.
      await this.entries.beginCapture({
        entryId,
        project,
        capturedAt,
        mimeType: mimeType ?? 'application/octet-stream',
      });
    } catch {
      this.status.reportStorageFailure();
      return;
    }

    this.entryId = entryId;
    const started = await this.recorder.start(entryId, mimeType);
    if (!started) {
      // Nothing was recorded, so the empty session is thrown away rather than left for the
      // start-up sweep to puzzle over.
      await this.entries.discardCapture(entryId);
      this.entryId = null;
      return;
    }

    // Location is nice-to-have evidence and must never delay or block the recording, so it is
    // fetched alongside it and simply stays null if it does not arrive.
    void this.geolocation
      .currentFix()
      .then((fix) => this.entries.setCaptureGeo(entryId, fix))
      .catch(() => undefined);
  }

  protected async stop(): Promise<void> {
    const entryId = this.entryId;
    if (this.saving() || !entryId) {
      return;
    }
    this.saving.set(true);
    this.saveFailed.set(false);

    try {
      const finished = await this.recorder.stop();
      const entry = await this.entries.finishCapture(entryId, {
        durationMs: finished?.durationMs,
      });

      if (!entry) {
        // Nothing was captured. Clear the session so the sweep does not trip over it, and let the
        // foreman try again — no data existed to lose.
        await this.entries.discardCapture(entryId);
        this.entryId = null;
        this.tooShort.set(true);
        return;
      }

      this.leaving = true;
      await this.router.navigate(['/unos', entry.id], { replaceUrl: true });
    } catch {
      // The chunks are still on disk under this entry id, so the retry below — or the next app
      // start — can still assemble them. Nothing is stranded.
      this.saveFailed.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  /** Try the assemble-and-save again after it failed. The audio never left the store. */
  protected async retrySave(): Promise<void> {
    const entryId = this.entryId;
    if (!entryId || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.saveFailed.set(false);
    try {
      const entry = await this.entries.finishCapture(entryId);
      if (entry) {
        this.leaving = true;
        await this.router.navigate(['/unos', entry.id], { replaceUrl: true });
      } else {
        this.tooShort.set(true);
      }
    } catch {
      this.saveFailed.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  /** Abandon the take. The only path that throws captured audio away, and it is explicit. */
  protected async cancel(): Promise<void> {
    this.leaving = true;
    this.recorder.cancel();
    const entryId = this.entryId;
    this.entryId = null;
    if (entryId) {
      await this.entries.discardCapture(entryId);
    }
    await this.router.navigate(['/'], { replaceUrl: true });
  }

  protected async leave(): Promise<void> {
    this.leaving = true;
    this.recorder.reset();
    await this.router.navigate(['/'], { replaceUrl: true });
  }

  protected async openSalvaged(): Promise<void> {
    const entryId = this.salvagedEntryId();
    if (entryId) {
      this.leaving = true;
      await this.router.navigate(['/unos', entryId], { replaceUrl: true });
    }
  }

  /** The translation key of the card explaining why recording is not happening. */
  protected problemKey(state: RecorderState, blocker: Blocker): string | null {
    if (blocker === 'no-storage') {
      return 'capture.blocked.storage';
    }
    if (blocker === 'no-project') {
      return 'capture.blocked.project';
    }
    switch (state) {
      case 'denied':
        return 'capture.mic.denied';
      case 'unavailable':
        return 'capture.mic.unavailable';
      case 'unsupported':
        return 'capture.mic.unsupported';
      case 'interrupted':
        return 'capture.mic.interrupted';
      case 'error':
        return 'capture.mic.error';
      default:
        return null;
    }
  }

  /** Retrying makes no sense where the browser or the store is the problem. */
  protected canRetry(state: RecorderState, blocker: Blocker): boolean {
    return blocker === null && state !== 'unsupported';
  }

  private async salvageInterrupted(): Promise<void> {
    const entryId = this.entryId;
    if (!entryId) {
      return;
    }
    await this.recorder.flush();
    const entry = await this.entries.finishCapture(entryId, {
      durationMs: this.recorder.lastDurationMs(),
    });
    if (entry) {
      this.salvagedEntryId.set(entry.id);
    } else {
      await this.entries.discardCapture(entryId);
    }
    this.entryId = null;
  }
}
