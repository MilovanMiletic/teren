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
import { of, switchMap } from 'rxjs';

import { AppStatus } from '../../core/app-status.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore } from '../../core/db/entry-store';
import { DayLabel, dayLabel, localDay } from '../../core/db/local-day';
import { LocalEntry, Project, needsConfirmation } from '../../core/db/models';
import { ProjectService } from '../../core/projects/project.service';
import { EntryStatusRefresher } from '../../core/sync/entry-status-refresh.service';
import { AppHeader } from '../../ui/app-header';
import { DurationPipe } from '../../ui/duration.pipe';
import { StatusTone, entryStatusKey, entryStatusTone } from '../../ui/entry-status';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { PluralService } from '../../ui/plural.service';

/**
 * The home screen (`design/Home.dc.html`): which site, was today recorded, the record button, what
 * is still waiting to be sent, and the last few entries — read from the local store, so it tells
 * the same truth in airplane mode as it does on Wi-Fi.
 */
@Component({
  selector: 'app-home-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, DurationPipe, Icon, LanguageSwitcher, TranslocoDirective],
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

  protected readonly recent = toSignal(
    toObservable(this.projectId).pipe(
      switchMap((id) => (id ? this.entries.watchRecentEntries(id) : of([]))),
    ),
    { initialValue: [] as LocalEntry[] },
  );

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
    void this.router.navigate(['/snimanje']);
  }

  protected openPending(): void {
    void this.router.navigate(['/cekaju']);
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
    void this.router.navigate(['/dnevnik'], { queryParams: { unos: entry.id } });
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
    void this.router.navigate(['/potvrda', entryId]);
  }

  protected openArchive(): void {
    void this.router.navigate(['/dnevnik']);
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
