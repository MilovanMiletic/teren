import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { FailureKind, STALLED_AFTER_ATTEMPTS } from '../../core/api/api-failure';
import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore, PendingEntry } from '../../core/db/entry-store';
import { DayLabel, dayLabel, localDay } from '../../core/db/local-day';
import { ProjectService } from '../../core/projects/project.service';
import { RETURN_URL_PARAM } from '../../core/session/return-url';
import { UploadService } from '../../core/sync/upload.service';
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
  private readonly uploads = inject(UploadService);
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
      // Stalled items are still `failed` in the queue, but they are counted separately here:
      // folding them into "trying again" would let a rail that exists to summarise the truth
      // report a week-old stuck entry as an ordinary retry.
      failed: items.filter((item) => item.outbox?.state === 'failed' && !this.isStalled(item))
        .length,
      stalled: items.filter((item) => this.isStalled(item)).length,
      blocked: byState('blocked'),
    };
  });

  private readonly today = localDay(new Date());

  protected back(): void {
    void this.router.navigate(['/']);
  }

  protected record(): void {
    void this.router.navigate(['/record']);
  }

  protected dayLabel(item: PendingEntry): DayLabel {
    return dayLabel(item.entry.capturedAt, this.today);
  }

  /**
   * Why this entry has not gone yet, in words derived from what the server actually said.
   *
   * Until B3 this screen printed one canned sentence — "connection dropped during upload" — under
   * every failure alike, which was a guess dressed as a diagnosis: it read the same whether the
   * phone was in a lift or the entry had been refused outright. The sync loop now classifies each
   * failure (`core/api/api-failure.ts`) and stores the kind on the outbox row, so what appears
   * here is a translation of a real verdict.
   *
   * Unknown kinds fall back to the generic line rather than showing a raw enum: a value this
   * build does not recognise is a future version's, not something to put in front of a foreman.
   */
  protected reasonKey(item: PendingEntry): string | null {
    const kind = item.outbox?.failureKind;
    if (!kind) {
      return null;
    }
    // Widened at this one crossing: the outbox stores `failureKind` as a plain string (the local
    // data model deliberately does not depend on the API layer's union), while the table above is
    // typed over `FailureKind` so the compiler can demand completeness. The fallback stays for the
    // genuinely unknown case — a value written by a *newer* build than this one.
    return (REASON_KEYS as Readonly<Record<string, string>>)[kind] ?? 'pending.reason.unknown';
  }

  /** A terminal item: the loop has stopped and only a person can move it. */
  protected isBlocked(item: PendingEntry): boolean {
    return item.outbox?.state === 'blocked';
  }

  /**
   * An item that is still being retried but has stopped being able to claim it is nearly there.
   *
   * The queue does not change at this point — the entry keeps its place and the loop keeps
   * trying, because an unreachable server is exactly the thing that comes back. What changes is
   * the wording: after half an hour of failures, "trying again" reads as progress, and a spinner
   * that looks like progress is the failure mode this whole screen exists to prevent.
   */
  protected isStalled(item: PendingEntry): boolean {
    return item.outbox?.state === 'failed' && item.outbox.attempts >= STALLED_AFTER_ATTEMPTS;
  }

  /**
   * The row is not getting through because **this phone's credential is not being accepted**, and
   * has been told so enough times for that to be a verdict rather than a blip.
   *
   * `unauthenticated` is F1's non-terminal 401: the entry stays in the queue and heals unattended
   * the moment the credential is good again, which is right, because "not accepted *at the
   * moment*" is what a revoked device, a suspended company and a phone that was never activated
   * all look like from here. One 401 during a token change is noise. Eight — about half an hour of
   * trying — is the app being told the same thing over and over, and at that point the foreman
   * needs to know that waiting will not fix it.
   *
   * **Derived, never stored.** There is no "revoked" flag on the phone and there must not be: the
   * server is the only thing that knows, revocation reaches this device as a 401 on next contact
   * (plan §7), and a local flag would be a second source of truth that goes stale in a basement.
   *
   * ## A fallback since 2026-09-03, and worth knowing which cases still reach it
   *
   * This eight-attempt bar was the *only* revocation surface in the product, and it needed a queued
   * entry to exist at all — with an empty outbox a revoked phone said nothing, ever. **By founder
   * decision a refused phone now signs itself out on the first 401**
   * (`core/session/device-refusal.service.ts`) and the sentence he reads is on `/welcome`.
   *
   * **One case still lands here**: rows an older build wrote — `failed` with `unauthenticated`,
   * past the bar, carried across an upgrade. `EntryStore.releaseBlockedByAuth` works on `blocked`
   * rows and leaves those alone, so they survive a re-activation and stay until the loop's next
   * attempt clears them; without this row they would be a queue that never moves with nothing on
   * screen saying why.
   *
   * Nothing else does. A refusal during a recording does not deliver a man here — the deferred
   * navigation fires as soon as the recorder is idle, and this screen is device-gated by then —
   * and a live session cannot reach eight failures any more, because the first 401 stops the loop.
   */
  protected needsReactivation(item: PendingEntry): boolean {
    return this.isStalled(item) && item.outbox?.failureKind === 'unauthenticated';
  }

  /**
   * Blocked or stalled: the two rows where the foreman has something worth pressing.
   *
   * **Minus the rows that need a new code**, which get their own action instead. "Pokušaj ponovo"
   * over a revoked device is a lie — the loop is already retrying it every ten minutes and will go
   * on doing so — and pressing it would change nothing while looking like it did. That row is not
   * waiting for another attempt; it is waiting for a credential.
   */
  protected canRetry(item: PendingEntry): boolean {
    return (this.isBlocked(item) || this.isStalled(item)) && !this.needsReactivation(item);
  }

  /** Whether anything at all on this screen is waiting for a credential rather than for a signal. */
  protected readonly reactivationCount = computed(
    () => this.pending().filter((item) => this.needsReactivation(item)).length,
  );

  /**
   * To the code screen, carrying the way back here.
   *
   * `/activate` is deliberately unguarded (plan §10.3) precisely so a phone that still holds a
   * session can reach it — this is that door. Nothing is signed out on the way: the session stays,
   * the queue stays, and if he abandons the screen he is exactly where he was.
   */
  protected reactivate(): void {
    void this.router.navigate(['/activate'], {
      queryParams: { [RETURN_URL_PARAM]: '/pending' },
    });
  }

  /** How many rows he would otherwise have to press one at a time. */
  protected readonly retryableCount = computed(
    () => this.pending().filter((item) => this.canRetry(item)).length,
  );

  /**
   * "Try all again" — the whole queue in one press.
   *
   * Deliberately built on exactly the rows {@link canRetry} already marks with their own button,
   * so the sweeping action and the per-row action can never disagree about what is retryable. A
   * button that said "try everything" and quietly skipped `rejected` or `insecure_context` rows —
   * leaving them still reading "Ne može da se pošalje" underneath it — would be this screen
   * telling a foreman something it does not know, which is the one thing it exists not to do.
   *
   * The loop is woken **once**, after every row has been released, rather than per row: a pass
   * that started against a half-released queue would leave the rest until the next tick.
   */
  protected retryAll(): void {
    const stuck = this.pending().filter((item) => this.canRetry(item));
    void Promise.all(stuck.map((item) => this.entries.retryNow(item.entry.id)))
      // Wake regardless. A store that refused one write must not also cost the foreman the pass
      // over the rows that *were* released — and with N rows instead of one, a rejection here is
      // no longer a theoretical branch. The queue is read from disk, so a failed release simply
      // leaves that row where it was and the screen keeps telling the truth about it.
      .catch(() => undefined)
      .then(() => this.uploads.wake());
  }

  /**
   * The foreman's "try again". Releases the item — from a terminal block, or from a backoff it
   * would otherwise wait out — and asks the loop to run now rather than at its next wake: he
   * pressed a button, he should see something happen.
   */
  protected retry(item: PendingEntry): void {
    void this.entries.retryNow(item.entry.id).then(() => this.uploads.wake());
  }
}

/**
 * `FailureKind` → translation key.
 *
 * Kept as a plain lookup rather than a `switch` in the template so that the set of user-facing
 * explanations is readable in one place, and so an unmapped kind is a missing entry here rather
 * than a fall-through to the wrong sentence.
 *
 * **`Record<FailureKind, string>`, not `Record<string, string>`**, and the difference is a
 * sentence a foreman reads. Untyped, a new kind — or a typo in an existing one — compiles happily
 * and lands on the `pending.reason.unknown` fallback, so the screen says "Slanje nije uspelo iz
 * nepoznatog razloga" about a failure the classifier had named precisely. Typed, the compiler
 * refuses until the new kind has a key, and `i18n.spec.ts` refuses until both dictionaries have a
 * sentence behind it. (The `unauthenticated` entry added in F1 would have been caught by this had
 * it been typed already; it was not, which is the whole argument.)
 */
export const REASON_KEYS: Readonly<Record<FailureKind, string>> = {
  offline: 'pending.reason.offline',
  unauthenticated: 'pending.reason.unauthenticated',
  server: 'pending.reason.server',
  storage: 'pending.reason.storage',
  incomplete: 'pending.reason.incomplete',
  rejected: 'pending.reason.rejected',
  unauthorized: 'pending.reason.unauthorized',
  not_configured: 'pending.reason.notConfigured',
  insecure_context: 'pending.reason.insecureContext',
  unknown: 'pending.reason.unknown',
};
