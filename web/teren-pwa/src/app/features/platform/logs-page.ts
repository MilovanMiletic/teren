import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';

import { LogRecord, PlatformService, PlatformStatus } from '../../core/platform/platform.service';
import { PlatformLogQuery } from '../../core/platform/platform-types';
import { ACTIONS } from '../../core/telemetry/actions';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { AppHeader } from '../../ui/app-header';
import { ColumnMenu } from '../../ui/column-menu';
import { Icon } from '../../ui/icon';
import { InfoPopover } from '../../ui/info-popover';
import { LatestRequest } from '../../ui/latest-request';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { SessionLink } from '../../ui/session-link';
import { SignInAgain } from '../../ui/sign-in-again';
import { TABLE_PAGE_SIZE, clampPage, pageCountOf, slicePage } from '../../ui/table-controls';
import { TablePager } from '../../ui/table-pager';
import { ViewportService } from '../../ui/viewport.service';
import { platformReasonFor } from './platform-reason';
import { LOG_LEVELS, LOG_RANGES, LogRange, LogTone, fromFor, levelTone } from './log-level';

/** How many lines one **batch** from the server holds. Well inside the contract's 1..200. */
const BATCH_SIZE = 50;

/**
 * The levels each triage tile stands for.
 *
 * `Error` and `Fatal` are one question — *did something break?* — so one tile answers it. Splitting
 * them would give the founder two numbers to add up in a corridor, which is the opposite of what
 * the tile is for.
 */
const PROBLEM_LEVELS = ['Error', 'Fatal'];
const WARNING_LEVELS = ['Warning'];

/**
 * How long a filter box sits still before the server is asked again.
 *
 * Every other table in the product filters what is already in hand, per keystroke, for free. This
 * one cannot — so a debounce is the difference between one request and one request per letter of
 * "EntryReporter".
 */
const TYPING_PAUSE_MS = 350;

/** One line, plus whether the reader has opened it. */
interface LogRow {
  log: LogRecord;
  tone: LogTone;
  open: boolean;
}

/**
 * `/platform/logs` — **what the product actually did, in the order it did it** (D5).
 *
 * The founder's words: *"i want the logger screen … in table form that will open detailed logs
 * from the backend and it will have a download button so i can download the logging report."*
 *
 * ## One thing on this screen is unlike every other table in the product
 *
 * **The filters run on the server.** `ui/table-controls.ts` filters rows already in hand, which is
 * right for a company's twelve foremen and wrong here: this is a keyset-paged firehose and the
 * client holds one page of it. A client-side filter would narrow *the page* and print a count that
 * describes nothing.
 *
 * That difference has to be visible to the reader, not merely true. So this screen **never says
 * "showing 3 of 12"** — it does not know the total and cannot — and instead says what it does
 * know: how many lines are loaded, and whether the server has more behind them. A count that
 * implied a total would be the same lie as a quietly filtered directory, on the one screen an
 * owner consults precisely because he does not trust what he is being told.
 *
 * The column controls follow from it. The time column is `sortable="false"`: the stream is ordered
 * `(at DESC, id DESC)` on the server and no other order can be asked for, so a label that
 * re-sorted nothing would be the dead control the app header link once was. Level and time carry
 * their own controls in the filter card, because a Serilog level is a fixed set (chips, not a text
 * box that could be typed into wrongly) and a time range is four relative answers rather than a
 * pair of calendars — `log-level.ts` says why.
 *
 * ## An expanding row, not a detail panel
 *
 * The plan asks for *"a filtered list of collapsed entries that expand on tap"* at compact, and
 * this screen expands in place **at every width**. Four reasons, and the last is the one that
 * settled it:
 *
 * 1. One interaction at all three device classes. A panel below 1024 and an expansion above it
 *    would be two screens wearing one name.
 * 2. A stack trace is wide as well as tall. A five-column side panel at 1024 wraps
 *    `at Teren.Infrastructure.Mail.SmtpSender.SendAsync` into porridge; the full width is exactly
 *    what the thing being read needs.
 * 3. **Keyset paging.** "Load more" appends, and a selected row can scroll out of a list while its
 *    panel is still on screen — a detail with no visible parent. A row cannot lose its parent.
 * 4. It keeps the reader's place, which is the whole point of a log: he is comparing this line
 *    with the two above it.
 *
 * The cost is stated rather than hidden: an open row with a long exception pushes the rest of the
 * table down. The stylesheet caps the trace's height and scrolls it inside itself.
 *
 * ## Three deliberate layouts
 *
 *   compact   <768      the filter card, then a list of collapsed lines that expand on tap.
 *   medium    768–1023  a real `<table>` on the 640 column: time, level, message, with the source
 *                       folded under the message and its filter in the pill bar above. A source
 *                       column of its own does not fit that width — see the stylesheet.
 *   expanded  ≥1024     a strip of counts, the filter card, and a table that gains the source as
 *                       its own column plus a fifth column (company and entry) — width spent on
 *                       the ids a founder correlates with, rather than on a wider left margin.
 *
 * The row is the control at every width: the whole `<tr>` opens the line above 768 exactly as the
 * whole list item does below it.
 *
 * Which rendering is drawn is decided in TypeScript ({@link ViewportService}), never by
 * `display: none`: a `<table>` whose cells are forced to `display: block` loses its table role in
 * every browser.
 */
@Component({
  selector: 'app-logs-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeader,
    ColumnMenu,
    DatePipe,
    Icon,
    InfoPopover,
    LanguageSwitcher,
    NgTemplateOutlet,
    SessionLink,
    SignInAgain,
    TablePager,
    TranslocoDirective,
  ],
  templateUrl: './logs-page.html',
  styleUrl: './logs-page.css',
})
export class LogsPage {
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly actions = inject(ActionLogService);

  protected readonly viewport = inject(ViewportService);

  protected readonly levels = LOG_LEVELS;
  protected readonly ranges = LOG_RANGES;

  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly status = signal<PlatformStatus>('ok');

  private readonly records = signal<LogRecord[]>([]);
  private readonly cursor = signal<string | null>(null);
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  // ---- what is being asked for ----------------------------------------------------------------

  /**
   * Which levels are wanted. **Empty means every level**, exactly as the wire contract says.
   *
   * Empty rather than "all six selected", so the screen opens with no filter of any kind on it.
   * A log viewer that arrives pre-filtered is the "showing 3 of 12" trap in its most dangerous
   * form: the founder opens it to find out whether something happened, and a default that hides
   * half the stream answers him wrongly before he has touched anything.
   */
  protected readonly wantedLevels = signal<ReadonlySet<string>>(new Set());

  /**
   * Whether the filter card is open. **Below 1024 it starts shut**, and that is the point.
   *
   * PERIOD is four pills and NIVO is six more: on a 390 px screen that is 186 px of chrome in two
   * sideways-scrolling rows — with *"Sve sačuvano"* sliced mid-word at the edge — standing between
   * the founder and the first log line. Driven at 390×844 it put **53 % of the first viewport above
   * the first line** (2026-09-02). He is standing in a corridor asking *is anything wrong*; the
   * lines come first and the filters come within reach.
   *
   * At 1024 and up there is room for both, so the card is simply always open and this is ignored.
   */
  protected readonly filtersOpen = signal(false);
  protected readonly range = signal<LogRange>('all');
  protected readonly source = signal('');
  protected readonly q = signal('');

  /** Whether anything at all is narrowing the stream — what the "clear" control hangs off. */
  protected readonly filtering = computed(
    () =>
      this.wantedLevels().size > 0 ||
      this.range() !== 'all' ||
      this.source().trim() !== '' ||
      this.q().trim() !== '',
  );

  /**
   * The question, in one place, **so the stream and the download cannot disagree.**
   *
   * The contract gives the export the same parameters as the list for exactly this reason: what he
   * downloads must be what he is looking at. One computed, read by both, is what makes that true
   * by construction rather than by two call sites that happen to match today.
   *
   * **Filters only — no `limit` and no `cursor`.** Those two are how *the stream* is read, not
   * part of what is being asked for, and the export takes neither: contract §2 says a caller who
   * sends one is told rather than having it ignored. Baking `limit` into this computed put
   * `?limit=50` on the download URL, where it means either nothing or a refusal depending on how
   * strictly the server is reading that day. Paging belongs to {@link batch} and {@link goToPage}.
   */
  protected readonly query = computed<PlatformLogQuery>(() => {
    const from = fromFor(this.range(), new Date());
    return {
      levels: [...this.wantedLevels()],
      source: this.source().trim() || undefined,
      q: this.q().trim() || undefined,
      from: from ?? undefined,
    };
  });

  /**
   * The same question, asked of the paged endpoint: one **batch** of it, from a bookmark or the top.
   *
   * A batch is fifty lines and a page is ten. The two numbers are deliberately different: the
   * founder reads ten rows at a time (`ui/table-controls.ts`), and asking the server for ten would
   * be five round trips to fill one screenful of scrolling. So the stream is fetched in fifties and
   * paged through in tens, and {@link goToPage} fetches the next fifty when the reader walks off the
   * end of what is loaded.
   */
  private batch(cursor?: string): PlatformLogQuery {
    return cursor
      ? { ...this.query(), limit: BATCH_SIZE, cursor }
      : { ...this.query(), limit: BATCH_SIZE };
  }

  // ---- what is on screen ----------------------------------------------------------------------

  /**
   * Which page of the loaded buffer is being read. **Unclamped**, exactly as
   * `ui/table-controls.ts` keeps its own: {@link page} is the only number anything may draw.
   */
  private readonly wantedPage = signal(1);

  /** Every line loaded so far, in the order the server sent them. */
  private readonly loaded = computed<LogRow[]>(() => {
    const open = this.opened();
    return this.records().map((log) => ({
      log,
      tone: levelTone(log.level),
      open: open.has(log.id),
    }));
  });

  /**
   * The ten lines on screen.
   *
   * **The detail lives inside this slice**, in both renderings, which is what keeps the founder's
   * rule true without a second mechanism: an expanded row that pages out of view takes its own
   * detail with it, because the detail is drawn by the same `@for` that drew the row. {@link
   * goToPage} then also forgets that it was open, so the set of expanded rows can never name a line
   * that is not on the glass.
   */
  protected readonly rows = computed<LogRow[]>(() =>
    slicePage(this.loaded(), this.wantedPage(), TABLE_PAGE_SIZE),
  );

  protected readonly count = computed(() => this.records().length);

  /** Whether the server said there is another page behind this one. */
  protected readonly hasMore = computed(() => this.cursor() !== null);

  // ---- paging through the buffer ---------------------------------------------------------------

  /** How many ten-line pages the **loaded** lines make. Not a claim about the stream. */
  private readonly loadedPages = computed(() => pageCountOf(this.count(), TABLE_PAGE_SIZE));

  /** The page being shown — clamped against what is loaded, on every read. */
  protected readonly page = computed(() =>
    clampPage(this.wantedPage(), this.count(), TABLE_PAGE_SIZE),
  );

  /**
   * How many pages there are, **or 0 while that cannot be known**.
   *
   * The whole honesty of this screen, restated for the pager. While a keyset cursor is outstanding
   * the server has said *there is more behind this* and has not said how much, so there is no last
   * page to number — "page 3" is a fact and "page 3 of 7" is not. `ui/table-pager.ts` takes 0 to
   * mean exactly that, draws no numbers, and takes its next control from {@link hasNextPage}.
   */
  protected readonly pageCount = computed(() => (this.hasMore() ? 0 : this.loadedPages()));

  /** Whether there is anywhere to go: another loaded page, or another batch on the server. */
  protected readonly hasNextPage = computed(
    () => this.page() < this.loadedPages() || this.hasMore(),
  );

  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');

  /**
   * **There is no answer on this screen at all** — the read failed and nothing survived it.
   *
   * The distinction this signal exists to draw: a failed *load more* leaves rows on screen and
   * those rows are still true, so the count strip above them is still true and stays. A failed
   * load empties the list, and a strip over that empty list said "0 lines loaded — that is all"
   * under a notice saying the server could not be reached. "There is nothing" and "I could not
   * ask" are opposite claims, and this screen is the one an owner opens precisely because he does
   * not trust what he is being told.
   */
  protected readonly nothingLoaded = computed(() => this.unconfirmed() && this.count() === 0);

  /** Which sentence stands where the lines would be. Three facts, never conflated. */
  protected readonly emptyKey = computed(() => {
    if (this.nothingLoaded()) {
      return 'logs.unavailable';
    }
    return this.filtering() ? 'logs.empty.filtered' : 'logs.empty.none';
  });

  protected readonly reasonKey = computed(() => platformReasonFor(this.status()));

  /** How many of the loaded lines are the two colours that matter. Expanded layout only. */
  /** Whether the level filter is exactly one triage tile's set — what makes a tile look pressed. */
  private exactly(levels: readonly string[]): boolean {
    const wanted = this.wantedLevels();
    return wanted.size === levels.length && levels.every((level) => wanted.has(level));
  }

  protected readonly showingProblems = computed(() => this.exactly(PROBLEM_LEVELS));
  protected readonly showingWarnings = computed(() => this.exactly(WARNING_LEVELS));

  protected readonly problemCount = computed(
    () => this.records().filter((log) => levelTone(log.level) === 'err').length,
  );

  protected readonly warningCount = computed(
    () => this.records().filter((log) => levelTone(log.level) === 'warn').length,
  );

  // ---- the download ---------------------------------------------------------------------------

  protected readonly exporting = signal(false);
  protected readonly exportStatus = signal<PlatformStatus | null>(null);
  protected readonly exportedAs = signal<string | null>(null);
  protected readonly exportReasonKey = computed(() => platformReasonFor(this.exportStatus()));

  /** The timer a filter box is waiting on, so a second keystroke replaces the first request. */
  private typing: ReturnType<typeof setTimeout> | null = null;

  /**
   * **Which question is currently being asked** — the guard against an older answer painting over
   * a newer one. `ui/latest-request.ts` carries the reasoning and the two rules.
   *
   * This screen is where it was measured (review, 2026-09-04): `q=a` stubbed at 2 s and `q=ab` at
   * 100 ms, type `a`, pause, type `b`, and three seconds later the rows for `a` were on screen
   * under a filter box reading `ab`. `ILIKE '%a%'` over a large `app_log` is genuinely slower than
   * `'%ab%'`, so the broader question typed first is exactly the one that lands last — and this is
   * the one screen an owner opens *because* he does not trust what he is being told.
   *
   * {@link loadMore} needs it for the second, worse path: press "Učitaj još" against a slow server
   * and then tap a level chip. Its `this.loading()` check has already run — that is the point, it
   * ran *before* the await — so the late batch appended fifty lines of the **old** query, and its
   * cursor, to the **new** filtered stream.
   */
  private readonly reads = new LatestRequest();

  constructor() {
    this.actions.record(ACTIONS.logsOpen);
    void this.load();

    inject(DestroyRef).onDestroy(() => this.stopTyping());
  }

  /**
   * Read the first page of the stream.
   *
   * Always from the beginning: a filter change is a different question, and appending its answer
   * to the previous one would produce a list that is neither.
   */
  protected async load(): Promise<void> {
    const read = this.reads.claim();
    this.loading.set(true);
    // A batch that was in flight for the previous question is no longer wanted, and the control
    // it belongs to has to stop saying "loading" whether that batch is discarded or not.
    this.loadingMore.set(false);

    const result = await this.platform.listLogs(this.batch());

    if (!this.reads.holds(read)) {
      // A newer question was asked while this one was in flight. Everything below would overwrite
      // it — the rows, the cursor, the status and the page — so nothing below runs, and `loading`
      // is deliberately left alone: it belongs to the newer request now, which will clear it.
      return;
    }

    this.records.set(result.logs);
    this.cursor.set(result.nextCursor);
    this.status.set(result.status);
    // Nothing stays open across a reload: the row a chevron belonged to may not be in the new
    // answer at all, and an id that survives by coincidence would open a different line.
    this.opened.set(new Set());
    // …and back to the top. A filter change is a different question, and page 4 of the last answer
    // describes nothing about this one.
    this.wantedPage.set(1);
    this.loading.set(false);
  }

  /**
   * The next page, **appended**.
   *
   * The reader's place is the whole point. A "load more" that replaced the list would send him
   * back to the top of a stream he was working his way down, and a keyset cursor exists precisely
   * so the rows he has already read do not move.
   */
  protected async loadMore(): Promise<void> {
    const cursor = this.cursor();
    if (!cursor || this.loadingMore() || this.loading()) {
      return;
    }

    // **Captured before the await, never after** — and `current()` rather than `claim()`, because
    // a batch is part of the question already outstanding and claiming would cancel the very list
    // it is extending (`ui/latest-request.ts`).
    const read = this.reads.current();

    this.loadingMore.set(true);
    const result = await this.platform.listLogs(this.batch(cursor));

    if (!this.reads.holds(read)) {
      // The stream was replaced under this batch. Appending it would put fifty lines of the old
      // query, and the old cursor, on the end of the new one. `loadingMore` is already false —
      // `load` cleared it — so there is nothing to undo either.
      return;
    }

    this.loadingMore.set(false);

    if (result.status !== 'ok') {
      // The rows already on screen are still true. Saying so — rather than emptying the list —
      // is the difference between "there is no more" and "I could not ask".
      this.status.set(result.status);
      return;
    }

    // Keyset paging cannot repeat a row, but a server restart between two pages can; the guard
    // costs one Set and removes the one way this list could show a line twice.
    const seen = new Set(this.records().map((log) => log.id));
    this.records.update((was) => [...was, ...result.logs.filter((log) => !seen.has(log.id))]);
    this.cursor.set(result.nextCursor);
    this.status.set('ok');
  }

  /**
   * Move to a page, fetching another batch first if the reader has walked off the end of the buffer.
   *
   * This is where the fifty and the ten meet. Everything already loaded is instant; the one page in
   * five that needs the server waits for it, and if the server refuses, {@link loadMore} leaves the
   * rows already on screen alone and the clamp keeps him on the last page he can actually see.
   */
  protected async goToPage(page: number): Promise<void> {
    const wanted = Math.max(1, Math.trunc(page));

    if (wanted > this.loadedPages() && this.hasMore()) {
      await this.loadMore();
    }

    this.wantedPage.set(wanted);
    this.pruneOpen();
  }

  /**
   * Forget every expanded row that is no longer on the glass.
   *
   * Structural rather than tidy: with this, `opened` can only ever name lines the reader can see,
   * so there is no state in which a detail belongs to a row that has paged away.
   */
  private pruneOpen(): void {
    const visible = new Set(this.rows().map((row) => row.log.id));
    this.opened.update((was) => new Set([...was].filter((id) => visible.has(id))));
  }

  protected toggle(log: LogRecord): void {
    this.opened.update((was) => {
      const next = new Set(was);
      if (!next.delete(log.id)) {
        next.add(log.id);
      }
      return next;
    });
  }

  protected isOpen(log: LogRecord): boolean {
    return this.opened().has(log.id);
  }

  // ---- the filters ----------------------------------------------------------------------------

  /**
   * Tap a triage tile: show only that, or — if it is already the only thing showing — show
   * everything again.
   *
   * The gesture the founder reaches for when the tile says a number he does not like. Toggling
   * back to *everything* rather than to *nothing* is the honest direction: a tile that turned the
   * stream off would leave him looking at an empty screen he did not ask for.
   *
   * **The counts on the tiles are of what is loaded**, so pressing one narrows the *question* and
   * the numbers change. That is not the tile lying — it is the same server-side filtering the level
   * chips do, and the tile stays pressed to say so.
   */
  protected triage(which: 'problems' | 'warnings'): void {
    const levels = which === 'problems' ? PROBLEM_LEVELS : WARNING_LEVELS;
    const already = which === 'problems' ? this.showingProblems() : this.showingWarnings();
    this.wantedLevels.set(new Set(already ? [] : levels));
    this.refilter({ triage: which, on: !already });
  }

  protected toggleFilters(): void {
    this.filtersOpen.update((was) => !was);
  }

  /**
   * Whether a line happened today, in the reader's own day.
   *
   * He is checking today, so a date on every row is a column of the same six characters. Anything
   * older still says which day it was, because *then* the date is the surprising part.
   */
  protected isToday(at: string | null): boolean {
    if (!at) {
      return false;
    }
    const when = new Date(at);
    const now = new Date();
    return (
      when.getFullYear() === now.getFullYear() &&
      when.getMonth() === now.getMonth() &&
      when.getDate() === now.getDate()
    );
  }

  /**
   * Whether a level is worth a chip of its own.
   *
   * Only the two colours that mean something. `INFORMACIJA` on every row spends a phone's scarcest
   * resource on the least surprising fact and makes the two that matter invisible — the failure
   * mode `levelTone` already documents for colour, applied to space.
   */
  protected loud(level: string): boolean {
    return levelTone(level) !== 'neutral';
  }

  protected toggleLevel(level: string): void {
    this.wantedLevels.update((was) => {
      const next = new Set(was);
      if (!next.delete(level)) {
        next.add(level);
      }
      return next;
    });
    this.refilter({ level: level.toLowerCase() });
  }

  /** The tone a level is drawn in — the same four the chips in this product already use. */
  protected toneFor(level: string): LogTone {
    return levelTone(level);
  }

  protected wants(level: string): boolean {
    return this.wantedLevels().has(level);
  }

  protected chooseRange(range: LogRange): void {
    if (this.range() === range) {
      return;
    }
    this.range.set(range);
    this.refilter({ range });
  }

  protected setSource(value: string): void {
    this.source.set(value);
    this.debounce({ field: 'source' });
  }

  protected setQuery(value: string): void {
    this.q.set(value);
    this.debounce({ field: 'message' });
  }

  protected clearFilters(): void {
    this.wantedLevels.set(new Set());
    this.range.set('all');
    this.source.set('');
    this.q.set('');
    this.refilter({ cleared: true });
  }

  /** A filter box changed: wait for him to stop typing, then ask the server once. */
  private debounce(detail: Record<string, string | number | boolean>): void {
    this.stopTyping();
    this.typing = setTimeout(() => {
      this.typing = null;
      this.refilter(detail);
    }, TYPING_PAUSE_MS);
  }

  private refilter(detail: Record<string, string | number | boolean>): void {
    this.stopTyping();
    this.actions.record(ACTIONS.logsFilter, { detail });
    void this.load();
  }

  private stopTyping(): void {
    if (this.typing !== null) {
      clearTimeout(this.typing);
      this.typing = null;
    }
  }

  // ---- the download ---------------------------------------------------------------------------

  /**
   * Pull the whole of the current query as a CSV and hand it to the browser.
   *
   * **With the filters currently applied**, from the same computed the table is drawn from: what
   * he downloads is what he is looking at. It is not the loaded page — the server caps the export
   * at fifty thousand rows and streams them — so the file legitimately holds more than the screen,
   * which is what the button is for.
   */
  protected async download(): Promise<void> {
    if (this.exporting()) {
      return;
    }

    this.exporting.set(true);
    this.exportStatus.set(null);
    this.exportedAs.set(null);
    const started = Date.now();

    const result = await this.platform.exportLogs(this.query());

    this.exporting.set(false);
    this.exportedAs.set(result.filename);
    this.exportStatus.set(result.status === 'ok' ? null : result.status);

    this.actions.record(ACTIONS.logsExport, {
      outcome: result.status === 'ok' ? 'ok' : 'fail',
      durationMs: Date.now() - started,
      detail: { rows: this.count() },
    });
  }

  // ---- words ------------------------------------------------------------------------------------

  /**
   * The word on a level chip.
   *
   * A level this build has never heard of prints **as itself** rather than as a raw translation
   * key: a newer server may add one, and `Notice` beside `Greška` is readable where
   * `logs.level.notice` is a defect on the glass.
   */
  protected levelWord(level: string): string {
    const key = `logs.level.${level.toLowerCase()}`;
    const word = this.transloco.translate(key);
    return word === key ? level : word;
  }

  /** A properties map as rows, so the template does not have to know it is an object. */
  protected propertiesOf(log: LogRecord): { key: string; value: string }[] {
    if (!log.properties) {
      return [];
    }
    return Object.entries(log.properties).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
  }

  protected back(): void {
    void this.router.navigate(['/platform']);
  }
}
