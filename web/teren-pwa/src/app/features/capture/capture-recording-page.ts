import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { AppStatus } from '../../core/app-status.service';
import { EntryStore } from '../../core/db/entry-store';
import { AudioRecorderService, RecorderState } from '../../core/media/audio-recorder.service';
import { negotiateAudioMimeType } from '../../core/media/audio-mime';
import { GeolocationService } from '../../core/media/geolocation.service';
import { ProjectService } from '../../core/projects/project.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { formatDuration } from '../../ui/duration.pipe';
import { Icon } from '../../ui/icon';

/** What is stopping this screen from recording, if anything. */
type Blocker = 'no-project' | 'no-storage' | null;

/**
 * How far the rescue of an interrupted take has got.
 *
 * The screen may not offer *any* action while this is unresolved: "Pokušaj ponovo" starts a new
 * recording, and offering it over chunks that have not yet become a draft would strand the take
 * the foreman just lost behind a screen he has no route back to.
 */
type SalvageState =
  /** Not interrupted, or interrupted and not yet looked at. */
  | 'none'
  /** Assembling the chunks into a draft right now. */
  | 'running'
  /** A draft exists; `salvagedEntryId` points at it. */
  | 'saved'
  /** The take held no audio at all, so there is nothing to open and a retry is the right offer. */
  | 'empty'
  /** Assembling failed. The chunks are untouched on disk, so it is worth another attempt. */
  | 'failed';

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
  /**
   * The action log (D5).
   *
   * Every call below is one of the two cases a `data-log` attribute cannot express — an outcome or
   * a duration — and every one of them is fire-and-forget: `record()` composes in memory, hands
   * the write to a chain nobody awaits, and swallows its own failures. Nothing here can delay a
   * chunk reaching the store or a take reaching the draft.
   */
  private readonly actions = inject(ActionLogService);

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
  /** How far the rescue of an interrupted take has got. */
  protected readonly salvage = signal<SalvageState>('none');

  /**
   * True from the instant the take is interrupted until the salvage has resolved one way or the
   * other — derived from `state()` rather than from the effect that starts the salvage, so it is
   * already true on the very first render of the interrupted card no matter when the effect runs.
   * While it holds, the screen shows a disabled placeholder in the action slot: no layout jump,
   * and nothing tappable that would abandon the take.
   */
  protected readonly salvagePending = computed(
    () =>
      this.state() === 'interrupted' && (this.salvage() === 'none' || this.salvage() === 'running'),
  );

  /** Assembling the interrupted take failed; the chunks are still on disk, so offer another go. */
  protected readonly salvageFailed = computed(
    () => this.state() === 'interrupted' && this.salvage() === 'failed',
  );

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
  /**
   * Bumped whenever a take takes over the screen, so a salvage still in flight from the previous
   * one can tell that it no longer owns this component and write nothing.
   */
  private salvageGeneration = 0;

  constructor() {
    // The recorder can lose the microphone at any moment — an incoming call, the OS reclaiming
    // the device. Whatever was captured is on disk; turn it into a draft and say so. The effect
    // depends on the recorder state alone: the salvage's own progress is read untracked, so a
    // rescue is started once per interruption and never re-entered by its own writes.
    effect(() => {
      const state = this.state();
      untracked(() => {
        if (state !== 'interrupted' || this.salvage() !== 'none') {
          return;
        }
        if (!this.entryId) {
          // Interrupted before a session existed: there is nothing on disk to rescue, so the
          // screen may go straight to offering another attempt.
          this.salvage.set('empty');
          return;
        }
        void this.salvageInterrupted();
      });
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
    // This take owns the screen from here on. A salvage of the previous one that is still
    // assembling must not write over its state — least of all null its entry id, which would
    // leave the new recording with a stop button that does nothing.
    this.salvageGeneration += 1;
    this.tooShort.set(false);
    this.saveFailed.set(false);
    this.salvagedEntryId.set(null);
    this.salvage.set('none');
    this.recorder.reset();

    const project = this.project();
    const blocker = this.blocker();
    if (blocker !== null || !project) {
      // Why the microphone never opened, said as a slug from this file's own vocabulary — never
      // the project, never the sentence on the card.
      this.actions.record(ACTIONS.captureRecordStart, {
        outcome: 'blocked',
        detail: { reason: blocker ?? 'no-project' },
      });
      return;
    }

    const entryId = crypto.randomUUID();
    // Provisional, and corrected below the moment audio actually starts. The session cannot be
    // opened without *a* timestamp — a chunk needs somewhere to land before the first one
    // arrives — but this one is taken before `getUserMedia` has even shown the permission sheet.
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
      this.actions.record(ACTIONS.captureRecordStart, {
        outcome: 'fail',
        detail: { reason: 'storage' },
      });
      return;
    }

    this.entryId = entryId;
    const started = await this.recorder.start(entryId, mimeType);
    if (!started) {
      // Nothing was recorded, so the empty session is thrown away rather than left for the
      // start-up sweep to puzzle over.
      await this.entries.discardCapture(entryId);
      this.entryId = null;
      // The recorder's own state is the reason: denied, unavailable, unsupported, error. All four
      // are constants of this app, which is what makes them safe to put on the wire.
      this.actions.record(ACTIONS.captureRecordStart, {
        outcome: 'fail',
        detail: { reason: this.state() },
      });
      return;
    }

    /*
     * Now that audio is really being captured, say so — because the stamp above is not when this
     * recording began, it is when the microphone was *asked for*.
     *
     * `recorder.start()` awaits `getUserMedia`, and on a first-ever recording that is a permission
     * sheet a man with muddy hands has to find the "Allow" button on. Twenty seconds of it used to
     * become twenty seconds of phantom recording, and not only on this screen: `capturedAt` becomes
     * the entry's own, so it reaches the server as `created_at`, is printed on the client's report
     * as the time the day's work was recorded, and is one end of the duration `finishCapture`
     * derives when nobody presses stop.
     *
     * Awaited rather than fired and forgotten, because a rescue sweep may assemble this capture at
     * any moment and should see the corrected time; and swallowed, because the recording is already
     * running and a wrong-but-early timestamp is worth immeasurably more than a lost take.
     */
    await this.entries.markCaptureStarted(entryId, new Date().toISOString()).catch(() => undefined);

    this.actions.record(ACTIONS.captureRecordStart, { outcome: 'ok', entryId });

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
        this.actions.record(ACTIONS.captureRecordStop, {
          outcome: 'cancel',
          entryId,
          detail: { empty: true },
        });
        return;
      }

      // Before the navigation, so the event is filed on the screen the button was on.
      this.actions.record(ACTIONS.captureRecordStop, {
        outcome: 'ok',
        durationMs: finished?.durationMs,
        entryId,
      });

      this.leaving = true;
      await this.router.navigate(['/entry', entry.id], { replaceUrl: true });
    } catch {
      // The chunks are still on disk under this entry id, so the retry below — or the next app
      // start — can still assemble them. Nothing is stranded.
      this.saveFailed.set(true);
      this.actions.record(ACTIONS.captureRecordStop, { outcome: 'fail', entryId });
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
        await this.router.navigate(['/entry', entry.id], { replaceUrl: true });
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
      await this.router.navigate(['/entry', entryId], { replaceUrl: true });
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

  /** Assemble the interrupted take again after the first attempt failed. Nothing was lost. */
  protected async retrySalvage(): Promise<void> {
    if (this.salvage() === 'failed') {
      await this.salvageInterrupted();
    }
  }

  /**
   * Turn what the recorder managed to capture before the interruption into a draft.
   *
   * Runs while the screen shows the interrupted card with no action offered, so the foreman
   * cannot start a second take on top of it — and the guards below hold even if he leaves and
   * something else changes `entryId` underneath: a salvage that no longer owns the screen writes
   * nothing.
   */
  private async salvageInterrupted(): Promise<void> {
    const entryId = this.entryId;
    if (!entryId) {
      this.salvage.set('empty');
      return;
    }
    const generation = (this.salvageGeneration += 1);
    const stillMine = () => generation === this.salvageGeneration;
    this.salvage.set('running');

    let entry: Awaited<ReturnType<typeof this.entries.finishCapture>>;
    try {
      await this.recorder.flush();
      entry = await this.entries.finishCapture(entryId, {
        durationMs: this.recorder.lastDurationMs(),
      });
    } catch {
      // The chunks are still on disk under this entry id, so this is worth retrying — and the
      // next app start assembles them even if the foreman walks away from the screen.
      if (stillMine()) {
        this.salvage.set('failed');
      }
      return;
    }

    if (!stillMine()) {
      // Another take has taken the screen over. The draft assembled above is already on disk and
      // reachable from the home screen; touching this component's state now would corrupt the
      // take that is running.
      return;
    }

    if (entry) {
      this.salvagedEntryId.set(entry.id);
      this.salvage.set('saved');
    } else {
      await this.entries.discardCapture(entryId);
      this.salvage.set('empty');
    }
    this.entryId = null;
  }
}
