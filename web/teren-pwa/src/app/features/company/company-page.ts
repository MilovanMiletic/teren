import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import {
  CompanyService,
  CompanyStatus,
  Worker,
  serverAnswered,
} from '../../core/company/company.service';
import { AdminSessionService } from '../../core/session/admin-session.service';
import { AppHeader } from '../../ui/app-header';
import { Icon } from '../../ui/icon';
import { InfoPopover } from '../../ui/info-popover';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { ModalSheet } from '../../ui/modal-sheet';
import { SessionLink } from '../../ui/session-link';
import { ViewportService } from '../../ui/viewport.service';
import { companyReasonFor } from './company-reason';
import {
  DEFAULT_DIRECTION,
  PeopleSort,
  PeopleSortKey,
  StatusChip,
  sortWorkers,
  workerChips,
} from './people';

/** One line of the people list: the person, and the chips that say how he stands. */
interface PersonRow {
  worker: Worker;
  chips: StatusChip[];
}

/**
 * The office (`plans/profile-and-identity.md` §10.3, decisions 3, 9, 10, 13): **the company's
 * people, and nothing else**.
 *
 * ## What this screen is, after the rework of 2026-09-01
 *
 * It was a list of cards that opened in place, and each opened card held that man's activation
 * code, the message that carries it, two copy buttons, his phones with a revoke, and a paragraph
 * explaining how codes work. One foreman produced a scroll; ten would have been unusable, the
 * "new foreman" form dominated a tablet, and at 1920 a single card floated in an empty field while
 * the useful half of the screen was crammed into a narrow rail. The founder's verdict was "this
 * genuinely now is a bad UI", and he was right.
 *
 * So the office is two screens now. **This one is a directory**: who is in the company, grouped by
 * role, dense enough to read twelve men at a glance and sortable by the two questions an owner
 * actually asks — who is this, and who cannot record today. Everything about one man lives on his
 * own page (`worker-page.ts`), which is where the code, the message, the phones and the revoke
 * went.
 *
 * ## Decision 13 is now structural rather than stateful
 *
 * **No activation code, no share message and no copy action can render on this screen.** There is
 * no code path to one: this component never calls `readCode` or `issueCode`, holds no code state,
 * and imports nothing that could produce either. That matters because a code plus a **username**
 * activates a phone, so a message carrying several names and codes pasted into a site group chat
 * lets any man in that chat record evidence signed with another man's name — and attribution is
 * the thing the whole identity model exists to establish.
 *
 * The old screen kept that property by *arithmetic*: exactly one worker id in `revealed`, exactly
 * one `codeState`, and a careful reset on every open. It held. But it was one edit away from not
 * holding, because two codes on screen was a state the component could represent. Moving codes to a
 * per-worker route makes the safe thing the only thing the code can express — one URL, one man —
 * and the list is left with a boolean (`hasLiveCode`) that says a code is waiting without ever
 * naming it.
 *
 * ## Three deliberate layouts
 *
 *   compact   <768      a tight list of tappable rows: name and username on top, chips beneath, a
 *                       chevron. One row is one tap target and one navigation; nothing expands in
 *                       place, so a company of ten fits on two screens instead of ten.
 *   medium    768–1023  a real `<table>` on the 640 column, with the numbers as a strip above it —
 *                       not a phone column stretched.
 *   expanded  ≥1024     the table claims **all twelve columns**. There is no rail: the founder moved
 *                       adding a foreman into a dialog and "how codes work" into an info popover
 *                       (2026-09-01), both behind the head row's action cluster, because the rail
 *                       held the useful half of a 1920 screen while the table beside it held air.
 *
 * Which of the two renderings is drawn is decided in TypeScript, not by `display: none`
 * ({@link ViewportService}): a `<table>` whose cells are forced to `display: block` loses its table
 * role in every browser, so restyling one markup would give a phone the semantics of a table and a
 * screen reader the semantics of neither.
 *
 * ## Honest failure, per call
 *
 * Nothing here says "something went wrong". `CompanyStatus` keeps *offline*, *your sign-in has
 * expired*, *your role may not do this* and *the server is unwell* apart, because the remedy
 * differs and offering the wrong one is a screen lying. And where the server gave **no verdict at
 * all** ({@link serverAnswered}), a mutation is never reported as failed.
 */
@Component({
  selector: 'app-company-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeader,
    DatePipe,
    Icon,
    InfoPopover,
    LanguageSwitcher,
    ModalSheet,
    SessionLink,
    TranslocoDirective,
  ],
  templateUrl: './company-page.html',
  styleUrl: './company-page.css',
})
export class CompanyPage {
  private readonly company = inject(CompanyService);
  private readonly admins = inject(AdminSessionService);
  private readonly router = inject(Router);

  protected readonly viewport = inject(ViewportService);

  protected readonly loading = signal(true);
  protected readonly workers = signal<Worker[]>([]);
  /** How the last look at the list went. `ok` is the only value that lets the screen claim it. */
  protected readonly status = signal<CompanyStatus>('ok');

  /**
   * How the list is ordered, **in the component and not in the URL**.
   *
   * A sort is a way of looking at a list, not a place in the app: nobody sends somebody else a
   * link to "my foremen sorted by last contact", and the back gesture must mean "leave the office",
   * not "undo my last three column taps". Keeping it out of the URL also keeps it off the router —
   * a query parameter per tap would re-run `requiresCompanyAdmin` and, on this screen, re-read the
   * whole list from the server to paint the same rows in a different order.
   *
   * It starts on the name, ascending, which is the order `GET /api/workers` already returns
   * (`OrderBy(u => u.DisplayName)`), so the first paint does not visibly reorder itself.
   */
  protected readonly sort = signal<PeopleSort>({ key: 'name', direction: 'asc' });

  protected readonly addOpen = signal(false);
  protected readonly newName = signal('');
  protected readonly newEmail = signal('');
  protected readonly addBusy = signal(false);
  protected readonly addFailure = signal<CompanyStatus | null>(null);
  protected readonly addConflict = signal<'username' | 'email' | null>(null);

  /**
   * The company he administers, read off the credential itself — no network, and true before the
   * first paint. Signing out lives in the chrome (`session-link.ts`), and the admin's own name with
   * it.
   */
  protected readonly companyName = computed(() => this.admins.session()?.companyName ?? null);

  /**
   * The one director this screen can honestly show: the man reading it.
   *
   * **Deliberately not fetched.** The company-admin API exposes workers only
   * (`db.WorkersOf(companyId)` in `WorkerEndpoints.cs`) — there is no endpoint that lists a
   * company's admins, and adding one was explicitly out of scope for a frontend-only increment. So
   * the directors group holds exactly the session in this browser, marked as *you*, and the screen
   * invents nobody. One row is the correct answer today rather than a placeholder for a better one.
   */
  protected readonly director = computed(() => this.admins.session());

  /** The list could not be confirmed with the server, so it is not a list of his company. */
  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');

  protected readonly reasonKey = computed(() => companyReasonFor(this.status()));

  /** His foremen, in the order the list shows them, each with the chips for his row. */
  protected readonly rows = computed<PersonRow[]>(() =>
    sortWorkers(this.workers(), this.sort()).map((worker) => ({
      worker,
      chips: workerChips(worker),
    })),
  );

  /**
   * Phones across the company that can still record.
   *
   * Summed from the workers' own counts rather than read from `GET /api/devices`, which this screen
   * no longer calls at all. The server counts a worker's un-revoked devices for that field
   * (`WorkerEndpoints.ListWorkersAsync`), so the number is the same one the old rail showed, for
   * one request instead of two — and the device *rows*, which is what an admin needs when he is
   * taking a handset away, belong on the man's own page beside the button that does it.
   */
  protected readonly activePhoneCount = computed(() =>
    this.workers().reduce((total, worker) => total + worker.activeDeviceCount, 0),
  );

  /** How many men are waiting on a code they could type. Never *which* code — see the class doc. */
  protected readonly waitingCodeCount = computed(
    () => this.workers().filter((worker) => worker.hasLiveCode).length,
  );

  constructor() {
    void this.load();
  }

  /** The list, and the sentence to say if it did not arrive. */
  protected async load(): Promise<void> {
    this.loading.set(true);
    const result = await this.company.listWorkers();
    this.workers.set(result.workers);
    this.status.set(result.status);
    this.loading.set(false);
  }

  /**
   * Sort by a column: pick it up in its useful direction, tap it again to turn it round.
   *
   * The useful direction differs per column ({@link DEFAULT_DIRECTION}) — a name wants A→Ž, a date
   * wants the most recent first — so a first tap never costs a second one.
   */
  protected sortBy(key: PeopleSortKey): void {
    const current = this.sort();
    this.sort.set(
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: DEFAULT_DIRECTION[key] },
    );
  }

  /** `aria-sort` for a column header, so a screen reader reads the order the eye can see. */
  protected ariaSort(key: PeopleSortKey): 'ascending' | 'descending' | 'none' {
    const current = this.sort();
    if (current.key !== key) {
      return 'none';
    }
    return current.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected sortedBy(key: PeopleSortKey): boolean {
    return this.sort().key === key;
  }

  protected ascending(): boolean {
    return this.sort().direction === 'asc';
  }

  /**
   * One man's page.
   *
   * The path is built from the route table's own segments by the spec that pins it
   * (`company-page.spec.ts` resolves it through `testing/route-table.ts`), so renaming the route
   * without this call site fails a spec rather than silently dropping an admin on Home through the
   * wildcard — which is exactly how F4b's defect shipped.
   */
  protected open(worker: Worker): void {
    void this.router.navigate(['/company/worker', worker.id]);
  }

  protected openAdd(): void {
    this.addOpen.set(true);
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected cancelAdd(): void {
    this.addOpen.set(false);
    this.newName.set('');
    this.newEmail.set('');
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected onName(value: string): void {
    this.newName.set(value);
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected onEmail(value: string): void {
    this.newEmail.set(value);
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected onAdd(event: Event): void {
    event.preventDefault();
    void this.add();
  }

  /**
   * Add a foreman, and go straight to his page.
   *
   * Adding a man you cannot then activate is not a finished action — which is why this ends on his
   * own screen, where his first code is waiting, rather than congratulating the admin and leaving
   * him to find the row. `POST /api/workers` returns that code in the response, and his page reads
   * it back with the GET that never spends one, so nothing here has to carry a code across a
   * navigation.
   */
  protected async add(): Promise<void> {
    const name = this.newName().trim();
    if (this.addBusy() || name.length === 0) {
      return;
    }

    this.addBusy.set(true);
    this.addFailure.set(null);
    this.addConflict.set(null);

    const result = await this.company.addWorker(name, this.newEmail());
    this.addBusy.set(false);

    if (result.status !== 'ok' || !result.worker) {
      this.addFailure.set(result.status);
      this.addConflict.set(result.conflict);
      return;
    }

    this.addOpen.set(false);
    this.newName.set('');
    this.newEmail.set('');
    this.open(result.worker);
  }

  /** The sentence for a status, or null when there is nothing to explain. */
  protected reasonFor(status: CompanyStatus | null): string | null {
    return companyReasonFor(status);
  }

  /** Whether a failure happened without the server ever giving a verdict. */
  protected unconfirmedAction(status: CompanyStatus | null): boolean {
    return status !== null && !serverAnswered(status);
  }
}
