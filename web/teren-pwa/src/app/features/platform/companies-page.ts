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
  Customer,
  PlatformService,
  PlatformStatus,
  serverAnswered,
} from '../../core/platform/platform.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { ColumnMenu } from '../../ui/column-menu';
import { Icon } from '../../ui/icon';
import { InfoPopover } from '../../ui/info-popover';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { LatestRequest } from '../../ui/latest-request';
import { ModalSheet } from '../../ui/modal-sheet';
import { SessionLink } from '../../ui/session-link';
import { SignInAgain } from '../../ui/sign-in-again';
import { SortDirection, TableControls } from '../../ui/table-controls';
import { TablePager } from '../../ui/table-pager';
import { ViewportService } from '../../ui/viewport.service';
import { platformReasonFor } from './platform-reason';
import { CUSTOMER_DEFAULT_DIRECTION, CustomerSortKey, sortCustomers } from './platform-people';

/**
 * The customers (`/platform/companies`, F7): **who Teren sells to, and the one switch that turns a
 * customer off.**
 *
 * ## Why customers have their own screen
 *
 * The same reason the office split into a directory and one man's page on 2026-09-01: a list of
 * people and a list of companies answer different questions, and a screen that tried to be both
 * would put the founder's heaviest action — suspending a paying customer — next to a row about a
 * foreman's phone. Here the list is short, the columns are about the account rather than the work,
 * and the dangerous button sits behind a confirmation.
 *
 * ## Suspending is the heaviest thing on this surface, and the screen says so
 *
 * `company.suspended_at` is joined by the authenticator on **every** request, with no cache and no
 * expiry. The moment it lands, every phone and every session belonging to that customer starts
 * getting a 401 on next contact. His foremen keep recording — their entries queue locally and heal
 * — but nothing already captured gets through until it is resumed. That is why the action asks
 * first and names the customer in the question: a mis-tap here is a contractor's afternoon.
 *
 * ## What it deliberately does not show
 *
 * No entry counts, no project detail, nothing about anybody's work. The DTOs do not carry it and
 * `PlatformPrivacyTests` fails the build if one ever does. The two numbers on a row are *people* —
 * how many accounts exist and how many can still sign in — which is what answers "is this customer
 * set up, or stuck?".
 *
 * ## Three deliberate layouts
 *
 *   compact   <768      a list of cards, one customer each.
 *   medium    768–1023  a real `<table>` on the 640 column.
 *   expanded  ≥1024     the table across all twelve columns.
 */
@Component({
  selector: 'app-companies-page',
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
  templateUrl: './companies-page.html',
  styleUrls: ['../../ui/field.css', './companies-page.css'],
})
export class CompaniesPage {
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);
  private readonly actions = inject(ActionLogService);

  protected readonly viewport = inject(ViewportService);

  protected readonly loading = signal(true);
  protected readonly customers = signal<Customer[]>([]);
  protected readonly status = signal<PlatformStatus>('ok');

  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');
  protected readonly reasonKey = computed(() => platformReasonFor(this.status()));

  /**
   * How the list is ordered **and what is filtered out of it** — the same object the two people
   * directories use (`ui/table-controls.ts`).
   *
   * This screen had no sort at all until 2026-09-02, which is why its headings were plain black
   * `<th>` text while the two screens either side of it had muted uppercase controls: there was
   * nothing in the cell to style. It starts on the name, which is the order the list already
   * arrives in, so the first paint does not reshuffle itself.
   */
  protected readonly controls = new TableControls<CustomerSortKey>(
    { key: 'name', direction: 'asc' },
    CUSTOMER_DEFAULT_DIRECTION,
  );

  private readonly transloco = inject(TranslocoService);
  private readonly locale = inject(LOCALE_ID);

  /**
   * The active language, as a signal: a filter matches the words on the glass, and one of this
   * screen's cells is a translated em-dash. `TranslocoService.translate` is not reactive on its
   * own, so without this a language switch would leave a live filter matching rows that no longer
   * say what was typed.
   */
  private readonly language = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly listed = computed(() =>
    sortCustomers(
      this.customers().filter((customer) =>
        this.controls.passes((key) => this.cellText(customer, key)),
      ),
      this.controls.sort(),
    ),
  );

  // ---- paging (ten rows a page, `ui/table-controls.ts`) ----------------------------------------

  /** The slice on screen. Every row the template draws comes from here and from nowhere else. */
  protected readonly pageListed = computed(() => this.controls.slice(this.listed()));

  protected readonly page = computed(() => this.controls.pageOn(this.listed().length));
  protected readonly pageCount = computed(() => this.controls.pageCount(this.listed().length));

  /** The first and last row numbers on screen, one-based — what the count strip prints. */
  protected readonly firstOnPage = computed(() =>
    this.listed().length === 0 ? 0 : (this.page() - 1) * this.controls.pageSize + 1,
  );

  protected readonly lastOnPage = computed(() =>
    Math.min(this.listed().length, this.page() * this.controls.pageSize),
  );

  /**
   * Which of the four sentences the count strip says — see `company-page.ts`, which reasons the
   * same four out in full. On this screen the stakes are the highest of the three: the button
   * beside a customer's name suspends him, and a founder who has not noticed that he is looking at
   * ten rows of twenty-four is a founder about to act on the wrong one.
   */
  protected readonly countKey = computed(() => {
    if (this.pageCount() > 1) {
      return this.controls.filtering() ? 'table.page.filteredRange' : 'table.page.range';
    }
    return this.controls.filtering() ? 'table.filter.showing' : 'table.page.total';
  });

  protected readonly countParams = computed(() => ({
    from: this.firstOnPage(),
    to: this.lastOnPage(),
    shown: this.listed().length,
    total: this.customers().length,
  }));

  protected goToPage(page: number): void {
    this.controls.goTo(page);
  }

  protected readonly activeCount = computed(
    () => this.customers().filter((customer) => customer.suspendedAt === null).length,
  );

  protected readonly suspendedCount = computed(
    () => this.customers().filter((customer) => customer.suspendedAt !== null).length,
  );

  // ---- adding a customer ---------------------------------------------------------------------

  protected readonly addOpen = signal(false);
  protected readonly newName = signal('');
  protected readonly adding = signal(false);
  protected readonly addStatus = signal<PlatformStatus | null>(null);

  protected readonly addReasonKey = computed(() => platformReasonFor(this.addStatus()));

  protected readonly canAdd = computed(() => !this.adding() && this.newName().trim() !== '');

  // ---- suspending one ------------------------------------------------------------------------

  /** The customer the confirmation is about, or null when nothing is being asked. */
  protected readonly confirming = signal<Customer | null>(null);
  protected readonly working = signal(false);
  protected readonly actionStatus = signal<PlatformStatus | null>(null);

  protected readonly actionReasonKey = computed(() => platformReasonFor(this.actionStatus()));

  constructor() {
    void this.load();
  }

  /**
   * Which read the screen is waiting for, so an older answer cannot overwrite a newer question.
   *
   * The symptom on a screen like this one is a reload pressed twice: the slower attempt fails,
   * lands after the faster one succeeded, and paints *"Nije provereno na serveru"* over data that
   * was confirmed a moment ago. `ui/latest-request.ts` carries the reasoning.
   */
  private readonly reads = new LatestRequest();

  protected async load(): Promise<void> {
    const read = this.reads.claim();
    this.loading.set(true);
    const result = await this.platform.listCustomers();
    if (!this.reads.holds(read)) {
      return;
    }
    this.customers.set(result.customers);
    this.status.set(result.status);
    this.loading.set(false);
  }

  protected openAdd(): void {
    this.newName.set('');
    this.addStatus.set(null);
    // The other dialog's verdict, cleared here as well: `mustReload()` reads whichever of the two
    // is set, so a suspend that got no answer earlier would otherwise put "the server did not
    // answer, reload first" under an add the server plainly refused. At most one of the two
    // statuses is ever live, and this is half of what keeps that true.
    this.actionStatus.set(null);
    this.adding.set(false);
    this.addOpen.set(true);
  }

  protected cancelAdd(): void {
    this.addOpen.set(false);
  }

  protected async onAdd(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canAdd()) {
      return;
    }

    this.adding.set(true);
    this.addStatus.set(null);

    const result = await this.platform.createCustomer(this.newName());

    this.adding.set(false);

    if (result.status !== 'ok') {
      this.addStatus.set(result.status);
      return;
    }

    this.addOpen.set(false);
    void this.load();
  }

  protected ask(customer: Customer): void {
    this.actionStatus.set(null);
    // …and the other half. See {@link openAdd}.
    this.addStatus.set(null);
    this.confirming.set(customer);
  }

  protected cancelAsk(): void {
    this.confirming.set(null);
    this.working.set(false);
  }

  /**
   * Do the thing that was asked about.
   *
   * Reads the direction off the customer rather than taking it as an argument, so the confirmation
   * dialog and the request can never disagree about which way round the switch was thrown — the
   * dialog says "suspend" and the call suspends, or neither does.
   */
  protected async confirm(): Promise<void> {
    const customer = this.confirming();
    if (!customer || this.working()) {
      return;
    }

    this.working.set(true);
    this.actionStatus.set(null);

    const result = await this.platform.setSuspended(customer.id, customer.suspendedAt === null);

    this.working.set(false);

    if (result.status !== 'ok') {
      this.actionStatus.set(result.status);
      return;
    }

    this.confirming.set(null);
    void this.load();
  }

  /**
   * Whether a failed action leaves the founder able to press again, or having to reload first.
   *
   * Where the server gave **no verdict** the screen must not say "it failed": suspending may well
   * have suspended, and a second press over a customer who is already off is a founder acting on
   * a screen that lied to him.
   */
  protected mustReload(): boolean {
    const status = this.actionStatus() ?? this.addStatus();
    return status !== null && !serverAnswered(status);
  }

  /**
   * The text a row shows in one column — **what a filter is matched against.**
   *
   * The rendered words rather than the underlying fields, so what the founder types is what he is
   * reading: the name cell carries the *suspended* chip, so filtering the name column on
   * "suspendovana" finds the customers that are off, and the date is formatted with the pattern and
   * locale the cell itself uses.
   */
  private cellText(customer: Customer, key: CustomerSortKey): string {
    switch (key) {
      case 'name':
        return customer.suspendedAt
          ? `${customer.name} ${this.say('platform.companies.suspended')}`
          : customer.name;
      case 'people':
        return `${customer.activeUserCount} / ${customer.userCount}`;
      case 'since':
        return customer.createdAt
          ? formatDate(customer.createdAt, 'd. M. y.', this.locale)
          : this.say('platform.none');
    }
  }

  /** One translated word, re-read whenever the language changes — see {@link language}. */
  private say(key: string): string {
    return this.transloco.translate(key, {}, this.language());
  }

  protected sortBy(key: CustomerSortKey): void {
    this.controls.sortBy(key);
  }

  protected setSort(key: CustomerSortKey, direction: SortDirection): void {
    this.controls.setSort(key, direction);
  }

  protected setFilter(key: CustomerSortKey, value: string): void {
    this.controls.setFilter(key, value);
  }

  protected openPeople(): void {
    // Which customer was opened is not sent: a company name is a customer's name. That the
    // customers screen was used to reach the people is the fact worth having.
    this.actions.record(ACTIONS.platformCompanyOpen, {});
    void this.router.navigate(['/platform']);
  }
}
