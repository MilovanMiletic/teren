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
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { AppStatus } from '../../core/app-status.service';
import { CORRECTION_PARAM } from '../../core/capture/correction-route';
import {
  CorrectionRefusal,
  CorrectionService,
  CorrectionTarget,
} from '../../core/capture/correction.service';
import { EntryStore } from '../../core/db/entry-store';
import { Project } from '../../core/db/models';
import { AudioRecorderService, RecorderState } from '../../core/media/audio-recorder.service';
import { negotiateAudioMimeType } from '../../core/media/audio-mime';
import { GeolocationService } from '../../core/media/geolocation.service';
import { ProjectService } from '../../core/projects/project.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { formatDuration } from '../../ui/duration.pipe';
import { Icon } from '../../ui/icon';

/**
 * What is stopping this screen from recording, if anything.
 *
 * The two `no-target-*` blockers are the correction case: the URL names a day to replace and this
 * build cannot say which site that day belongs to. It is a blocker rather than a fallback because
 * the fallback — recording against the selected site — writes an entry the server answers with a
 * `404`, which is terminal in the outbox, so the take would never leave the phone
 * (`core/capture/correction.service.ts`).
 *
 * **Two of them, because the remedies differ.** `no-target-offline` is the server not answering,
 * and a signal is exactly what fixes it; `no-target-unknown` is the server answering with nothing
 * this phone can use, where another attempt asks the same question and gets the same answer. One
 * blocker meant one sentence blaming the network in both, and a retry button under the case a
 * retry can never help (review, 2026-09-04).
 */
type Blocker = 'no-project' | 'no-storage' | 'no-target-offline' | 'no-target-unknown' | null;

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
  private readonly corrections = inject(CorrectionService);
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

  /**
   * The day this take replaces, read **once** off the URL that opened the screen.
   *
   * A snapshot and not a subscription, deliberately: `begin()` runs in the constructor and again
   * on "Pokušaj ponovo", and both must record the same kind of entry. A signal following the query
   * map would let a navigation change what a recording *is* halfway through it.
   */
  private readonly correctionId =
    inject(ActivatedRoute).snapshot.queryParamMap.get(CORRECTION_PARAM) || null;

  /** Whether this screen is recording a correction at all. */
  protected readonly correcting = this.correctionId !== null;

  /** The resolved target: its id and, the load-bearing half, **its** site. */
  protected readonly target = signal<CorrectionTarget | null>(null);

  /** Looking the target up right now — a state, because it can involve the network. */
  protected readonly resolving = signal(false);

  /**
   * The lookup answered "I cannot say which site that day belongs to" — **and why**.
   *
   * Null while there is nothing wrong. The reason is kept rather than reduced to a boolean because
   * it decides both the sentence on the card and whether a retry is offered at all.
   */
  protected readonly refusal = signal<CorrectionRefusal | null>(null);

  /**
   * The site this take is filed against.
   *
   * **In correction mode it is the target's and only ever the target's.** The selected site is not
   * consulted and is not a fallback: `supersedes_entry_id` is accepted only for an entry of the
   * same project, and a mismatch is a terminal `404` that abandons the recording in the outbox.
   * Null while the target is still being resolved, which is what keeps `beginCapture` from being
   * called with a site nobody has established.
   */
  protected readonly project = computed<Project | null>(() =>
    this.correcting ? (this.target()?.project ?? null) : this.projects.selected(),
  );

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
    if (this.correcting) {
      // While the lookup is in flight nothing is wrong yet, and "no site selected" would be the
      // wrong sentence in any case — he never selected one, the entry did.
      if (this.resolving()) {
        return null;
      }
      switch (this.refusal()) {
        case 'unreachable':
          return 'no-target-offline';
        case 'unresolvable':
          return 'no-target-unknown';
        default:
          return null;
      }
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
  /**
   * Bumped by every {@link begin}, and by every path that gives up the screen.
   *
   * **This exists because `begin()` awaits, and one of its awaits is a network round trip.** A
   * correction has to find out which site the corrected day belongs to, and on a Dexie miss that
   * goes to `ArchiveService.getEntry` — bounded only by `API_TIMEOUT_MS`, so thirty seconds on a
   * bad connection. Throughout that wait the screen is on, Otkaži is enabled and the back gesture
   * works; without this check the lookup's answer would then open the microphone on a component
   * that no longer exists, with nothing left on screen to stop it.
   *
   * What made it worse than an orphaned recorder: the chunks land under a *correction* session, so
   * `EntryStore.rescue` assembles them into a draft and `queueAbandonedDrafts` sends it after its
   * grace period — a correction of a client's day, carrying whatever the phone happened to hear,
   * delivered to that client. Found by review of `fc5737f`.
   *
   * A counter and not a boolean, so a second `begin()` also invalidates the first one's pending
   * awaits rather than both racing to own `entryId`.
   */
  private beginGeneration = 0;
  private destroyed = false;

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
    // Before anything else: any await still in flight inside `begin()` has lost its claim on this
    // screen. See `beginGeneration`.
    this.destroyed = true;
    this.beginGeneration += 1;

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
    const generation = (this.beginGeneration += 1);
    this.tooShort.set(false);
    this.saveFailed.set(false);
    this.salvagedEntryId.set(null);
    this.salvage.set('none');
    this.recorder.reset();

    if (this.correctionId !== null && !(await this.resolveTarget(this.correctionId))) {
      return;
    }
    // The correction lookup above can take a network round trip, and Otkaži and the back gesture
    // both work while it runs. If either happened, this take no longer owns the screen and the
    // microphone must not open.
    if (!this.stillMine(generation)) {
      return;
    }

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
        // On the **session**, so a correction the tab dies in the middle of is still assembled as
        // a correction by the start-up sweep rather than as a second record of the same day.
        supersedesEntryId: this.correctionId,
      });
    } catch {
      this.status.reportStorageFailure();
      this.actions.record(ACTIONS.captureRecordStart, {
        outcome: 'fail',
        detail: { reason: 'storage' },
      });
      return;
    }

    // `beginCapture` awaits Dexie, which is milliseconds rather than a round trip — but the same
    // rule applies, and an empty session left behind would be assembled by the start-up sweep into
    // a draft of a day nobody recorded. So it is discarded rather than merely abandoned.
    if (!this.stillMine(generation)) {
      await this.entries.discardCapture(entryId).catch(() => {
        // Nothing on screen to tell, and nothing was recorded under it.
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

  /**
   * Abandon the take. The only path that throws captured audio away, and it is explicit.
   *
   * **There is deliberately no `saving()` check in here.** The guard is the `[disabled]` binding in
   * the template, in one place, so that removing it turns a spec red rather than being caught by a
   * second copy of itself — and so that the control a foreman is looking at and the behaviour he
   * gets can never disagree. See the comment beside the button for what the window is.
   */
  protected async cancel(): Promise<void> {
    this.leaving = true;
    this.beginGeneration += 1;
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
    this.beginGeneration += 1;
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
    if (blocker === 'no-target-offline') {
      return 'capture.blocked.correction';
    }
    if (blocker === 'no-target-unknown') {
      return 'capture.blocked.correctionUnknown';
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

  /**
   * Retrying makes no sense where the browser, the store, or **the server's own answer** is the
   * problem.
   *
   * `no-target-offline` is the exception among the blockers and it is worth the extra clause: the
   * lookup failed because the server could not be reached about a day this phone does not hold,
   * and a signal that comes back is exactly what makes another attempt succeed.
   *
   * `no-target-unknown` deliberately does **not** get one. The server answered; asking it again
   * asks the same question. A retry button there is a screen inviting a foreman to press the same
   * thing until he gives up, which is worse than no button at all — the copy sends him to the
   * office instead. `no-project` and `no-storage` are conditions of the app, not of the moment.
   */
  protected canRetry(state: RecorderState, blocker: Blocker): boolean {
    return (blocker === null || blocker === 'no-target-offline') && state !== 'unsupported';
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
  /**
   * Find out which site the day named in the URL belongs to, before the microphone is opened.
   *
   * Returns false when it could not be established, having put the screen into the `no-target`
   * blocker — the caller then records nothing at all. That early return is the guarantee: there is
   * no path from here to `beginCapture` with a site this method did not resolve, so a correction
   * can never be filed against the selected site by accident.
   */
  /**
   * Whether the take that started at this generation still owns the screen.
   *
   * Three ways it can stop owning it, and all three are things a man does with his thumb: Otkaži,
   * the back gesture (which destroys the component), or starting another take. See
   * {@link beginGeneration}.
   */
  private stillMine(generation: number): boolean {
    return generation === this.beginGeneration && !this.leaving && !this.destroyed;
  }

  private async resolveTarget(correctionId: string): Promise<boolean> {
    this.refusal.set(null);
    this.resolving.set(true);
    const lookup = await this.corrections.resolve(correctionId);
    this.resolving.set(false);

    if (!lookup.target) {
      this.refusal.set(lookup.refusal);
      // A slug from this file's own vocabulary, never the id and never the sentence on the card.
      // The refusal rides in the detail because "he could not correct a day" and "he could not
      // correct a day the server has never heard of" are two different things to read in a log.
      this.actions.record(ACTIONS.captureRecordStart, {
        outcome: 'blocked',
        detail: { reason: `no-target-${lookup.refusal}` },
      });
      return false;
    }

    this.target.set(lookup.target);
    return true;
  }

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
