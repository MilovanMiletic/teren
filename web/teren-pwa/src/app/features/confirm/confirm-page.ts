import { DatePipe } from '@angular/common';
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
import { AppStatus } from '../../core/app-status.service';
import { ARCHIVE_ENTRY_PARAM } from '../../core/archive/archive-route';
import { ArchiveService, RemoteStatus } from '../../core/archive/archive.service';
import { ConfirmBanner, confirmBanner } from '../../core/confirm/confirm-banner';
import { ConfirmFailure, ConfirmResult, ConfirmService } from '../../core/confirm/confirm.service';
import {
  DraftBlocker,
  DraftHiddenWork,
  DraftMaterial,
  DraftRole,
  DraftWorkItem,
  EntryDraft,
  draftFromStructure,
  draftIsEmpty,
  emptyDraft,
  isVerbatimCorrected,
  newBlocker,
  newHiddenWork,
  newMaterial,
  newRole,
  newWorkItem,
  readStoredDraft,
} from '../../core/confirm/entry-draft';
import { EntryStore } from '../../core/db/entry-store';
import { LocalEntry, LocalMedia } from '../../core/db/models';
import { AppHeader } from '../../ui/app-header';
import { entryStatusKey, entryStatusTone } from '../../ui/entry-status';
import { Icon } from '../../ui/icon';
import { ObjectUrlCache } from '../../ui/object-url-cache';

/**
 * What the screen is able to do about this entry right now.
 *
 * Not "loaded / not loaded". Every member is a different sentence and a different set of controls,
 * and the two that look like edge cases are not: `processing` is where every freshly captured
 * entry arrives, and `notSent` is where every entry sits while the outbox works. A confirmation
 * screen that rendered an empty form over either would invite a person to type a day's record
 * into something that cannot accept it.
 */
export type ConfirmState =
  /** The local read has not answered yet. */
  | 'loading'
  /** The pipeline has finished; the human may edit and confirm. */
  | 'ready'
  /** The server holds it and is still working. Polled, so the screen opens itself. */
  | 'processing'
  /** Never reached the server. Nothing to confirm — and nothing lost. */
  | 'notSent'
  /** Neither the phone nor the server has it. */
  | 'notFound'
  /** The server could not be asked. Read-only, and says which kind of missing this is. */
  | 'unreachable'
  /** The report has gone out. Immutable (PROJECT.md principle 2) — no form, no confirm button. */
  | 'reported';

/** How often the screen re-asks while the pipeline is still working (ARCHITECTURE §7). */
const POLL_INTERVAL_MS = 3_000;

/**
 * How long typing settles before it is written to the local store.
 *
 * Short enough that a phone taken out of a pocket-sized moment of attention — a lock, a call, a
 * tab the OS discards — loses at most the last few characters, long enough that a fast typist is
 * not writing an IndexedDB row per keystroke.
 */
const DRAFT_SAVE_DEBOUNCE_MS = 400;

/**
 * The confirmation screen (ROADMAP B5) — **the mandatory gate** (PROJECT.md principle 5).
 *
 * ## What it is for
 *
 * Nothing leaves this product for a client until a person has looked at it and said yes. That is
 * a product promise, not a workflow step: the whole pitch is evidence a contractor can stand
 * behind, and a report assembled by a model from a noisy site recording is not that until someone
 * who was there has vouched for it.
 *
 * The second purpose is quieter and worth more over time. Every confirmation writes the
 * **(transcript, extracted, corrected)** triple (ARCHITECTURE §9.3): what was said, what the model
 * made of it, and what the human actually meant. That is the eval set every future prompt and
 * model change is judged against, and it exists only if this screen keeps the three apart — which
 * is why it sends `corrected` and never touches the other two.
 *
 * ## Typing is a first-class path, not a fallback for emergencies
 *
 * An entry arrives here in `needs_review` with **no structure at all** whenever transcription or
 * extraction fails — and, today, on every entry, because extraction has no key configured yet. So
 * the screen is built empty-first: the same form, the same controls, seeded from nothing, with the
 * transcript above it to type from. There is no "extraction failed" dead end, because a screen
 * that only worked on the happy path would make the pipeline's bad day the foreman's lost day.
 *
 * The same machinery carries the routine case. Transcription reliably mangles material codes —
 * `PPR cev 25` comes back as *pipr cevi dvaes 5* on every provider tried (`docs/stt-evaluation.md`)
 * — so correcting a material line is an everyday action. Every field is directly editable with no
 * edit mode to enter first, and adding or removing a line is one tap.
 *
 * ## Nothing typed here can be lost
 *
 * The draft is written to Dexie on a short debounce and removed **only** after the server accepts
 * it. Confirming needs a network; failing to confirm does not cost a word. The screen says which
 * of the two happened, honestly — a retryable failure ("the server could not be asked") is never
 * dressed up as the work being gone.
 *
 * ## Three device classes
 *
 * - **Compact (<768)** — one column, evidence first (what he said), then the form, with the
 *   confirm action pinned to the bottom so it is reachable without scrolling a long day back down.
 * - **Medium (768–1023)** — the same order on a proportioned column; wider fields, so a work
 *   description and its location sit on one row instead of stacking.
 * - **Expanded (≥1024)** — two panes on the 12-column grid: the evidence (transcript, recording,
 *   position) as a sticky rail on the left, the editable day on the right, confirm at its foot.
 *   Reading the transcript while correcting the line it produced is the entire activity of this
 *   screen, and a desktop is the one place both can be on screen at once.
 */
@Component({
  selector: 'app-confirm-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, Icon, TranslocoDirective],
  templateUrl: './confirm-page.html',
  styleUrl: './confirm-page.css',
})
export class ConfirmPage {
  private readonly router = inject(Router);
  private readonly entries = inject(EntryStore);
  private readonly archive = inject(ArchiveService);
  private readonly confirmations = inject(ConfirmService);
  private readonly status = inject(AppStatus);

  /** Bound from the route (`withComponentInputBinding`). */
  readonly entryId = input.required<string>();

  protected readonly local = signal<LocalEntry | null>(null);
  protected readonly localLoaded = signal(false);

  protected readonly remote = signal<EntryResponse | null>(null);
  protected readonly remoteStatus = signal<RemoteStatus>('ok');
  protected readonly remoteMissing = signal(false);
  protected readonly remoteLoaded = signal(false);

  /** The editable day. One signal holding one object: every edit is a whole-draft replacement. */
  protected readonly draft = signal<EntryDraft>(emptyDraft());

  /** A draft restored from the local store, or null when this entry has never been edited here. */
  private readonly stored = signal<EntryDraft | null>(null);
  private readonly storedLoaded = signal(false);
  /** True once the draft has been seeded, so a late poll cannot overwrite what is being typed. */
  private readonly seeded = signal(false);

  protected readonly sending = signal(false);
  protected readonly failure = signal<ConfirmFailure | null>(null);
  protected readonly failureRetryable = signal(false);
  /** Set on a successful confirmation, cleared if the person goes back to correcting. */
  protected readonly justConfirmed = signal(false);
  /**
   * Whether the attempt on screen approved the transcript rather than a typed day.
   *
   * Two things read it, and both would otherwise be dishonest. The success card must not tell a
   * man who sent prose that his structured day is confirmed; and the failure must appear beside
   * the button he actually pressed — the verbatim action sits at the top of the screen, while the
   * form's own gate is at the foot of a long day.
   */
  protected readonly attemptWasVerbatim = signal(false);

  /**
   * True once a write of the draft to Dexie has failed.
   *
   * This screen's whole promise is that nothing typed here can be lost, and the hint under the
   * button says exactly that. The moment a local write fails the promise is false, so the screen
   * must stop making it — silently swallowing the rejection would leave a person typing a day's
   * corrections into nothing while being told they were safe.
   *
   * Latched, never cleared by a later success: a store that failed once has already dropped
   * whatever was in that write, and "saved" is not a thing this screen can honestly say again
   * until the entry is confirmed or the app is reloaded.
   */
  protected readonly draftSaveFailed = signal(false);

  private readonly urls = new ObjectUrlCache();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly media = toSignal(
    toObservable(this.entryId).pipe(switchMap((id) => this.entries.watchMedia(id))),
    { initialValue: [] as LocalMedia[] },
  );

  /**
   * The recording, when this phone still holds it.
   *
   * On a screen whose routine job is fixing a mangled material code, being able to replay the
   * three seconds that produced the line is worth more than any amount of copy. Absent after C1
   * prunes, and absent on another device — in which case the transcript alone carries it.
   */
  protected readonly audio = computed(
    () => this.media().find((item) => item.kind === 'audio') ?? null,
  );

  /** The words spoken on site. Never translated, never tidied (PROJECT.md principle 2). */
  protected readonly transcript = computed(() => {
    const raw = this.remote()?.raw_transcript;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  });

  protected readonly serverStatus = computed(
    () => this.remote()?.status ?? this.local()?.serverStatus ?? null,
  );

  protected readonly state = computed<ConfirmState>(() => {
    if (!this.localLoaded() || !this.storedLoaded()) {
      return 'loading';
    }

    const remote = this.remote();
    if (remote) {
      if (remote.reported_at) {
        return 'reported';
      }
      switch (remote.status) {
        case 'awaiting_confirmation':
        case 'needs_review':
        case 'confirmed':
          return 'ready';
        case 'reported':
          return 'reported';
        default:
          // `received` / `processing`: the server holds it and is still working.
          return 'processing';
      }
    }

    if (!this.remoteLoaded()) {
      return 'loading';
    }
    if (this.remoteMissing()) {
      // The server answered plainly that it has no such entry. On the phone it is unsent; not on
      // the phone either, and it is nowhere.
      return this.local() ? 'notSent' : 'notFound';
    }
    if (this.remoteStatus() === 'not_configured') {
      return 'notSent';
    }
    return 'unreachable';
  });

  /**
   * Whether the extraction produced a day with anything in it.
   *
   * Measured by running the model's answer through the same reader the form is seeded from and
   * asking whether the result is empty — so "extraction returned a structure with every section
   * blank" counts as no structure, which is what it is to the person looking at the screen.
   * `corrected` is deliberately not consulted: this is a fact about the *pipeline*, and a day the
   * foreman typed himself last time does not mean extraction has started working.
   */
  protected readonly hasStructure = computed(
    () => !draftIsEmpty(draftFromStructure(this.remote()?.structure ?? null)),
  );

  /**
   * Which banner sits above the form. Only meaningful in `ready`.
   *
   * Decided from the facts, never from `needs_review` alone — that status covers both "the
   * recording could not be read" and "the words are fine, the structuring failed", and captioning
   * the second with the first is the bug this screen shipped. See `core/confirm/confirm-banner.ts`.
   */
  protected readonly bannerKey = computed<ConfirmBanner>(() =>
    confirmBanner(this.serverStatus(), this.transcript() !== null, this.hasStructure()),
  );

  /** Warn for the two failures, accent for the two ordinary states. */
  protected readonly bannerTone = computed(() =>
    this.bannerKey() === 'noStructure' || this.bannerKey() === 'noTranscript' ? 'warn' : 'accent',
  );

  protected readonly editable = computed(() => this.state() === 'ready');

  /**
   * Whether confirming would send an entry with nothing in it.
   *
   * The gate exists so a person vouches for a record; vouching for a blank one produces a report
   * with no content and a `confirmed` status claiming somebody checked it.
   */
  protected readonly empty = computed(() => draftIsEmpty(this.draft()));

  protected readonly canConfirm = computed(
    () => this.editable() && !this.empty() && !this.sending(),
  );

  /**
   * Whether "send my own words" is on the table (PROJECT.md §11, founder ruling 3).
   *
   * Three conditions, and each is the difference between an honest offer and a wrong one:
   *
   * - **the banner is `noStructure`** — the one question "are these words, unstructured, the best
   *   record this entry has?", answered in one place. {@link confirmBanner} already ranks the
   *   facts: an entry a human has confirmed reads `confirmed` and never `noStructure`, one with a
   *   day extracted reads `awaiting`, one with no transcript reads `noTranscript`. This used to
   *   re-derive an overlapping-but-different condition from `transcript()` and `hasStructure()`,
   *   and the gap between the two was a live bug: reopening an entry he had already confirmed
   *   verbatim, before its report went out, showed the warn-toned "the system could not sort this
   *   day into items" card — with a live send button — under a status chip reading "Potvrđeno".
   *   The screen contradicted itself and called the system broken on a day he had finished. Two
   *   sources of truth for one question is what produced that, so there is now one;
   * - **editable** — a reported entry is sealed, and a `processing` one has nothing to confirm;
   * - **he has typed nothing** — the moment anything goes into the structured sections it is no
   *   longer a verbatim record, so the flag must not be sent. Hiding the action is how that is
   *   enforced rather than merely intended: there is no path from a non-empty draft to a
   *   `described_verbatim` payload. `draftIsEmpty` counts a row carrying *any* typed content, not
   *   merely a named one, so a quantity typed without its name still retires the offer.
   */
  protected readonly canConfirmVerbatim = computed(
    () => this.editable() && this.bannerKey() === 'noStructure' && this.empty() && !this.sending(),
  );

  protected readonly statusKey = computed(() =>
    entryStatusKey(this.serverStatus(), this.local()?.status ?? null, this.sealed()),
  );

  protected readonly statusTone = computed(() =>
    entryStatusTone(this.serverStatus(), this.local()?.status ?? null, this.sealed()),
  );

  private readonly sealed = computed<boolean | null>(() => {
    const remote = this.remote();
    return remote ? remote.received_at !== null : null;
  });

  protected readonly projectName = computed(() => this.local()?.projectName ?? null);

  protected readonly day = computed(() => {
    const local = this.local();
    if (local) {
      return new Date(local.capturedAt);
    }
    const remote = this.remote();
    return remote ? new Date(`${remote.entry_date}T00:00:00`) : null;
  });

  protected readonly errorKey = computed(() => {
    const failure = this.failure();
    return failure ? `confirm.error.${failure}` : null;
  });

  /**
   * A failure is reported once, beside the button that caused it.
   *
   * The form's gate sits at the foot of a long day while the verbatim action sits at the top, so
   * a single fixed position would leave one of the two actions failing silently from the reader's
   * point of view. If he has started typing since — which retires the verbatim offer — the message
   * falls back to the gate rather than vanishing with the card.
   */
  protected readonly verbatimError = computed(() =>
    this.attemptWasVerbatim() && this.canConfirmVerbatim() ? this.errorKey() : null,
  );

  protected readonly gateError = computed(() => (this.verbatimError() ? null : this.errorKey()));

  constructor() {
    effect(() => {
      const id = this.entryId();
      this.localLoaded.set(false);
      this.storedLoaded.set(false);
      this.remoteLoaded.set(false);
      this.remote.set(null);
      this.remoteMissing.set(false);
      this.seeded.set(false);
      this.stored.set(null);
      this.draft.set(emptyDraft());
      this.failure.set(null);
      this.justConfirmed.set(false);
      this.attemptWasVerbatim.set(false);

      // Both local reads settle their `loaded` flag even on failure. A store that will not
      // open (private mode, exhausted quota) must leave this screen saying what it does know,
      // never spinning on "Učitavanje unosa…" for ever.
      void this.entries
        .getEntry(id)
        .catch(() => undefined)
        .then((entry) => {
          if (this.entryId() !== id) {
            return;
          }
          this.local.set(entry ?? null);
          this.localLoaded.set(true);
        });

      // Read before the server is asked. If the person typed half a day yesterday and the network
      // has been down since, that half day is what must appear — not an empty form.
      void this.entries
        .getConfirmDraft(id)
        .catch(() => undefined)
        .then((row) => {
          if (this.entryId() !== id) {
            return;
          }
          this.stored.set(row ? readStoredDraft(row.draft) : null);
          this.storedLoaded.set(true);
        });

      void this.load(id);
    });

    // Seed once, from the person's own draft if there is one and from the model's answer
    // otherwise. `seeded` guards it: a poll landing mid-sentence must never replace what is being
    // typed with what the model said.
    effect(() => {
      if (this.seeded() || !this.storedLoaded()) {
        return;
      }
      const stored = this.stored();
      if (stored) {
        this.draft.set(stored);
        this.seeded.set(true);
        return;
      }
      if (!this.remoteLoaded()) {
        return;
      }
      const remote = this.remote();
      // A `corrected` that was an approval of the transcript must not seed the form. Its `notes`
      // *are* the transcript, so filling the notes box with them would present his approved words
      // as text he typed — and confirming again from that draft would send them back without the
      // flag, silently demoting a verbatim record to a typed one.
      const approved = isVerbatimCorrected(remote?.corrected) ? null : (remote?.corrected ?? null);
      this.draft.set(draftFromStructure(approved ?? remote?.structure ?? null));
      this.seeded.set(true);
    });

    // Poll only while the pipeline is actually working, and only while this screen is the one
    // that cares. Exactly the case ARCHITECTURE §7 chose polling for.
    effect(() => {
      const processing = this.state() === 'processing';
      if (processing) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    effect(() => {
      // Tracked deliberately: this is the write-through that makes "nothing typed is ever lost"
      // true. Nothing is written before the draft has been seeded, or the empty starting draft
      // would overwrite the stored one on the way in.
      const draft = this.draft();
      const id = this.entryId();
      if (!this.seeded()) {
        return;
      }
      this.scheduleSave(id, draft);
    });

    effect(() => {
      this.urls.retain(this.media().map((item) => item.id));
    });

    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
      this.flushSave();
      this.urls.releaseAll();
    });
  }

  // ---- Loading ---------------------------------------------------------------------------

  private async load(id: string): Promise<void> {
    const result = await this.archive.getEntry(id);
    if (this.entryId() !== id) {
      return;
    }
    // A failed refresh reports, it does not erase: overwriting a loaded entry with the null a
    // failure returns would drop the transcript out from under someone reading it.
    if (result.entry || result.missing) {
      this.remote.set(result.entry);
      this.remoteMissing.set(result.missing);
    }
    this.remoteStatus.set(result.status);
    this.remoteLoaded.set(true);
  }

  private startPolling(): void {
    if (this.pollTimer !== null || typeof setInterval !== 'function') {
      return;
    }
    this.pollTimer = setInterval(() => void this.load(this.entryId()), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---- Draft persistence -------------------------------------------------------------------

  private scheduleSave(entryId: string, draft: EntryDraft): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.entries.saveConfirmDraft(entryId, draft).catch(() => this.reportDraftLost());
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  /** Leaving the screen must not cost the last four hundred milliseconds of typing. */
  private flushSave(): void {
    if (this.saveTimer === null) {
      return;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.entries
      .saveConfirmDraft(this.entryId(), this.draft())
      .catch(() => this.reportDraftLost());
  }

  /**
   * Say, in both places it needs saying, that the local store just dropped a draft.
   *
   * Two signals because they answer two different questions. `draftSaveFailed` is *this* screen
   * retracting its own promise, and it is the only place the person can act on it — the words he
   * is looking at are still on screen, so confirming now, over the network, is what saves them.
   * `AppStatus` is the app-wide condition: it raises the store banner on Home and stops the
   * capture screen recording into a store that has just proven it cannot hold anything. The same
   * pairing `capture-recording-page.ts` already makes when `beginCapture` fails to write, for the
   * same reason — a failed Dexie write is a failed Dexie write whatever the caller wanted.
   *
   * The realistic cause is an exhausted quota rather than a store that will not open, and C1
   * media pruning does not exist yet, so this is not a theoretical path.
   */
  private reportDraftLost(): void {
    this.draftSaveFailed.set(true);
    this.status.reportStorageFailure();
  }

  // ---- Editing ------------------------------------------------------------------------------

  /** The typed text of whichever field raised the event. */
  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected addWork(): void {
    this.draft.update((d) => ({ ...d, workDone: [...d.workDone, newWorkItem()] }));
  }

  protected removeWork(id: string): void {
    this.draft.update((d) => ({ ...d, workDone: d.workDone.filter((row) => row.id !== id) }));
  }

  protected patchWork(id: string, patch: Partial<DraftWorkItem>): void {
    this.draft.update((d) => ({ ...d, workDone: patchRow(d.workDone, id, patch) }));
  }

  protected patchWorkQuantity(id: string, patch: { value?: string; unit?: string }): void {
    this.draft.update((d) => ({
      ...d,
      workDone: d.workDone.map((row) =>
        row.id === id ? { ...row, quantity: { ...row.quantity, ...patch } } : row,
      ),
    }));
  }

  protected setHeadcountTotal(value: string): void {
    this.draft.update((d) => ({ ...d, headcountTotal: value }));
  }

  protected addRole(): void {
    this.draft.update((d) => ({ ...d, roles: [...d.roles, newRole()] }));
  }

  protected removeRole(id: string): void {
    this.draft.update((d) => ({ ...d, roles: d.roles.filter((row) => row.id !== id) }));
  }

  protected patchRole(id: string, patch: Partial<DraftRole>): void {
    this.draft.update((d) => ({ ...d, roles: patchRow(d.roles, id, patch) }));
  }

  protected addMaterial(): void {
    this.draft.update((d) => ({ ...d, materials: [...d.materials, newMaterial()] }));
  }

  protected removeMaterial(id: string): void {
    this.draft.update((d) => ({ ...d, materials: d.materials.filter((row) => row.id !== id) }));
  }

  protected patchMaterial(id: string, patch: Partial<DraftMaterial>): void {
    this.draft.update((d) => ({ ...d, materials: patchRow(d.materials, id, patch) }));
  }

  protected patchMaterialQuantity(id: string, patch: { value?: string; unit?: string }): void {
    this.draft.update((d) => ({
      ...d,
      materials: d.materials.map((row) =>
        row.id === id ? { ...row, quantity: { ...row.quantity, ...patch } } : row,
      ),
    }));
  }

  /**
   * Delivered → not delivered → not said, and round again.
   *
   * Three states in one control because there are three facts, and the third is the common one:
   * most recordings never say whether the material arrived, and a checkbox would silently record
   * "not delivered" for every line the foreman did not mention.
   */
  protected cycleDelivered(id: string): void {
    this.draft.update((d) => ({
      ...d,
      materials: d.materials.map((row) =>
        row.id === id
          ? { ...row, delivered: row.delivered === null ? true : row.delivered ? false : null }
          : row,
      ),
    }));
  }

  protected deliveredKey(item: DraftMaterial): string {
    if (item.delivered === true) {
      return 'archive.materials.delivered';
    }
    return item.delivered === false
      ? 'archive.materials.notDelivered'
      : 'confirm.delivered.unknown';
  }

  protected deliveredTone(item: DraftMaterial): string {
    if (item.delivered === true) {
      return 'ok';
    }
    return item.delivered === false ? 'warn' : 'neutral';
  }

  protected addBlocker(): void {
    this.draft.update((d) => ({ ...d, blockers: [...d.blockers, newBlocker()] }));
  }

  protected removeBlocker(id: string): void {
    this.draft.update((d) => ({ ...d, blockers: d.blockers.filter((row) => row.id !== id) }));
  }

  protected patchBlocker(id: string, patch: Partial<DraftBlocker>): void {
    this.draft.update((d) => ({ ...d, blockers: patchRow(d.blockers, id, patch) }));
  }

  protected addHiddenWork(): void {
    this.draft.update((d) => ({ ...d, hiddenWork: [...d.hiddenWork, newHiddenWork()] }));
  }

  protected removeHiddenWork(id: string): void {
    this.draft.update((d) => ({ ...d, hiddenWork: d.hiddenWork.filter((row) => row.id !== id) }));
  }

  protected patchHiddenWork(id: string, patch: Partial<DraftHiddenWork>): void {
    this.draft.update((d) => ({ ...d, hiddenWork: patchRow(d.hiddenWork, id, patch) }));
  }

  protected setNotes(value: string): void {
    this.draft.update((d) => ({ ...d, notes: value }));
  }

  /**
   * Put the transcript into the notes field, on an explicit tap.
   *
   * The cheapest possible usable record when extraction produced nothing: his own words, kept as
   * the note, in one action. Deliberately **not** automatic — `corrected` is the human's answer
   * and the eval set's third column, and pre-filling it with the transcript would make every
   * unedited entry look like a person had agreed the transcript was the record.
   */
  protected transcriptToNotes(): void {
    const transcript = this.transcript();
    if (!transcript) {
      return;
    }
    this.draft.update((d) => ({
      ...d,
      notes: d.notes.trim() ? `${d.notes.trim()}\n${transcript}` : transcript,
    }));
  }

  // ---- Confirming ---------------------------------------------------------------------------

  protected async confirm(): Promise<void> {
    if (!this.canConfirm()) {
      return;
    }
    await this.attempt(false, (id) => this.confirmations.confirm(id, this.draft()));
  }

  /**
   * "These are my words — send them." One tap, no typing (PROJECT.md §11, founder ruling 3).
   *
   * The floor of the product: with the transcript right and every AI downstream of it broken, a
   * foreman still finishes his day. What goes out is his own description, marked as such, and the
   * screen says so plainly both before and after — a verbatim day must never feel like the good
   * path, or nothing ever creates pressure to notice that extraction has stopped working.
   */
  protected async confirmVerbatim(): Promise<void> {
    const words = this.transcript();
    if (!words || !this.canConfirmVerbatim()) {
      return;
    }
    await this.attempt(true, (id) => this.confirmations.confirmVerbatim(id, words));
  }

  private async attempt(
    verbatim: boolean,
    run: (entryId: string) => Promise<ConfirmResult>,
  ): Promise<void> {
    this.sending.set(true);
    this.attemptWasVerbatim.set(verbatim);
    this.failure.set(null);
    this.failureRetryable.set(false);

    const result = await run(this.entryId());

    this.sending.set(false);
    if (result.entry) {
      this.remote.set(result.entry);
      this.remoteLoaded.set(true);
    }
    if (result.ok) {
      this.justConfirmed.set(true);
      return;
    }
    this.failure.set(result.failure);
    this.failureRetryable.set(result.retryable);
  }

  /** Back to correcting after a confirmation, which the server allows until the report goes out. */
  protected revise(): void {
    this.justConfirmed.set(false);
    this.failure.set(null);
    this.failureRetryable.set(false);
    this.attemptWasVerbatim.set(false);
  }

  protected audioUrl(): string | null {
    const audio = this.audio();
    return audio ? this.urls.get(audio.id, audio.blob) : null;
  }

  protected back(): void {
    void this.router.navigate(['/']);
  }

  protected done(): void {
    void this.router.navigate(['/']);
  }

  /** The read-only record, for an entry this screen may not edit. */
  protected openRecord(): void {
    void this.router.navigate(['/diary'], { queryParams: { [ARCHIVE_ENTRY_PARAM]: this.entryId() } });
  }
}

function patchRow<T extends { id: string }>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}
