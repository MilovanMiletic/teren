import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { switchMap } from 'rxjs';

import { EntryResponse } from '../../core/api/api-types';
import { ArchiveService, RemoteStatus } from '../../core/archive/archive.service';
import {
  EntryStructure,
  EntryWeather,
  parseEntryStructure,
  parseEntryWeather,
} from '../../core/archive/entry-structure';
import { EntryStore } from '../../core/db/entry-store';
import { GeoFix, LocalEntry, LocalMedia, canRevise, needsConfirmation } from '../../core/db/models';
import { ReportFailure, ReportService } from '../../core/report/report.service';
import { DurationPipe } from '../../ui/duration.pipe';
import { entryStatusKey, entryStatusTone } from '../../ui/entry-status';
import { Icon } from '../../ui/icon';
import { ObjectUrlCache } from '../../ui/object-url-cache';
import { PhotoViewer } from './photo-viewer';

/**
 * Why the structured day is not on screen.
 *
 * Six states rather than "loaded / not loaded", because every one of them is a different sentence
 * to a foreman and a different fact to an owner in a dispute. "Nothing has been extracted yet"
 * and "the model read the recording and found nothing in it" are opposite claims about the same
 * blank card, and today — with B4 mid-build and not one entry extracted — the absent case is not
 * an edge case, it is the entire product.
 */
export type StructureState =
  /** Extracted, and it has content. */
  | 'ready'
  /** Extraction ran and produced an empty document. A result, not a stage. */
  | 'empty'
  /** The server has the entry; the pipeline has not produced a structure for it yet. */
  | 'processing'
  /** Transcription or extraction failed. The raw evidence below is what this record is. */
  | 'needsReview'
  /** The entry has never reached the server, so nothing could have been extracted. */
  | 'notSent'
  /** We could not ask. Says so, rather than implying the entry is empty. */
  | 'unavailable';

/** The same question about the transcript. See {@link StructureState}. */
export type TranscriptState =
  | 'ready'
  | 'pending'
  /** Transcription itself failed — the known failure mode. Nothing is on its way. */
  | 'needsReview'
  | 'notSent'
  | 'unavailable';

/**
 * One finished entry, read-only: the archive's whole reason to exist.
 *
 * PROJECT.md §2 is blunt about who this screen is for. The foreman is the user, but the **buyer**
 * pays because the archive wins disputes — so this is the screen that has to hold up months
 * later, in front of an investor's engineer, showing what was done, who did it, what went in, and
 * the raw recording and photographs it was all derived from. Everything here is therefore
 * presented as evidence: nothing is editable, nothing is inferred, and where a fact is missing
 * the screen says which kind of missing it is rather than leaving a gap.
 *
 * **Two sources, one record.** The phone holds the media — the actual audio and photographs — and
 * the server holds what was made of them (transcript, structure, weather). Either half can be
 * absent: an entry still in the outbox has media and nothing else; an entry recorded on a
 * different phone, or pruned locally after confirmation (C1), has everything except the bytes.
 * The component renders whichever halves it has and is explicit about the other.
 */
@Component({
  selector: 'app-entry-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, DurationPipe, Icon, PhotoViewer, TranslocoDirective],
  templateUrl: './entry-detail.html',
  styleUrl: './entry-detail.css',
  host: { '(document:keydown.escape)': 'closeViewer()' },
})
export class EntryDetail {
  private readonly router = inject(Router);
  private readonly entries = inject(EntryStore);
  private readonly archive = inject(ArchiveService);
  private readonly reports = inject(ReportService);

  readonly entryId = input.required<string>();

  protected readonly local = signal<LocalEntry | null>(null);
  /** True once the local lookup has answered, whatever it answered. */
  protected readonly localLoaded = signal(false);

  protected readonly remote = signal<EntryResponse | null>(null);
  protected readonly remoteStatus = signal<RemoteStatus>('ok');
  /** The server answered plainly that it has no such entry — not a failure, a fact. */
  protected readonly remoteMissing = signal(false);
  protected readonly remoteLoaded = signal(false);

  private readonly urls = new ObjectUrlCache();

  /** Which photo the full-size viewer is showing, or null when it is closed. */
  protected readonly viewerIndex = signal<number | null>(null);

  private readonly media = toSignal(
    toObservable(this.entryId).pipe(switchMap((id) => this.entries.watchMedia(id))),
    { initialValue: [] as LocalMedia[] },
  );

  protected readonly photos = computed(() => this.media().filter((item) => item.kind === 'photo'));
  protected readonly audio = computed(
    () => this.media().find((item) => item.kind === 'audio') ?? null,
  );

  /**
   * Photographs the server holds that are not on this phone.
   *
   * They cannot be shown: media bytes never pass through the API (ARCHITECTURE §2) and there is
   * no presigned **GET**, only the PUT the upload path uses. So the record reports how many
   * photographs the entry has rather than pretending it has none — a silent zero on an entry with
   * six photographs would be the archive failing at the one job it has.
   */
  protected readonly remotePhotoCount = computed(
    () => this.remote()?.media?.filter((item) => item.kind === 'photo').length ?? 0,
  );

  protected readonly unshownPhotoCount = computed(() =>
    Math.max(0, this.remotePhotoCount() - this.photos().length),
  );

  /** The server holds a recording this phone does not — same limitation, same honesty. */
  protected readonly audioOffsite = computed(
    () => !this.audio() && (this.remote()?.media?.some((item) => item.kind === 'audio') ?? false),
  );

  /**
   * Nothing on the phone, and the server said plainly it has no such entry.
   *
   * **The explicit 404 is required.** Any other non-answer — offline, a 5xx, a rejected token —
   * means the server could not be *asked*, which is a different fact entirely. On the screen
   * whose whole job is proving evidence exists, announcing that a record does not exist because
   * the wifi blipped is the worst thing it can say. `remoteMissing` carries the 404; nothing
   * else does.
   */
  protected readonly notFound = computed(
    () => this.localLoaded() && this.remoteLoaded() && !this.local() && this.remoteMissing(),
  );

  /**
   * Nothing on the phone, and the server could not be reached to say whether it has anything.
   *
   * Its own placeholder, because both of the alternatives are lies: that the entry is missing,
   * or that it is empty.
   */
  protected readonly unreachable = computed(
    () =>
      this.localLoaded() &&
      this.remoteLoaded() &&
      !this.local() &&
      !this.remote() &&
      !this.remoteMissing(),
  );

  protected readonly loading = computed(() => !this.localLoaded());

  /**
   * The human-approved version where there is one, the model's otherwise.
   *
   * `corrected` is what the report was built from, and the archive's job is to show what was
   * sent — not what was first guessed. The distinction is surfaced on screen, because "a person
   * checked this" is exactly the claim that makes the record worth something in a dispute.
   */
  protected readonly structure = computed<EntryStructure | null>(() => {
    const remote = this.remote();
    if (!remote) {
      return null;
    }
    return (
      parseEntryStructure(remote.corrected ?? null) ?? parseEntryStructure(remote.structure ?? null)
    );
  });

  protected readonly structureIsCorrected = computed(
    () => parseEntryStructure(this.remote()?.corrected ?? null) !== null,
  );

  protected readonly structureState = computed<StructureState>(() => {
    const structure = this.structure();
    if (structure) {
      return structure.empty ? 'empty' : 'ready';
    }
    const remote = this.remote();
    if (remote) {
      return remote.status === 'needs_review' ? 'needsReview' : 'processing';
    }
    if (this.remoteMissing() || this.remoteStatus() === 'not_configured') {
      // The server has never seen this entry — or this build cannot ask one. Either way nothing
      // has been extracted, and the entry is sitting in the outbox waiting to be sent.
      return 'notSent';
    }
    return this.remoteLoaded() ? 'unavailable' : this.pendingGuess();
  });

  /**
   * What to say in the frame between the local read and the server's answer.
   *
   * Not a guess for its own sake: the phone already knows whether it ever got a receipt, and
   * answering from that is right at both ends, so the card does not flash "processing" over an
   * entry that has never left the outbox and then correct itself a moment later. On this screen
   * a momentary false claim is still a false claim.
   */
  private pendingGuess(): 'processing' | 'notSent' {
    return this.local()?.status === 'confirmed_by_server' ? 'processing' : 'notSent';
  }

  protected readonly transcript = computed(() => {
    const raw = this.remote()?.raw_transcript;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  });

  /**
   * The state's copy, as translation keys.
   *
   * Composed here rather than in the template so the concatenation sits next to the union type
   * that constrains it: `StructureState`'s members and the `archive.structure.*` keys are one
   * list in two files, and a state added to one without the other must be visible at a glance.
   */
  protected readonly structureTitleKey = computed(
    () => `archive.structure.${this.structureState()}.title`,
  );

  protected readonly structureBodyKey = computed(
    () => `archive.structure.${this.structureState()}.body`,
  );

  protected readonly transcriptKey = computed(() => `archive.transcript.${this.transcriptState()}`);

  /** The strip's object URLs, in the order it shows them — what the full-size viewer pages through. */
  protected readonly photoUrls = computed(() =>
    this.photos().map((photo) => this.urls.get(photo.id, photo.blob)),
  );

  protected readonly transcriptState = computed<TranscriptState>(() => {
    if (this.transcript()) {
      return 'ready';
    }
    const remote = this.remote();
    if (remote) {
      // A `needs_review` entry with no transcript is one whose transcription failed. Saying it
      // "has not arrived yet" implies it will, directly under a card saying processing failed —
      // two halves of one screen disagreeing about whether the pipeline is still alive.
      return remote.status === 'needs_review' ? 'needsReview' : 'pending';
    }
    if (this.remoteMissing() || this.remoteStatus() === 'not_configured') {
      return 'notSent';
    }
    if (!this.remoteLoaded()) {
      return this.pendingGuess() === 'notSent' ? 'notSent' : 'pending';
    }
    return 'unavailable';
  });

  protected readonly weather = computed<EntryWeather | null>(() =>
    parseEntryWeather(this.remote()?.weather ?? null),
  );

  /**
   * Where the phone was.
   *
   * The device's own fix wins: it was taken at capture time, on site, before anything was sent.
   * The server's copy is the same fix echoed back, and falling through to it is what makes the
   * position visible on an entry whose local copy has been pruned.
   */
  protected readonly geo = computed<GeoFix | null>(() => {
    const local = this.local()?.geo;
    if (local) {
      return local;
    }
    const remote = this.remote();
    if (!remote || remote.latitude == null || remote.longitude == null) {
      return null;
    }
    return {
      latitude: remote.latitude,
      longitude: remote.longitude,
      accuracyM: remote.gps_accuracy_m ?? null,
      fixedAt: remote.created_at,
    };
  });

  /** The site day, as a local `Date` for the date pipe. Never `new Date('YYYY-MM-DD')` — that is UTC. */
  protected readonly day = computed(() => {
    const local = this.local();
    if (local) {
      return new Date(local.capturedAt);
    }
    const remote = this.remote();
    return remote ? new Date(`${remote.entry_date}T00:00:00`) : null;
  });

  /** The moment of capture, printed only when a real clock recorded it. */
  protected readonly capturedAt = computed(() => {
    const local = this.local();
    return local ? new Date(local.capturedAt) : null;
  });

  protected readonly projectName = computed(() => this.local()?.projectName ?? null);

  protected readonly statusKey = computed(() =>
    entryStatusKey(this.serverStatus(), this.local()?.status ?? null, this.sealed()),
  );

  protected readonly statusTone = computed(() =>
    entryStatusTone(this.serverStatus(), this.local()?.status ?? null, this.sealed()),
  );

  /**
   * Whether the server holds the *complete* entry, or null when we have not asked.
   *
   * `received_at`, not the `received` status: the first means the JSON arrived, the second that
   * every declared object was verified in storage (ARCHITECTURE §6). Only the second is a claim
   * this screen may make about evidence.
   */
  private readonly sealed = computed<boolean | null>(() => {
    const remote = this.remote();
    return remote ? remote.received_at !== null : null;
  });

  /** The freshest server word: this load's, falling back to whatever the sync loop last stored. */
  private readonly serverStatus = computed(
    () => this.remote()?.status ?? this.local()?.serverStatus ?? null,
  );

  /**
   * Whether the record is still waiting to leave the phone.
   *
   * Worth a banner of its own: an entry that has not been received cannot be in a report, and the
   * one thing this screen must never do is let a record look finished when it is not.
   */
  protected readonly awaitingUpload = computed(() => {
    const local = this.local();
    if (!local || this.blocked()) {
      return false;
    }
    return local.status !== 'confirmed_by_server' && !this.remote()?.received_at;
  });

  /**
   * The entry is on the phone and the server will not take it.
   *
   * Kept apart from {@link awaitingUpload} because that banner promises the entry sends itself,
   * and the defining property of a blocked entry is that no retry will move it. Promising an
   * automatic recovery beside a chip reading "Ne može da se poslati" is the record contradicting
   * itself about the one thing the foreman needs to act on.
   */
  protected readonly blocked = computed(() => this.local()?.status === 'blocked');

  /**
   * The server has finished with this entry and is waiting for a person (B5).
   *
   * The record itself stays read-only — nothing here is editable, which is what makes it evidence
   * — but it must not be a dead end. An entry showing "Potrebna provera" with no route to the
   * gate would be this screen naming the problem and hiding the control that fixes it, which is
   * exactly the defect B5 fixed on Home.
   */
  protected readonly needsConfirming = computed(
    () => !this.remote()?.reported_at && needsConfirmation(this.serverStatus()),
  );

  /**
   * He already answered — and until the report goes out he is still allowed to change his answer.
   *
   * A different claim from {@link needsConfirming}, and the copy on screen has to keep them apart:
   * that one is an entry the server has handed back to a person, this one is an entry he has
   * already finished with. Nothing is outstanding here, so nothing on screen may suggest it is.
   *
   * What makes it worth showing at all is that the window shuts for good. `reported_at` seals the
   * row (B6) and the only remedy afterwards is a whole new correction entry (C4, not built), so
   * the cheap fix is available exactly now — and, before this, only by typing the URL by hand.
   */
  protected readonly revisable = computed(() =>
    canRevise(this.serverStatus(), this.remote()?.reported_at ?? null),
  );

  protected readonly audioDurationMs = computed(
    () => this.audio()?.durationMs ?? this.local()?.audioDurationMs ?? 0,
  );

  /*
   * ---- The report (PROJECT.md §11, ruling 5) ------------------------------------------------
   *
   * "The PDF is downloadable from the app, not only from the client's email." The record already
   * shows the evidence a day was built from; this is the finished document that went out of it,
   * and being able to hand it to somebody — a client on the phone, an engineer in a meeting — is
   * the whole point.
   */

  /**
   * Whether there is a report to ask for at all.
   *
   * `reported_at` from the **server's** answer, never the local `serverStatus` cache: that column
   * is written once at upload time and never refreshed (the known Home/archive disagreement), so
   * trusting it would put a download button on a day whose report does not exist. Offering an
   * action that can only fail is the same class of lie as a screen claiming a record is missing
   * because the wifi blipped.
   */
  protected readonly reported = computed(() => this.remote()?.reported_at != null);

  protected readonly reportBusy = signal(false);
  /** Fraction downloaded, or null while the total is unknown (no `Content-Length`). */
  protected readonly reportProgress = signal<number | null>(null);
  protected readonly reportFailure = signal<ReportFailure | null>(null);
  protected readonly reportRetryable = signal(false);
  protected readonly reportSaved = signal(false);

  protected readonly reportPercent = computed(() => {
    const fraction = this.reportProgress();
    return fraction === null ? null : Math.min(100, Math.max(0, Math.round(fraction * 100)));
  });

  /** See {@link structureTitleKey} for why the concatenation lives beside the union it indexes. */
  protected readonly reportErrorKey = computed(() => {
    const failure = this.reportFailure();
    return failure ? `archive.report.error.${failure}` : null;
  });

  /**
   * How loudly to say it.
   *
   * The three outcomes are not equally bad and must not look it. "Not ready yet" and "the server
   * could not be asked" are waiting states — nothing is wrong with the entry and nothing needs
   * doing — while a missing entry or a refused token is a real problem with no cure on this
   * screen. Painting all of them red would be the screen shouting at a foreman about a PDF that
   * is simply thirty seconds away.
   */
  protected readonly reportErrorTone = computed<'warn' | 'err'>(() => {
    switch (this.reportFailure()) {
      case 'missing':
      case 'unavailable':
      case 'rejected':
      case 'unauthorized':
      case 'notConfigured':
        return 'err';
      default:
        return 'warn';
    }
  });

  constructor() {
    // Local first, and rendered before the server is asked: the archive is readable in a basement
    // with no signal, and waiting on a network call to paint would break that.
    effect(() => {
      const id = this.entryId();
      this.localLoaded.set(false);
      this.remoteLoaded.set(false);
      this.remote.set(null);
      this.remoteMissing.set(false);
      this.viewerIndex.set(null);
      this.resetReport();

      void this.entries.getEntry(id).then((entry) => {
        this.local.set(entry ?? null);
        this.localLoaded.set(true);
      });

      void this.archive.getEntry(id).then((result) => {
        // A late answer for an entry the user has already navigated away from must not land on
        // the one now on screen.
        if (this.entryId() !== id) {
          return;
        }
        this.remote.set(result.entry);
        this.remoteStatus.set(result.status);
        this.remoteMissing.set(result.missing);
        this.remoteLoaded.set(true);
      });
    });

    // Mint object URLs for what is on screen and hand back the rest; anything less leaks the
    // whole photograph into memory for the life of the tab.
    effect(() => {
      this.urls.retain(this.media().map((item) => item.id));
    });

    inject(DestroyRef).onDestroy(() => this.urls.releaseAll());
  }

  protected photoUrl(item: LocalMedia): string {
    return this.urls.get(item.id, item.blob);
  }

  protected audioUrl(): string | null {
    const audio = this.audio();
    return audio ? this.urls.get(audio.id, audio.blob) : null;
  }

  /**
   * Fetch the report and hand it to the browser.
   *
   * **The first line is the whole guard against five downloads.** A report with photographs is a
   * few megabytes, and on a site connection the button can look inert for ten seconds or more; a
   * foreman taps a button that appears to do nothing. Disabling it in the template is the visible
   * half of that, and this is the half that holds when the tap arrives anyway — a keyboard
   * `Enter` repeat, a double-tap the browser delivers before the render.
   */
  protected async downloadReport(): Promise<void> {
    if (this.reportBusy()) {
      return;
    }

    const id = this.entryId();
    this.reportBusy.set(true);
    this.reportFailure.set(null);
    this.reportRetryable.set(false);
    this.reportSaved.set(false);
    this.reportProgress.set(null);

    const result = await this.reports.download(id, this.reportFileBase(), (fraction) => {
      // A late progress tick for an entry the user has already left must not drive the bar on the
      // one now on screen.
      if (this.entryId() === id) {
        this.reportProgress.set(fraction);
      }
    });

    // Same rule for the outcome. The effect has already cleared this state for the new entry;
    // writing an old entry's failure over it would put a red sentence on the wrong record.
    if (this.entryId() !== id) {
      return;
    }

    this.reportBusy.set(false);
    this.reportProgress.set(null);
    this.reportFailure.set(result.failure);
    this.reportRetryable.set(result.retryable);
    this.reportSaved.set(result.ok);
  }

  private resetReport(): void {
    this.reportBusy.set(false);
    this.reportProgress.set(null);
    this.reportFailure.set(null);
    this.reportRetryable.set(false);
    this.reportSaved.set(false);
  }

  /**
   * What the file is called when the server's own name cannot be read.
   *
   * Deliberately wordless: the report is written in the **project's** language, not the phone's
   * (`ARCHITECTURE.md` §5), so a fallback built from the UI locale would be wrong precisely when
   * it is used. A brand and a date are true in both.
   */
  private reportFileBase(): string {
    const date = this.remote()?.entry_date;
    return date ? `teren-${date}` : 'teren';
  }

  /** To the gate. The record does not edit; it hands over to the screen that does. */
  protected openConfirm(): void {
    void this.router.navigate(['/confirm', this.entryId()]);
  }

  protected openViewer(index: number): void {
    this.viewerIndex.set(index);
  }

  protected closeViewer(): void {
    this.viewerIndex.set(null);
  }

  /** Six decimal places is roughly 0.1 m — more than a phone's fix will ever justify, and stable. */
  protected coordinate(value: number): string {
    return value.toFixed(6);
  }
}
