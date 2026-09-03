import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { map, of, startWith, switchMap } from 'rxjs';

import { EntryListItemResponse } from '../../core/api/api-types';
import { isSupersededAfterSend } from '../../core/api/failure-reason';
import {
  ArchiveRow,
  groupArchiveRowsByDay,
  mergeArchiveRows,
} from '../../core/archive/archive-rows';
import { ARCHIVE_ENTRY_PARAM } from '../../core/archive/archive-route';
import { ArchiveService, RemoteStatus } from '../../core/archive/archive.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore } from '../../core/db/entry-store';
import { DayLabel, dayLabel, localDay } from '../../core/db/local-day';
import { LocalEntry, canRevise } from '../../core/db/models';
import { ProjectService } from '../../core/projects/project.service';
import { AppHeader } from '../../ui/app-header';
import { NOTHING_PAINTED, arrivals, isFresh, settle } from '../../ui/arrival';
import { DurationPipe } from '../../ui/duration.pipe';
import { entryStatusKey, entryStatusTone } from '../../ui/entry-status';
import { Icon } from '../../ui/icon';
import { PluralService } from '../../ui/plural.service';
import { ViewportService } from '../../ui/viewport.service';
import { EntryDetail } from './entry-detail';

/**
 * The archive (ROADMAP C3): past entries for a site, by day, and the record behind each one.
 *
 * **Why this screen is the pitch.** The foreman is paid back by the thirty seconds capture costs
 * him; the *owner* pays a subscription because the archive wins disputes (PROJECT.md §2). This is
 * the screen where a record from four months ago is produced, with the words that were spoken and
 * the photographs of what was covered up. Everything else in the product feeds it.
 *
 * **One component, one route.** `/diary` is the list and `/diary?entry=<id>` is a record — and
 * on a wide screen both are on screen at once, so they are one component driven by the presence of
 * a query parameter rather than two that would each have to know about the other. See
 * {@link ArchivePage.selectedId} for why a query parameter and not a path segment.
 *
 * ### The three device classes
 *
 * - **Compact (<768)** — two screens, one at a time. A phone has room for a list or a record, not
 *   both, and the back gesture must mean "close the record", which only works if the record is a
 *   route of its own.
 * - **Medium (768–1023)** — the same two screens on a wider, better-proportioned column. A
 *   master–detail split at 768 would leave a 320 px list beside a 380 px record and make both
 *   worse than either alone; a tablet reads this the way it reads a document.
 * - **Expanded (≥1024)** — **two panes, list and record side by side.** This is the layout the
 *   screen is really for: the person going through an archive is comparing days, not reading one,
 *   and a list that vanishes every time a record is opened turns "which day was the riser done?"
 *   into a sequence of round trips. The list keeps a fixed rail, the record scrolls beside it,
 *   and with no record open the right-hand pane says which one to pick rather than sitting blank.
 *
 * Which panes exist is decided in TypeScript, not by `display: none` (see {@link ViewportService}):
 * rendering the record behind a hidden list would mint object URLs for photographs nobody is
 * looking at, on a phone, in the sun.
 */
const REASON_KEYS: Record<RemoteStatus, string> = {
  // Never shown: `ok` is not a reason. Present so the record is exhaustive over the union.
  ok: 'archive.partial.unavailable',
  offline: 'archive.partial.offline',
  unauthorized: 'archive.partial.unauthorized',
  not_configured: 'archive.partial.notConfigured',
  unavailable: 'archive.partial.unavailable',
};

@Component({
  selector: 'app-archive-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, DurationPipe, EntryDetail, Icon, TranslocoDirective],
  templateUrl: './archive-page.html',
  styleUrl: './archive-page.css',
  host: { '(document:visibilitychange)': 'refreshDay()' },
})
export class ArchivePage {
  private readonly router = inject(Router);
  private readonly entries = inject(EntryStore);
  private readonly archive = inject(ArchiveService);
  private readonly projects = inject(ProjectService);
  private readonly viewport = inject(ViewportService);
  protected readonly connectivity = inject(ConnectivityService);
  protected readonly plural = inject(PluralService);

  /**
   * Which record is open, as `?entry=<id>` on the archive route.
   *
   * A query parameter rather than a path segment, and the reason is the expanded layout. Two
   * sibling routes (`diary` and `diary/:entryId`) are two different route configs, and
   * Angular's default reuse strategy destroys and rebuilds the component when the config changes
   * — so on a desktop every click in the list rail would tear down the rail, re-read Dexie and
   * re-ask the server, and the list the user is comparing days in would flash on every day. A
   * query parameter is one route: the record swaps, the rail does not move, and the phone's back
   * gesture still means "close the record" because it is still a navigation.
   */
  protected readonly selectedId = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get(ARCHIVE_ENTRY_PARAM))),
    { initialValue: null },
  );

  protected readonly project = this.projects.selected;
  protected readonly expanded = this.viewport.expanded;

  protected readonly remoteItems = signal<EntryListItemResponse[]>([]);
  protected readonly remoteStatus = signal<RemoteStatus>('ok');
  protected readonly remoteLoaded = signal(false);

  /** Today, refreshed when the app comes back to the front, so "Danas" cannot go stale. */
  protected readonly day = signal(localDay(new Date()));

  private readonly projectId = computed(() => this.project()?.id ?? null);

  /**
   * What the phone holds, **and whether it has answered**.
   *
   * The Dexie live query resolves a tick after the screen paints, so with a bare empty initial
   * value the archive's first frame was the full empty state — the book glyph and *"Arhiva je
   * prazna"* — over a site with four years of entries. On the archive that sentence is worse than
   * merely wrong: this is the screen that wins disputes, and the first thing it said was that there
   * was nothing to win one with. A skeleton says "I do not know yet", which is what is true.
   */
  private readonly localState = toSignal(
    toObservable(this.projectId).pipe(
      switchMap((id) =>
        id
          ? this.entries
              .watchEntriesForProject(id)
              .pipe(map((rows) => ({ loaded: true, rows: rows as LocalEntry[] })))
          : of({ loaded: true, rows: [] as LocalEntry[] }),
      ),
      startWith({ loaded: false, rows: [] as LocalEntry[] }),
    ),
    { initialValue: { loaded: false, rows: [] as LocalEntry[] } },
  );

  private readonly localEntries = computed(() => this.localState().rows);
  private readonly localLoaded = computed(() => this.localState().loaded);

  /**
   * The archive itself: what the phone holds, merged with what the server listed.
   *
   * Local first and always — the list paints from Dexie before any network call resolves, and
   * keeps painting when none ever does. An archive that hid unsent work would contradict
   * principle 3, and one that went blank in a basement would be worthless on a site.
   */
  protected readonly rows = computed<ArchiveRow[]>(() =>
    mergeArchiveRows(this.localEntries(), this.remoteItems()),
  );

  protected readonly groups = computed(() => groupArchiveRowsByDay(this.rows()));

  /**
   * Nothing to draw yet, as opposed to nothing to draw.
   *
   * Only about the **local** read: the server's part of the list is allowed to be missing for ever
   * (that is what the partial banner is for), and a screen that waited for a network answer before
   * showing what the phone holds would be blank in the basement where it is read.
   */
  protected readonly listLoading = computed(() => !this.localLoaded() && this.rows().length === 0);

  /**
   * Which days arrived while the list was on screen (`ui/arrival.ts`).
   *
   * **Folded only once both halves have answered**, and that is the whole subtlety here. The
   * archive's list is a merge: the phone's rows paint first and the server's forty land a moment
   * later. Folded from the first frame, that second list would be forty "new" rows animating at
   * once on every single load — the noise this mechanism exists to avoid, delivered by the
   * mechanism itself. So the first *complete* list is adopted silently, and what moves afterwards
   * is a real arrival: an entry recorded on this phone, or a day another foreman just sent up.
   */
  private readonly listArrival = signal(NOTHING_PAINTED);

  /** The list is on screen whenever there is no record open, and always at expanded width. */
  protected readonly showList = computed(() => this.expanded() || this.selectedId() === null);

  protected readonly showRecord = computed(() => this.selectedId() !== null);

  /**
   * Whether the list on screen is knowingly partial.
   *
   * The distinction the archive cannot afford to blur: "this site has four entries" and "this is
   * the four entries your phone happens to hold". Only reported once the server has actually been
   * asked, so the first frame does not accuse a working connection of being down.
   */
  protected readonly partial = computed(
    () => this.remoteLoaded() && this.remoteStatus() !== 'ok' && this.rows().length > 0,
  );

  protected readonly emptyAndOffline = computed(
    () => this.remoteLoaded() && this.remoteStatus() !== 'ok' && this.rows().length === 0,
  );

  /**
   * The reason copy for whichever of the two above is showing.
   *
   * Mapped rather than concatenated: `RemoteStatus` carries the API layer's snake_case
   * (`not_configured`) and the dictionaries are camelCase throughout, so the join is written
   * out where a missing case is a compile error instead of a blank line on screen.
   */
  protected readonly remoteReasonKey = computed(() => REASON_KEYS[this.remoteStatus()]);

  /**
   * Whether server rows fetched earlier are still on screen behind a failed refresh.
   *
   * It changes what the banner may claim. "Showing only what is on this phone" is true of a
   * cold start with no network and false the moment a previous fetch’s rows are still standing,
   * so the two cases get different sentences rather than one that is right half the time.
   */
  protected readonly stale = computed(
    () => this.remoteStatus() !== 'ok' && this.remoteItems().length > 0,
  );

  constructor() {
    // The arrival fold. It deliberately reads nothing until both halves of the merge have
    // answered — see `listArrival` — so the early `return` is load-bearing rather than a guard
    // against undefined: it also keeps `rows()` untracked until that moment.
    effect(() => {
      if (!this.localLoaded() || !this.remoteLoaded()) {
        return;
      }
      const ids = this.rows().map((row) => row.id);
      this.listArrival.update((previous) => arrivals(previous, ids));
    });

    // **Below 1024 the list is removed when a record is opened** (`@if (showList())`), and coming
    // back rebuilds every row from scratch. Ids still sitting in `fresh` would therefore animate a
    // second time, on rows the reader has already seen — the noise this mechanism exists to avoid,
    // arrived at from the other direction. A list that stops being drawn has been seen or missed;
    // either way it is no longer arriving. `settle` returns the same value when there is nothing to
    // clear, so this cannot loop.
    effect(() => {
      if (!this.showList()) {
        this.listArrival.update(settle);
      }
    });

    // Re-read whenever the site changes or the network comes back. Both are moments where what
    // the server would say has changed, and neither should need a manual refresh on a screen
    // somebody is scrolling.
    effect(() => {
      const id = this.projectId();
      // Tracked deliberately: regaining a network is exactly when a partial archive should heal.
      this.connectivity.online();

      if (!id) {
        this.remoteItems.set([]);
        this.remoteLoaded.set(true);
        return;
      }

      void this.archive.listEntries(id).then((result) => {
        if (this.projectId() !== id) {
          return;
        }
        // A failed refresh reports, it does not erase. Overwriting with the empty list that a
        // failure returns would collapse forty server days to the phone’s four mid-scroll,
        // throwing away rows fetched successfully a second ago — hiding something true, which
        // is the one thing an evidence screen may never do. Last-known-good stands; only the
        // status changes, and the banner says the view may be incomplete.
        if (result.status === 'ok') {
          this.remoteItems.set(result.items);
        }
        this.remoteStatus.set(result.status);
        this.remoteLoaded.set(true);
      });
    });
  }

  protected refreshDay(): void {
    this.day.set(localDay(new Date()));
  }

  /** Whether this day arrived after the list was first complete — see {@link listArrival}. */
  protected arrived(row: ArchiveRow): boolean {
    return isFresh(this.listArrival(), row.id);
  }

  protected label(row: ArchiveRow): DayLabel {
    return dayLabel(`${row.day}T12:00:00`, this.day());
  }

  /**
   * `row.onServer` is the merge’s reading of `received_at`, so a server row whose evidence is
   * not sealed is not allowed to call itself received.
   */
  protected statusKey(row: ArchiveRow): string {
    return entryStatusKey(row.serverStatus, row.localStatus, row.onServer);
  }

  protected statusTone(row: ArchiveRow): string {
    return entryStatusTone(row.serverStatus, row.localStatus, row.onServer);
  }

  protected open(row: ArchiveRow): void {
    this.openId(row.id);
  }

  /**
   * Open a record by id — the row itself, or the correction that replaced it.
   *
   * One navigation for both, and that is not only tidiness: `app.routes.spec.ts` resolves every
   * `navigate([…])` in the app against the real table and pins the count, so a second call site
   * spelling the same URL is a second thing that can drift. It also keeps `?entry=` behind
   * `ARCHIVE_ENTRY_PARAM` in one place — the coupling F4b broke.
   */
  protected openId(entryId: string): void {
    void this.router.navigate(['/diary'], { queryParams: { [ARCHIVE_ENTRY_PARAM]: entryId } });
  }

  /**
   * Whether this day may still be corrected — and therefore whether the row offers the way back.
   *
   * The archive is where this belongs and Home is where it does not. Home's attention row asks
   * "what is waiting on a person?" and a confirmed entry is waiting on nobody; putting it there
   * would nag a foreman about work he has already finished. Here he is *looking* for a past
   * entry, which is exactly the moment he notices the typo.
   */
  protected revisable(row: ArchiveRow): boolean {
    // **The wasted tap, removed** (2026-09-03). `GET /api/entries` now carries `failure_reason` on
    // the row, so the list can finally tell the two apart: a record the server refused to seal is
    // `confirmed` with no `reported_at`, which is exactly the shape `canRevise` reads as "he may
    // still change his mind". Until the reason arrived, this row offered "Ispravi" on the one
    // entry whose gate can only say no — and the way *forward* is the correction card on the
    // record, which is where the sentence explaining the dead end already lives.
    //
    // A null reason is silence and not an answer (`core/api/failure-reason.ts`): a local-only row,
    // or a page from an older server, behaves exactly as it did before.
    return canRevise(row.serverStatus, row.reportedAt) && !isSupersededAfterSend(row.failureReason);
  }

  /**
   * Straight to the gate, not to the record first.
   *
   * The one action behind this button is correcting the entry; routing through the read-only
   * record would put a screen he did not ask for between the tap and the form.
   */
  protected revise(row: ArchiveRow): void {
    void this.router.navigate(['/confirm', row.id]);
  }

  /**
   * Back means "close the record" while one is open on a narrow screen, and "leave the archive"
   * otherwise — including at expanded width, where the record never covered the list in the first
   * place and closing it would be a step the user did not take.
   */
  protected back(): void {
    if (this.selectedId() !== null && !this.expanded()) {
      void this.router.navigate(['/diary']);
      return;
    }
    void this.router.navigate(['/']);
  }
}
