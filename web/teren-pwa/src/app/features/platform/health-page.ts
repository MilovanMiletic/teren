import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';

import {
  FailureTally,
  Health,
  PlatformService,
  PlatformStatus,
  SiteHealth,
} from '../../core/platform/platform.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { ColumnMenu } from '../../ui/column-menu';
import { Icon } from '../../ui/icon';
import { InfoPopover } from '../../ui/info-popover';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { LatestRequest } from '../../ui/latest-request';
import { SessionLink } from '../../ui/session-link';
import { SignInAgain } from '../../ui/sign-in-again';
import { SortDirection, TableControls } from '../../ui/table-controls';
import { TablePager } from '../../ui/table-pager';
import { ViewportService } from '../../ui/viewport.service';
import { healthReasonKey } from './health-reason';
import {
  SITE_DEFAULT_DIRECTION,
  SITE_INITIAL_SORT,
  SiteChip,
  SiteSortKey,
  siteChips,
  sortSites,
} from './health-sites';
import { platformReasonFor } from './platform-reason';

/** One state of the entry state machine, as the pipeline card draws it. */
interface StateCount {
  readonly key: string;
  readonly value: number;
  /** The two that mean a person is being waited on. Everything else stays ink. */
  readonly tone: 'ink' | 'warn';
}

/**
 * `/platform/health` — **what the pipeline is doing across every customer** (F7, plan §8,
 * decision 12).
 *
 * ## The screen an owner opens because he already doubts what he is told
 *
 * That sentence is the whole design brief, and it decides four things that would otherwise be
 * arbitrary:
 *
 * 1. **It never overstates.** Every number on it is the server's, computed at one moment, and the
 *    head of the screen prints that moment. Nothing is re-derived from a cache, nothing is
 *    interpolated, and a read that failed leaves the previous numbers *off* the screen rather than
 *    standing there looking live.
 * 2. **"Nothing is queued" and "I could not tell" are drawn differently.** `queue.available:
 *    false` means the reader could not ask — no job server in the process, or storage that would
 *    not answer — and an empty queue is the healthiest state there is. Painting the second as the
 *    first was a gating find on `/platform/logs`, where a failed load printed *"Učitano 0 linija —
 *    to je sve"* under a notice saying the server was unreachable. Here the five queue numbers are
 *    em-dashes and a warning says which of the two fixed reasons applies.
 * 3. **The two failure lists are not a partition and are never drawn as one.** `entry.failure_reason`
 *    is written by the pipeline *and* by the report pass — `EntryReporter` records a delivery
 *    failure "in both places a person might look", and `superseded_after_send` exists nowhere else
 *    — so one problem can appear in both tallies. No pie, no stacked bar, no total: two plain
 *    lists, largest first, with the overlap said out loud in the card. The backend's own first cut
 *    folded entry reasons through the pipeline vocabulary alone and reported every delivery failure
 *    as `unrecognised`; drawing them as parts of a whole would reintroduce that lie in the UI.
 * 4. **Truncation is announced.** `sites` is capped at 500 and ordered attention-first, so what is
 *    dropped is always healthy — but a table quietly showing some of the sites is exactly the
 *    defect F11's "Prikazano 1 od 12" strip exists to prevent, and `sites_omitted` is said in
 *    words the moment it is non-zero.
 *
 * ## Three deliberate layouts
 *
 *   compact   <768      the screen's own bar (the app header is display:none there), the three
 *                       headline numbers, the cards, then a **list** of sites — one card each.
 *   medium    768–1023  the same single column, proportioned: the count grids go two- and
 *                       three-up as they fit, and the sites stay a list. Not a squeezed table —
 *                       that is the mistake `/platform/logs` was corrected for at 834, where a
 *                       desktop table gave its one useful column 300 px.
 *   expanded  ≥1024     the twelve-column grid: headline numbers across the top, the pipeline and
 *                       the delivery cards side by side (6/6), the queue full width, and the sites
 *                       as a real `<table>` with the product's one column control and ten rows a
 *                       page.
 *
 * Which of the two site renderings is drawn is decided in TypeScript ({@link ViewportService}),
 * never by `display: none`: a `<table>` whose cells are forced to `display: block` loses its table
 * role in every browser.
 *
 * ## There is no artboard for this screen and none is owed
 *
 * `design/` holds the ten M0 screens. All four existing platform screens were built by following
 * each other, and this one follows them: `logs-page` for the device classes, `platform-page` for
 * the stat tiles, and `ui/table-controls.ts` + `ui/column-menu.ts` + `ui/table-pager.ts` for the
 * table — **every table in this product is one control and pages at ten rows.**
 */
@Component({
  selector: 'app-health-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeader,
    ColumnMenu,
    DatePipe,
    Icon,
    InfoPopover,
    LanguageSwitcher,
    SessionLink,
    SignInAgain,
    TablePager,
    TranslocoDirective,
  ],
  templateUrl: './health-page.html',
  styleUrl: './health-page.css',
})
export class HealthPage {
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly actions = inject(ActionLogService);

  protected readonly viewport = inject(ViewportService);

  protected readonly loading = signal(true);
  protected readonly status = signal<PlatformStatus>('ok');
  protected readonly health = signal<Health | null>(null);

  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');
  protected readonly reasonKey = computed(() => platformReasonFor(this.status()));

  /**
   * **There is no answer on this screen at all** — the read failed and nothing survived it.
   *
   * Every card is drawn only when this is false. The alternative — keeping the last good numbers
   * on screen behind the notice — is what the archive does with its entry list, and it is right
   * there and wrong here: an archive that emptied itself in a basement would hide a foreman's
   * work, while a health screen showing five-minute-old numbers under "the server could not be
   * reached" is a screen inviting the one conclusion it exists to make impossible.
   */
  protected readonly nothingLoaded = computed(() => this.unconfirmed() && this.health() === null);

  // ---- the headline numbers -------------------------------------------------------------------

  protected readonly pipeline = computed(() => this.health()?.pipeline ?? null);
  protected readonly delivery = computed(() => this.health()?.delivery ?? null);
  protected readonly queue = computed(() => this.health()?.queue ?? null);

  /** Every entry reason the estate is carrying, largest first, exactly as the server ordered it. */
  protected readonly pipelineFailures = computed<FailureTally[]>(
    () => this.health()?.pipelineFailures ?? [],
  );

  protected readonly deliveryFailures = computed<FailureTally[]>(
    () => this.health()?.deliveryFailures ?? [],
  );

  /**
   * How many entries are carrying a failure reason, across the estate.
   *
   * A sum **within one list**, which is legitimate: the tallies of `pipeline_failures` partition
   * the entries that carry a reason. What is forbidden is adding this to the delivery total —
   * those two overlap — and nothing does.
   */
  protected readonly failureCount = computed(() =>
    this.pipelineFailures().reduce((total, tally) => total + tally.count, 0),
  );

  /** The six states, in pipeline order, so the card reads as a journey rather than a list. */
  protected readonly states = computed<StateCount[]>(() => {
    const pipeline = this.pipeline();
    if (!pipeline) {
      return [];
    }
    return [
      { key: 'health.state.received', value: pipeline.received, tone: 'ink' },
      { key: 'health.state.processing', value: pipeline.processing, tone: 'ink' },
      // The two that mean a foreman's day is waiting on a person, not on a machine.
      { key: 'health.state.awaiting', value: pipeline.awaitingConfirmation, tone: 'warn' },
      { key: 'health.state.needsReview', value: pipeline.needsReview, tone: 'warn' },
      { key: 'health.state.confirmed', value: pipeline.confirmed, tone: 'ink' },
      { key: 'health.state.reported', value: pipeline.reported, tone: 'ink' },
    ];
  });

  // ---- the sites ------------------------------------------------------------------------------

  /**
   * How the list is ordered and what is filtered out of it — the object every table in the product
   * uses (`ui/table-controls.ts`).
   *
   * It starts on the order the **server** sent (`SITE_INITIAL_SORT`: attention first, then customer,
   * then site), so the first paint does not visibly reshuffle a list the server already put in the
   * most useful order it could.
   */
  protected readonly controls = new TableControls<SiteSortKey>(
    SITE_INITIAL_SORT,
    SITE_DEFAULT_DIRECTION,
  );

  private readonly sites = computed<SiteHealth[]>(() => this.health()?.sites ?? []);

  /**
   * The active language, as a signal.
   *
   * A filter matches **the words the cell shows**, and one of this table's columns is a row of
   * translated chips. `TranslocoService.translate` is not reactive on its own, so without this a
   * language switch would leave a live filter matching rows that no longer say what was typed —
   * the same reason `companies-page.ts` carries one.
   */
  private readonly language = toSignal(this.transloco.langChanges$, {
    initialValue: this.transloco.getActiveLang(),
  });

  protected readonly listed = computed(() =>
    sortSites(
      this.sites().filter((site) => this.controls.passes((key) => this.cellText(site, key))),
      this.controls.sort(),
    ),
  );

  /** The slice on screen. Every row either rendering draws comes from here and nowhere else. */
  protected readonly pageListed = computed(() => this.controls.slice(this.listed()));

  protected readonly page = computed(() => this.controls.pageOn(this.listed().length));
  protected readonly pageCount = computed(() => this.controls.pageCount(this.listed().length));

  protected readonly firstOnPage = computed(() =>
    this.listed().length === 0 ? 0 : (this.page() - 1) * this.controls.pageSize + 1,
  );

  protected readonly lastOnPage = computed(() =>
    Math.min(this.listed().length, this.page() * this.controls.pageSize),
  );

  /** Which of the four count sentences the strip says — `company-page.ts` reasons them out. */
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
    total: this.sites().length,
  }));

  /**
   * How many sites the server left out of the list, and what the whole estate therefore holds.
   *
   * Said in words the moment it is non-zero. The cap is only safe because of the ordering — sites
   * needing attention come first, so what is dropped is always healthy — and that guarantee is
   * worth nothing if the screen does not admit the truncation happened.
   */
  protected readonly sitesOmitted = computed(() => this.health()?.sitesOmitted ?? 0);

  protected readonly siteTotal = computed(() => this.sites().length + this.sitesOmitted());

  constructor() {
    this.actions.record(ACTIONS.healthOpen);
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

    const result = await this.platform.readHealth();

    if (!this.reads.holds(read)) {
      // A newer read owns the screen. This one's numbers *and* its verdict are both stale, and
      // this screen is the one whose job is saying what is wrong — a failed second reload landing
      // after a good one would print "nothing was confirmed" over numbers that were.
      return;
    }

    // Set together: the numbers and the verdict about them are one answer, and a screen that
    // briefly held new numbers under an old status (or the reverse) would be a screen that had
    // said something untrue, however briefly.
    this.health.set(result.health);
    this.status.set(result.status);
    // Back to the first page. A reload is a different answer, and page 4 of the last one describes
    // nothing about this one.
    this.controls.goTo(1);
    this.loading.set(false);
  }

  // ---- words -----------------------------------------------------------------------------------

  /**
   * The sentence for a failure code — **or the code itself.**
   *
   * A code this build has never heard of prints as itself rather than as a raw translation key or,
   * worse, not at all: a newer server may declare one, and `some_new_code` beside a count is
   * readable where `health.reason.someNewCode` is a defect on the glass and a vanished row is a
   * failure the founder never learns about. Same rule as `LogsPage.levelWord`, and the reasoning is
   * in `health-reason.ts`.
   */
  protected reasonWord(code: string): string {
    const key = healthReasonKey(code);
    return key ? this.say(key) : code;
  }

  protected chips(site: SiteHealth): SiteChip[] {
    return siteChips(site);
  }

  /**
   * A chip's word, with its count where it has one.
   *
   * The key comes off the chip **already written out** (`health-sites.ts`) rather than being
   * assembled here: `i18n.spec.ts` finds keys by reading the source, and a `` `${chip.key}Count` ``
   * would hide four of them from the one guard that stops a raw key reaching the glass.
   */
  protected chipWord(chip: SiteChip): string {
    return chip.count === null
      ? this.say(chip.wordKey)
      : this.say(chip.wordKey, { count: chip.count });
  }

  /**
   * The text a row shows in one column — **what a filter is matched against.**
   *
   * The rendered words rather than the underlying fields, so what the founder types is what he is
   * reading: filtering the state column on "greške" finds the sites that have some, and on
   * "u redu" the ones that do not. That is what lets one text box serve a name, a number and a row
   * of chips (`ui/table-controls.ts`).
   */
  private cellText(site: SiteHealth, key: SiteSortKey): string {
    switch (key) {
      case 'company':
        return site.companyName;
      case 'site':
        return site.projectName;
      case 'days':
        return String(site.pipeline.entryCount);
      case 'state':
        return this.chips(site)
          .map((chip) => this.chipWord(chip))
          .join(' ');
    }
  }

  /** One translated word, re-read whenever the language changes — see {@link language}. */
  private say(key: string, params: Record<string, unknown> = {}): string {
    return this.transloco.translate(key, params, this.language());
  }

  /**
   * Why the queue could not be read, as one of two fixed tokens — or the generic sentence.
   *
   * The tokens are `not_configured` and `unreadable`, declared on `JobQueueDepth`. A token this
   * build does not know still gets a sentence rather than a raw string, because unlike a failure
   * code this one is not a name a founder could look up: it is either of the two, or it is
   * something new, and "we could not read it" is true in every case.
   */
  protected queueDetailKey(): string {
    switch (this.queue()?.detail) {
      case 'not_configured':
        return 'health.queue.notConfigured';
      case 'unreadable':
        return 'health.queue.unreadable';
      default:
        return 'health.queue.unknown';
    }
  }

  protected sortBy(key: SiteSortKey): void {
    this.controls.sortBy(key);
  }

  protected setSort(key: SiteSortKey, direction: SortDirection): void {
    this.controls.setSort(key, direction);
  }

  protected setFilter(key: SiteSortKey, value: string): void {
    this.controls.setFilter(key, value);
  }

  protected goToPage(page: number): void {
    this.controls.goTo(page);
  }

  protected back(): void {
    void this.router.navigate(['/platform']);
  }
}
