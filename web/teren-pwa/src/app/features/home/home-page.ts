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

  /** The chip on a recent row: the server's word if we have it, otherwise the phone's own. */
  protected statusKey(entry: LocalEntry): string {
    switch (entry.serverStatus) {
      case 'awaiting_confirmation':
      case 'needs_review':
        return 'entry.status.awaitingReview';
      case 'confirmed':
        return 'entry.status.confirmed';
      case 'reported':
        return 'entry.status.reported';
      default:
        break;
    }
    // A draft says the same thing a queued entry says, because it is the same thing to the person
    // holding the phone: this has not reached the server yet.
    return entry.status === 'failed' ? 'pending.status.failed' : 'pending.status.queued';
  }

  protected statusTone(entry: LocalEntry): 'ok' | 'warn' | 'err' | 'neutral' {
    if (entry.serverStatus === 'reported') {
      return 'ok';
    }
    if (entry.serverStatus === 'confirmed') {
      return 'neutral';
    }
    if (entry.status === 'failed') {
      return 'err';
    }
    return 'warn';
  }
}
