import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { of, switchMap } from 'rxjs';

import { AppStatus } from '../../core/app-status.service';
import { EntryStore } from '../../core/db/entry-store';
import { DayLabel, dayLabel, localDay } from '../../core/db/local-day';
import { LocalEntry, Project } from '../../core/db/models';
import { ProjectService } from '../../core/projects/project.service';
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
    '(document:visibilitychange)': 'refreshDay()',
    '(document:keydown.escape)': 'closePicker()',
  },
})
export class HomePage {
  private readonly router = inject(Router);
  private readonly entries = inject(EntryStore);
  private readonly projects = inject(ProjectService);
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

  /** The first entry recorded today, which is what the today card reports on. */
  protected readonly todayEntry = computed<LocalEntry | null>(() => this.todayEntries()[0] ?? null);

  /** "Danas" / "Juče" / a date, for a recent row. */
  protected dayLabel(entry: LocalEntry): DayLabel {
    return dayLabel(entry.capturedAt, this.day());
  }

  protected refreshDay(): void {
    this.day.set(localDay(new Date()));
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

  /** Open the record. C3's archive is where a finished entry actually lives. */
  protected openEntry(entry: LocalEntry): void {
    void this.router.navigate(['/dnevnik'], { queryParams: { unos: entry.id } });
  }

  protected openArchive(): void {
    void this.router.navigate(['/dnevnik']);
  }

  /**
   * The chip on a recent row: the server's word if we have it, otherwise the phone's own.
   *
   * Shared with the archive list and the entry record (`ui/entry-status.ts`) rather than repeated
   * per screen — a recent row and the archive row for the same entry disagreeing about its state
   * would leave the foreman to work out which of his own screens to believe.
   */
  protected statusKey(entry: LocalEntry): string {
    return entryStatusKey(entry.serverStatus, entry.status);
  }

  protected statusTone(entry: LocalEntry): StatusTone {
    return entryStatusTone(entry.serverStatus, entry.status);
  }
}
