import { DatePipe, formatDate } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';

import {
  CompanyService,
  CompanyStatus,
  Worker,
  serverAnswered,
} from '../../core/company/company.service';
import { AdminSessionService } from '../../core/session/admin-session.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { ColumnMenu } from '../../ui/column-menu';
import { Icon } from '../../ui/icon';
import { InfoPopover } from '../../ui/info-popover';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { ModalSheet } from '../../ui/modal-sheet';
import { SessionLink } from '../../ui/session-link';
import { SignInAgain } from '../../ui/sign-in-again';
import { SortDirection, TableControls } from '../../ui/table-controls';
import { TablePager } from '../../ui/table-pager';
import { ViewportService } from '../../ui/viewport.service';
import { companyReasonFor } from './company-reason';
import { DEFAULT_DIRECTION, PeopleSortKey, StatusChip, sortWorkers, workerChips } from './people';

/** One line of the people list: the person, and the chips that say how he stands. */
interface PersonRow {
  worker: Worker;
  chips: StatusChip[];
}

/**
 * One row of the directory, whichever group it belongs to.
 *
 * The owner and his foremen are **one paginated list**, not a fixed row above a paginated one. Ten
 * rows a page has to mean ten rows on the glass, and a screen that quietly drew eleven on page one
 * would be a screen whose own count strip was wrong — the exact class of lie this table's strip
 * exists to prevent. So he is entry zero, the slice cuts through both groups, and the group bands
 * are drawn from what the slice actually contains.
 */
type PersonEntry = { kind: 'director'; name: string } | { kind: 'worker'; row: PersonRow };

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
    ColumnMenu,
    DatePipe,
    Icon,
    InfoPopover,
    LanguageSwitcher,
    ModalSheet,
    SessionLink,
    SignInAgain,
    TablePager,
    TranslocoDirective,
  ],
  templateUrl: './company-page.html',
  styleUrls: ['../../ui/field.css', './company-page.css'],
})
export class CompanyPage {
  private readonly company = inject(CompanyService);
  private readonly admins = inject(AdminSessionService);
  private readonly router = inject(Router);
  /**
   * The action log (D5).
   *
   * The one thing this screen records by hand is whether adding a foreman actually worked; the
   * rows declare themselves in the template. **Nothing here touches a code** — decision 13 keeps
   * every path to a credential on `/company/worker/:workerId`, and that includes the log's.
   */
  private readonly actions = inject(ActionLogService);

  protected readonly viewport = inject(ViewportService);

  protected readonly loading = signal(true);
  protected readonly workers = signal<Worker[]>([]);
  /** How the last look at the list went. `ok` is the only value that lets the screen claim it. */
  protected readonly status = signal<CompanyStatus>('ok');

  /**
   * How the list is ordered **and what is filtered out of it** — one object, shared with every
   * other table in the product (`ui/table-controls.ts`), so the office, the platform directory and
   * the customer list behave identically rather than each carrying its own copy of the same four
   * helpers.
   *
   * It starts on the name, ascending, which is the order `GET /api/workers` already returns
   * (`OrderBy(u => u.DisplayName)`), so the first paint does not visibly reorder itself.
   */
  protected readonly controls = new TableControls<PeopleSortKey>(
    { key: 'name', direction: 'asc' },
    DEFAULT_DIRECTION,
  );

  private readonly transloco = inject(TranslocoService);
  private readonly locale = inject(LOCALE_ID);

  /**
   * The active language, as a signal.
   *
   * A filter matches **the words on the glass**, and the state column's words are chips this
   * component translates. Without this, switching to English would leave a live Serbian filter
   * matching rows that no longer say what he typed — a list quietly showing nothing, with no
   * explanation on screen. `TranslocoService.translate` is not reactive on its own.
   */
  private readonly language = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

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

  /**
   * The owner's own row, **once the filters have had their say**.
   *
   * He is a row in this table like any other, so a filter that hides every foreman must hide him
   * too — a directory that answers "Zoran" with the reader's own name at the top of it is a
   * directory that did not do what it was asked.
   */
  protected readonly directorRow = computed(() => {
    const boss = this.director();
    if (!boss) {
      return null;
    }
    return this.controls.passes((key) => this.directorText(boss.displayName, key)) ? boss : null;
  });

  /** The list could not be confirmed with the server, so it is not a list of his company. */
  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');

  protected readonly reasonKey = computed(() => companyReasonFor(this.status()));

  /** His foremen, filtered and then ordered the way the list shows them, with their chips. */
  protected readonly rows = computed<PersonRow[]>(() =>
    sortWorkers(
      this.workers().filter((worker) => this.controls.passes((key) => this.cellText(worker, key))),
      this.controls.sort(),
    ).map((worker) => ({
      worker,
      chips: workerChips(worker),
    })),
  );

  /**
   * Everybody the filters left, in the order the screen shows them — **one list, both groups.**
   *
   * The owner first, because his band is drawn first; then his foremen. Paging cuts through this
   * rather than through the foremen alone, so a page really is ten rows of the directory.
   */
  protected readonly entries = computed<PersonEntry[]>(() => {
    const boss = this.directorRow();
    return [
      ...(boss ? [{ kind: 'director' as const, name: boss.displayName }] : []),
      ...this.rows().map((row) => ({ kind: 'worker' as const, row })),
    ];
  });

  /** How many people the list is drawing, the owner's own row included. */
  protected readonly shown = computed(() => this.entries().length);

  /** How many there are altogether — the other half of "showing 3 of 12". */
  protected readonly total = computed(() => this.workers().length + (this.director() ? 1 : 0));

  // ---- paging (ten rows a page, `ui/table-controls.ts`) ----------------------------------------

  /** The slice on screen. Every row the template draws comes from here and from nowhere else. */
  private readonly pageEntries = computed(() => this.controls.slice(this.entries()));

  /** The owner's row, when this page is the page it falls on. */
  protected readonly pagedDirector = computed(() => {
    const entry = this.pageEntries().find((candidate) => candidate.kind === 'director');
    return entry?.kind === 'director' ? entry.name : null;
  });

  /** The foremen on this page. */
  protected readonly pagedRows = computed(() =>
    this.pageEntries().flatMap((entry) => (entry.kind === 'worker' ? [entry.row] : [])),
  );

  protected readonly page = computed(() => this.controls.pageOn(this.shown()));
  protected readonly pageCount = computed(() => this.controls.pageCount(this.shown()));

  /** The first and last row numbers on screen, one-based — what the count strip prints. */
  protected readonly firstOnPage = computed(() =>
    this.shown() === 0 ? 0 : (this.page() - 1) * this.controls.pageSize + 1,
  );

  protected readonly lastOnPage = computed(() =>
    Math.max(0, this.firstOnPage() + this.pageEntries().length - 1),
  );

  /**
   * Which of the four sentences the count strip says.
   *
   * They are four because the two facts are independent: a filter may or may not be live, and the
   * answer may or may not fit on one page. Every combination has a true sentence, and none of them
   * is allowed to imply the other fact — a range that looked like a filter would make an owner
   * hunt for a filter he never set, and a filtered count with no range would make him think ten
   * rows is all he has.
   */
  protected readonly countKey = computed(() => {
    if (this.pageCount() > 1) {
      return this.controls.filtering() ? 'table.page.filteredRange' : 'table.page.range';
    }
    return this.controls.filtering() ? 'table.filter.showing' : 'table.page.total';
  });

  /** The numbers behind whichever of the four it is. Unused ones are harmless to pass. */
  protected readonly countParams = computed(() => ({
    from: this.firstOnPage(),
    to: this.lastOnPage(),
    shown: this.shown(),
    total: this.total(),
  }));

  protected goToPage(page: number): void {
    this.controls.goTo(page);
  }

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
   * The text a row shows in one column — **what a filter is matched against.**
   *
   * Matching the rendered words rather than the underlying field is what lets one filter box serve
   * a name, a date and a row of status chips without any column declaring a type: what an owner
   * types is what he is reading. The date is formatted with the same pattern and the same locale
   * the cell uses, so "2026" finds the rows whose cell says 2026.
   */
  private cellText(worker: Worker, key: PeopleSortKey): string {
    switch (key) {
      case 'name':
        return `${worker.displayName} ${worker.username ?? ''}`;
      case 'state':
        return workerChips(worker)
          .map((chip) => this.say(chip.key))
          .join(' ');
      case 'contact':
        return worker.lastSeenAt
          ? formatDate(worker.lastSeenAt, 'd. M. y.', this.locale)
          : this.say('company.people.never');
    }
  }

  /** The same, for the one row that is not a worker: the owner reading the screen. */
  private directorText(name: string, key: PeopleSortKey): string {
    switch (key) {
      case 'name':
        return `${name} ${this.say('company.people.passwordAccount')}`;
      case 'state':
        return this.say('company.people.you');
      case 'contact':
        return this.say('company.people.none');
    }
  }

  /** One translated word, re-read whenever the language changes — see {@link language}. */
  private say(key: string): string {
    return this.transloco.translate(key, {}, this.language());
  }

  protected sortBy(key: PeopleSortKey): void {
    this.controls.sortBy(key);
  }

  protected setSort(key: PeopleSortKey, direction: SortDirection): void {
    this.controls.setSort(key, direction);
  }

  protected setFilter(key: PeopleSortKey, value: string): void {
    this.controls.setFilter(key, value);
  }

  /**
   * One man's page.
   *
   * The path is built from the route table's own segments by the spec that pins it
   * (`company-page.spec.ts` resolves it through `testing/route-table.ts`), so renaming the route
   * without this call site fails a spec rather than silently dropping an admin on Home through the
   * wildcard — which is exactly how F4b's defect shipped.
   */
  /**
   * His own account.
   *
   * Deliberately not `/profile`: that screen is gated on this browser holding a *device* session
   * and offers a foreman re-activation, and an admin has neither. Two screens, two credentials —
   * see `account-page.ts`.
   */
  protected openAccount(): void {
    void this.router.navigate(['/company/profile']);
  }

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

    // The verdict, never the man: no name, no address, no username.
    this.actions.record(ACTIONS.companyWorkerAdd, {
      outcome: result.status === 'ok' && result.worker ? 'ok' : 'fail',
    });

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
