import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore, PendingEntry } from '../../core/db/entry-store';
import { DayLabel, dayLabel, localDay } from '../../core/db/local-day';
import { ProjectService } from '../../core/projects/project.service';
import { AppHeader } from '../../ui/app-header';
import { DurationPipe } from '../../ui/duration.pipe';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { PluralService } from '../../ui/plural.service';

/**
 * The sync queue (`design/Pending.dc.html` / `PendingEmpty.dc.html`).
 *
 * Every row is read from the outbox and from the drafts that have not reached it, so what this
 * screen says survives a reload, an app kill and airplane mode — the foreman must never have to
 * wonder whether his work vanished. B2 has no network, so every row is truthfully waiting; B3's
 * sync loop moves rows to `in_flight` and `failed` and this screen renders those without change.
 *
 * At expanded the list keeps its readable measure in the main pane and a rail carries the totals
 * and the trust note, rather than letting a phone list stretch across a desktop.
 */
@Component({
  selector: 'app-pending-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, DurationPipe, Icon, LanguageSwitcher, TranslocoDirective],
  templateUrl: './pending-page.html',
  styleUrl: './pending-page.css',
})
export class PendingPage {
  private readonly router = inject(Router);
  private readonly entries = inject(EntryStore);
  private readonly projects = inject(ProjectService);
  protected readonly plural = inject(PluralService);
  protected readonly connectivity = inject(ConnectivityService);

  protected readonly project = this.projects.selected;

  protected readonly pending = toSignal(this.entries.watchPending(), {
    initialValue: [] as PendingEntry[],
  });
  protected readonly count = computed(() => this.pending().length);

  /** The queue broken down by what each item is doing, for the expanded summary card. */
  protected readonly counts = computed(() => {
    const items = this.pending();
    const byState = (state: string) => items.filter((item) => item.outbox?.state === state).length;
    return {
      total: items.length,
      // A draft has not been handed over yet, which from the queue's side is the same wait.
      queued: items.filter((item) => !item.outbox || item.outbox.state === 'queued').length,
      uploading: byState('in_flight'),
      failed: byState('failed'),
    };
  });

  private readonly today = localDay(new Date());

  protected back(): void {
    void this.router.navigate(['/']);
  }

  protected record(): void {
    void this.router.navigate(['/snimanje']);
  }

  protected dayLabel(item: PendingEntry): DayLabel {
    return dayLabel(item.entry.capturedAt, this.today);
  }
}
