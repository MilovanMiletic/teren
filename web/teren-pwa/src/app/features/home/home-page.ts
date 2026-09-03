import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { map, of, startWith, switchMap } from 'rxjs';

import { AppStatus } from '../../core/app-status.service';
import { ARCHIVE_ENTRY_PARAM } from '../../core/archive/archive-route';
import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore } from '../../core/db/entry-store';
import { DayLabel, dayLabel, localDay } from '../../core/db/local-day';
import { LocalEntry, Project, needsConfirmation } from '../../core/db/models';
import { ProjectService } from '../../core/projects/project.service';
import { RETURN_URL_PARAM } from '../../core/session/return-url';
import { EntryStatusRefresher } from '../../core/sync/entry-status-refresh.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { ArrivalHandoff, NOTHING_PAINTED, arrivals, isFresh } from '../../ui/arrival';
import { DurationPipe } from '../../ui/duration.pipe';
import { StatusTone, entryStatusKey, entryStatusTone } from '../../ui/entry-status';
import { Icon } from '../../ui/icon';
import { InstallInvitation } from '../../ui/install-invitation';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { PluralService } from '../../ui/plural.service';
import { CompanyLink } from '../../ui/company-link';
import { PlatformLink } from '../../ui/platform-link';
import { ProfileLink } from '../../ui/profile-link';

/**
 * The home screen (`design/Home.dc.html`): which site, was today recorded, the record button, what
 * is still waiting to be sent, and the last few entries — read from the local store, so it tells
 * the same truth in airplane mode as it does on Wi-Fi.
 */
@Component({
  selector: 'app-home-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeader,
    CompanyLink,
    DatePipe,
    DurationPipe,
    Icon,
    InstallInvitation,
    LanguageSwitcher,
    PlatformLink,
    ProfileLink,
    TranslocoDirective,
  ],
  templateUrl: './home-page.html',
  styleUrl: './home-page.css',
  host: {
    '(document:visibilitychange)': 'onVisibilityChange()',
    '(document:keydown.escape)': 'closePicker()',
  },
})
export class HomePage {
  private readonly router = inject(Router);
  private readonly entries = inject(EntryStore);
  private readonly projects = inject(ProjectService);
  private readonly statuses = inject(EntryStatusRefresher);
  private readonly connectivity = inject(ConnectivityService);
  /**
   * The action log (D5).
   *
   * A recent row cannot declare its own slug, because it is two actions wearing one control: an
   * entry the server has handed back opens the confirmation gate and everything else opens the
   * record. A `data-log` attribute would have to claim one of them and would be wrong about the
   * other, so the branch is what does the recording.
   */
  private readonly actions = inject(ActionLogService);
  protected readonly plural = inject(PluralService);
  protected readonly status = inject(AppStatus);

  protected readonly projectList = this.projects.projects;
  protected readonly project = this.projects.selected;
  protected readonly pickerOpen = signal(false);

  /**
   * Today, as a signal rather than a constant: a phone left on the site fence overnight must not
   * still claim yesterday's entry as today's. Refreshed whenever the app comes back to the front.
   */
  protected readonly day = signal(localDay(new Date()));
  protected readonly now = computed(() => {
    this.day();
    return new Date();
  });

  private readonly projectId = computed(() => this.project()?.id ?? null);

  private readonly todayEntries = toSignal(
    toObservable(computed(() => ({ id: this.projectId(), day: this.day() }))).pipe(
      switchMap(({ id, day }) => (id ? this.entries.watchEntriesForDay(id, day) : of([]))),
    ),
    { initialValue: [] as LocalEntry[] },
  );

  /**
   * The last few entries, **and whether the store has answered yet** — two facts in one value,
   * because on this screen they are read together and getting them out of step is a lie.
   *
   * The store is a Dexie live query: it resolves a tick after the screen paints. With a bare
   * `initialValue: []` the first frame is therefore indistinguishable from an empty site, and Home
   * printed *"Još nema unosa"* — "no entries yet" — under a foreman's four years of work, for one
   * frame, on every single load. A skeleton is the honest answer to "I do not know yet"; the empty
   * sentence is the answer to "there are none", and now only one of them can be on screen at a time.
   */
  private readonly recentState = toSignal(
    toObservable(this.projectId).pipe(
      switchMap((id) =>
        id
          ? this.entries.watchRecentEntries(id).pipe(
              map((rows) => ({ loaded: true, rows: rows as LocalEntry[] })),
              // **Inside the switchMap, so it fires on every site change and not only on the
              // first subscription.** Without it, choosing another site left the previous site’s
              // rows on screen with `loaded: true` until Dexie answered — so the arrival fold
              // adopted one site’s list and then saw the other’s as five things arriving, and
              // five rows bounced on every switch (measured). A different site is a read that
              // has not happened yet, which is what the skeleton says.
              startWith({ loaded: false, rows: [] as LocalEntry[] }),
            )
          : // No site chosen is not a pending read: there is nothing to wait for, so the empty
            // state is the truth immediately.
            of({ loaded: true, rows: [] as LocalEntry[] }),
      ),
    ),
    { initialValue: { loaded: false, rows: [] as LocalEntry[] } },
  );

  protected readonly recent = computed(() => this.recentState().rows);

  /** Waiting on the local store. Drawn as the shape of the rows that are coming, never as prose. */
  protected readonly recentLoading = computed(() => !this.recentState().loaded);

  /**
   * Which recent rows arrived while he was looking at this screen (`ui/arrival.ts`).
   *
   * This is the founder’s *"when some new entry was added"*. It has two halves, and the first cut
   * of this shipped with the wrong one:
   *
   * - **The entry he has just recorded.** A diff cannot find it. Home is destroyed and rebuilt by
   *   the router, so this fold starts from nothing and the new entry is in the very first list it
   *   sees — adopted silently by the rule that a first paint animates nothing. The capture flow
   *   therefore *names* it on its way out ({@link ArrivalHandoff}) and it is seeded into the first
   *   fold below. Without that seed the feature fired in no real case at all: measured after the
   *   pass shipped as one row on screen and none animating.
   * - **A day that lands while he stands there.** That one is a plain diff: the sweeper finishes,
   *   `EntryStatusRefresher` re-reads, a row appears.
   *
   * And one case must animate *nothing*: **changing site**. The returning site’s rows are not
   * arriving, they are being read for the first time — so the fold is reset when the project
   * changes, and `recentState` reports an unanswered read until Dexie answers for the new one.
   */
  private readonly recentArrival = signal(NOTHING_PAINTED);

  /**
   * The entry the capture flow named on its way here, read **once**, at construction.
   *
   * Read here rather than inside the fold because the fold runs many times — on every poll, every
   * status refresh — and `take()` clears the hand-off. Read there, the second run would find it
   * empty and which run got the id would depend on the order of two effects.
   */
  private readonly justRecorded = inject(ArrivalHandoff).take();

  protected readonly pendingCount = toSignal(this.entries.watchPendingCount(), { initialValue: 0 });

  /**
   * How many of those are not merely waiting but stuck — blocked outright, or retrying long past
   * the point where "any moment now" is credible.
   *
   * The sync row changes its words when this is non-zero. "Čekaju slanje: 2" over an entry the
   * server has refused is true and still misleading, and this is the screen the foreman actually
   * looks at.
   */
  protected readonly stuckCount = toSignal(this.entries.watchStuckCount(), { initialValue: 0 });

  /**
   * How many of the stuck ones are stuck on **this phone's credential** (F8).
   *
   * The one stuck-ness a foreman can fix himself, and the one the sync row's words are wrong
   * about: "not getting through" invites him to wait, and waiting is exactly what will not work.
   *
   * ## Since 2026-09-03 this is a fallback rather than the mechanism
   *
   * It used to be the whole of it: a revoked phone kept its session, kept the record button and
   * learned about the refusal here (plan §10.3, "never a locked door"). **By founder decision of
   * 2026-09-03 a refused phone signs itself out**, so the ordinary way a foreman finds out is now
   * the sentence on `/welcome` — reached on the first 401, with an empty outbox, in a second rather
   * than after eight failed attempts and half an hour of backoff.
   *
   * **One residual case keeps the row, and it is narrower than it first looks.** Rows an older
   * build wrote: `failed` with `unauthenticated` past the eight-attempt bar, carried across an
   * upgrade. `releaseBlockedByAuth` does not touch them (it works on `blocked` rows), so they
   * survive a re-activation and sit here until the loop's next attempt clears them.
   *
   * Nothing else reaches it any more, and the first draft of this comment claimed two cases that
   * cannot happen. A refusal during a recording does **not** land a man on Home — the deferred
   * navigation fires the moment the recorder is idle and Home is device-gated by then — and a live
   * session can no longer climb to eight failures, because the first 401 stops the loop dead.
   *
   * It is a notice and a way forward, never a gate — the record button above it is untouched.
   */
  protected readonly reactivationCount = toSignal(this.entries.watchReactivationCount(), {
    initialValue: 0,
  });

  /**
   * Entries the server has handed back to the human (B5).
   *
   * This is the screen the foreman actually looks at, so it is the screen that has to admit the
   * confirmation gate exists. Without this row an entry sitting in `needs_review` is invisible
   * from the front door, he never opens it, and the day's evidence never becomes a report —
   * shipping the gate without shipping the way to it.
   */
  protected readonly awaiting = toSignal(
    toObservable(this.projectId).pipe(
      switchMap((id) => (id ? this.entries.watchAwaitingConfirmation(id) : of([]))),
    ),
    { initialValue: [] as LocalEntry[] },
  );

  protected readonly awaitingCount = computed(() => this.awaiting().length);

  /** The first entry recorded today, which is what the today card reports on. */
  protected readonly todayEntry = computed<LocalEntry | null>(() => this.todayEntries()[0] ?? null);

  constructor() {
    // Which rows are new is a fold over successive lists, so it is computed once per list rather
    // than per render: a `computed` that wrote to a signal would be a side effect in a derivation,
    // and reading it twice in one frame would then answer differently.
    //
    // **It does not fold until the store has answered**, and that guard is not defensive — without
    // it the skeleton *creates* the defect it was added to fix. The loading frame is an empty list,
    // so the fold would adopt *that* as the first paint and then see the foreman’s five real
    // entries as five arrivals, animating the whole list on every load. The unanswered state is not
    // a list, and it is not adopted as one.
    //
    // **And it starts over when the site changes.** A different site’s entries are a first read,
    // not five arrivals; diffed against the site he came from, every row of the one he came back to
    // is "new". That was the state this shipped in.
    let folding: string | null | undefined;
    effect(() => {
      const project = this.projectId();
      const state = this.recentState();

      if (project !== folding) {
        folding = project;
        this.recentArrival.set(NOTHING_PAINTED);
      }

      if (!state.loaded) {
        return;
      }

      this.recentArrival.update((previous) =>
        arrivals(
          previous,
          state.rows.map((entry) => entry.id),
          // Seeded on the first paint only, and ignored if the entry is not in the list. This is
          // the entry he has just recorded, named by the screen he came from.
          this.justRecorded,
        ),
      );
    });

    // Re-ask the server what it now thinks of this project's entries. Runs when the site changes
    // and when the network comes back — the two moments where the answer can have changed while
    // nobody was looking.
    effect(() => {
      const id = this.projectId();
      // Tracked deliberately: regaining a connection is exactly when a stale Home should heal.
      this.connectivity.online();
      if (id) {
        void this.statuses.refresh(id);
      }
    });

    // And on a timer, because the interesting transition happens *while he is looking at this
    // screen*: he records, walks back to the van, and twenty seconds later the pipeline has
    // finished and the entry needs him. Polling, not a realtime transport (ARCHITECTURE §7) —
    // one screen cares and this is a handful of lines.
    if (typeof setInterval === 'function') {
      const timer = setInterval(() => this.refreshStatuses(), STATUS_POLL_INTERVAL_MS);
      inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }
  }

  /** Whether this row arrived after the list was first drawn — see {@link recentArrival}. */
  protected arrived(entry: LocalEntry): boolean {
    return isFresh(this.recentArrival(), entry.id);
  }

  /** "Danas" / "Juče" / a date, for a recent row. */
  protected dayLabel(entry: LocalEntry): DayLabel {
    return dayLabel(entry.capturedAt, this.day());
  }

  /**
   * Coming back to the app is the other moment worth re-asking: the phone was in a pocket while
   * the pipeline finished. Both jobs hang off the same event — the day may also have rolled over.
   */
  protected onVisibilityChange(): void {
    this.refreshDay();
    if (typeof document === 'undefined' || !document.hidden) {
      this.refreshStatuses();
    }
  }

  protected refreshDay(): void {
    this.day.set(localDay(new Date()));
  }

  private refreshStatuses(): void {
    const id = this.projectId();
    if (id) {
      void this.statuses.refresh(id);
    }
  }

  protected openPicker(): void {
    this.pickerOpen.set(true);
  }

  protected closePicker(): void {
    this.pickerOpen.set(false);
  }

  protected choose(project: Project): void {
    this.projects.select(project.id);
    this.pickerOpen.set(false);
  }

  protected record(): void {
    void this.router.navigate(['/record']);
  }

  protected openPending(): void {
    void this.router.navigate(['/pending']);
  }

  /**
   * To the code screen, carrying the way back to Home.
   *
   * `/activate` is unguarded on purpose (plan §10.3) so a phone that still holds a session can
   * reach it — this is that door. Nothing is signed out on the way and no evidence is touched: if
   * he changes his mind, he is back here with his queue exactly as it was.
   */
  protected reactivate(): void {
    void this.router.navigate(['/activate'], { queryParams: { [RETURN_URL_PARAM]: '/' } });
  }

  /**
   * Open a recent row.
   *
   * An entry the server has handed back goes to the confirmation gate, not to the archive: the
   * archive is a read-only record, and sending a foreman there over an entry that is waiting for
   * him would show him the problem and hide the only control that fixes it. Everything else goes
   * to the record, which is where a finished entry lives.
   */
  protected openEntry(entry: LocalEntry): void {
    if (needsConfirmation(entry.serverStatus)) {
      this.openConfirm(entry.id);
      return;
    }
    this.actions.record(ACTIONS.archiveEntryOpen, { entryId: entry.id });
    void this.router.navigate(['/diary'], { queryParams: { [ARCHIVE_ENTRY_PARAM]: entry.id } });
  }

  /**
   * The attention row: straight to the entry that has been waiting longest.
   *
   * Oldest first rather than a list of its own — the queue is normally one entry, and when it is
   * several, confirming one returns here with the next already on the row.
   */
  protected openOldestAwaiting(): void {
    const entry = this.awaiting()[0];
    if (entry) {
      this.openConfirm(entry.id);
    }
  }

  private openConfirm(entryId: string): void {
    this.actions.record(ACTIONS.confirmOpen, { entryId });
    void this.router.navigate(['/confirm', entryId]);
  }

  protected openArchive(): void {
    void this.router.navigate(['/diary']);
  }

  /**
   * The chip on a recent row.
   *
   * Two things are shared with the archive list and the entry record, and it is worth being
   * precise about which. The **wording** is shared (`ui/entry-status.ts`), so the same state is
   * never called two different things. The **data** is now shared too, but only because
   * `EntryStatusRefresher` re-reads `GET /api/entries` — the same list the archive merges — and
   * writes the live status back to this row. Before B5 it was not: `serverStatus` was written
   * once at upload time and never again, so Home said "Primljen" over entries the archive
   * correctly showed as `needs_review`, and "Primljen" reads as *done, nothing to do*.
   */
  protected statusKey(entry: LocalEntry): string {
    return entryStatusKey(entry.serverStatus, entry.status);
  }

  protected statusTone(entry: LocalEntry): StatusTone {
    return entryStatusTone(entry.serverStatus, entry.status);
  }

  protected attentionKey(count: number): string {
    return this.plural.key('home.attention', count);
  }
}

/**
 * How often Home re-asks the server for this project's statuses while it is on screen.
 *
 * Twenty seconds against a pipeline that takes roughly 20–60 (ARCHITECTURE §9): fast enough that
 * an entry needing attention surfaces while he is still standing there, slow enough that a phone
 * left open on a dashboard is not a poll every heartbeat. The call is a single list request and
 * writes nothing when nothing changed.
 */
const STATUS_POLL_INTERVAL_MS = 20_000;
