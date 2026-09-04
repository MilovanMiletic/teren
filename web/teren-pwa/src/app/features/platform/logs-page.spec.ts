import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { MockPlatformGateway } from '../../core/platform/mock-platform-gateway';
import { PlatformLogResponse } from '../../core/platform/platform-types';
import { PLATFORM_GATEWAY } from '../../core/platform/platform-gateway';
import { FileSaver } from '../../core/report/file-saver';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import {
  KnobbedPlatformGateway,
  PlatformDeferred,
  platformDeferred,
  platformHttpError,
} from '../../testing/platform-gateway-double';
import { guardedRoutes } from '../../testing/route-harness';
import { routeUrlFor } from '../../testing/route-table';
import { ViewportService } from '../../ui/viewport.service';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { LogsPage } from './logs-page';
import { PlatformPage } from './platform-page';

/** A signed-in member of Teren staff, as `POST /auth/login` left him in this browser. */
const STAFF: AdminSession = {
  token: 'trn_s_a-real-staff-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'super_admin',
  userId: MockPlatformGateway.FOUNDER_ID,
  displayName: 'Milovan Miletić',
  companyId: null,
  companyName: null,
  signedInAt: '2026-09-01T08:00:00.000Z',
};

/** Longer than the screen's own typing pause, so a debounced filter has really been sent. */
const AFTER_TYPING_MS = 500;

/**
 * How many of the fixture's six lines a driven first page carries.
 *
 * Three, so that a second page is genuinely three *other* lines: an append that could be confused
 * with a re-render proves nothing, and rows repeated across the two pages would be swallowed by
 * the screen's own de-duplication.
 */
const FIRST_PAGE = 3;

describe('LogsPage', () => {
  let fixture: ComponentFixture<LogsPage>;
  let element: HTMLElement;
  let gateway: KnobbedPlatformGateway;
  let saved: { blob: Blob; filename: string }[];

  /** The device class decides what is rendered, so it is stubbed rather than measured. */
  let viewport = { atLeastMedium: () => true, expanded: () => true };

  /**
   * @param logs a longer day of the log than the fixture ships, handed to the mock before the
   *   screen reads it. The gateway is minted here, so a spec that seeded one of its own before
   *   calling this would be seeding the instance the last spec threw away.
   */
  /**
   * @param holdFirstRead leave the **first** read of the stream in flight, so the screen can be
   *   observed in the one state where it has no rows and no answer at all. A reload cannot stand
   *   in for it: `load` keeps the previous rows until the new answer lands, so during a refresh
   *   `rows()` is not empty and the empty-stream sentence is unreachable either way.
   */
  async function render(
    medium = true,
    expanded = true,
    logs: PlatformLogResponse[] | null = null,
    holdFirstRead = false,
  ): Promise<void> {
    localStorage.clear();
    localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(STAFF));

    gateway = new KnobbedPlatformGateway();
    if (logs) {
      gateway.real.useLogs(logs);
    }
    saved = [];
    if (holdFirstRead) {
      gateway.logsGate = platformDeferred();
    }
    viewport = { atLeastMedium: () => medium, expanded: () => expanded };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        LogsPage,
        // The real dictionaries: a spec shipping its own copies would pass while the shipped
        // Serbian was missing a key.
        TranslocoTestingModule.forRoot({
          langs: { sr, en },
          translocoConfig: {
            availableLangs: ['sr', 'en'],
            defaultLang: 'sr',
            reRenderOnLangChange: true,
          },
          preloadLangs: true,
        }),
      ],
      providers: [
        provideRouter([]),
        { provide: PLATFORM_GATEWAY, useValue: gateway },
        { provide: ViewportService, useValue: viewport as unknown as ViewportService },
        {
          // The real `FileSaver` would mint an object URL and click an anchor in jsdom. What is
          // under test is *what* is handed to the browser and under what name, not the anchor.
          provide: FileSaver,
          useValue: {
            save: (blob: Blob, filename: string) => saved.push({ blob, filename }),
          } as unknown as FileSaver,
        },
      ],
    });

    fixture = TestBed.createComponent(LogsPage);
    element = fixture.nativeElement as HTMLElement;
    await settle();
  }

  /** Drive change detection until the promise chains the screen started have all landed. */
  async function settle(waitMs = 0): Promise<void> {
    for (let turn = 0; turn < 4; turn += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    fixture.detectChanges();
  }

  function text(): string {
    return element.textContent ?? '';
  }

  function buttons(): HTMLButtonElement[] {
    return [...element.querySelectorAll<HTMLButtonElement>('button')];
  }

  /** A button by what it says — its label **or its accessible name**, since the head row is icons. */
  function button(label: string): HTMLButtonElement {
    const found = buttons().find(
      (candidate) =>
        candidate.textContent?.trim() === label ||
        candidate.getAttribute('aria-label')?.includes(label),
    );
    if (!found) {
      throw new Error(
        `no button reading "${label}"; there are: ` +
          buttons()
            .map((c) => `"${c.textContent?.trim() || c.getAttribute('aria-label')}"`)
            .join(', '),
      );
    }
    return found;
  }

  async function press(label: string, waitMs = 0): Promise<void> {
    button(label).click();
    await settle(waitMs);
  }

  /**
   * The summary card, which is where this screen says how much it has loaded.
   *
   * There was a count strip above the column heads saying the same number a second time; the
   * founder had it removed off a 1920 screenshot (2026-09-02). The honesty specs below therefore
   * read the card — the same claim, in the one place that makes it.
   */
  function summary(): string {
    const card = element.querySelector('.stats');
    if (!card) {
      return '';
    }
    // Cell by cell, because the label and the value are separate elements with no whitespace
    // between them — and the uppercase a reader sees is `text-transform`, which jsdom does not do.
    return [...card.querySelectorAll('.stats__cell')]
      .map(
        (cell) =>
          `${cell.querySelector('dt')?.textContent?.trim()} ${cell
            .querySelector('dd')
            ?.textContent?.trim()}`,
      )
      .join(' · ');
  }

  /** The next-page arrow, whose accessible name is the only thing that identifies it. */
  function nextArrow(): HTMLButtonElement | null {
    return (
      [...element.querySelectorAll<HTMLButtonElement>('.pager__step')].find(
        (candidate) => candidate.getAttribute('aria-label') === sr.table.pager.next,
      ) ?? null
    );
  }

  /** The foot of the stream card: the arrows, and the "load more" projected between them. */
  function foot(): string {
    return element.querySelector('.pager')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  /**
   * Type into one column's filter box, through the control every table in the product uses.
   *
   * Driven through the real `ColumnMenu` — the funnel, then the input — rather than by calling the
   * component's own method: the coupling between that control and a *server-side* filter is new on
   * this screen, and a spec that reached past it would prove nothing about it.
   */
  async function filterColumn(column: string, value: string): Promise<void> {
    const funnel = buttons().find((candidate) =>
      candidate.getAttribute('aria-label')?.includes(column),
    );
    if (!funnel) {
      throw new Error(`no filter control for the "${column}" column`);
    }
    funnel.click();
    await settle();

    const box = element.querySelector('.menu__input') as HTMLInputElement;
    box.value = value;
    box.dispatchEvent(new Event('input'));
    await settle(AFTER_TYPING_MS);
  }

  /**
   * Make the six-line fixture actually page, by narrowing the **question** rather than forging the
   * answer.
   *
   * The fixture is a legible day of a log, not a load test, and the screen asks for fifty lines, so
   * keyset paging never engages on its own. This stub passes the screen's own query through to the
   * real `MockPlatformGateway` with a small `limit`, so page one, its cursor, and page two are all
   * genuinely the mock's — the same keyset arithmetic the server performs.
   *
   * **It used to forge only the bookmark, and that could not work.** Overriding `next_cursor` on a
   * response that already carried every row meant the second call answered with rows the first had
   * already delivered; the screen's own de-duplication then correctly dropped all of them, and an
   * append could never be observed no matter how right the component was. The spec failed and the
   * code was innocent — which is the expensive direction for a test to be wrong in.
   */
  function pageInto(size: number): void {
    const real = gateway.real;
    vi.spyOn(gateway, 'listLogs').mockImplementation(async (query = {}) => {
      gateway.logQueries.push(query);
      if (gateway.logsError) {
        throw gateway.logsError;
      }
      return real.listLogs({ ...query, limit: size });
    });
  }

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  // ---- What is on screen -----------------------------------------------------------------------

  describe('the stream', () => {
    it('draws a real table at 1024 and up', async () => {
      await render(true, true);

      expect(element.querySelector('table')).not.toBeNull();
      expect(element.querySelectorAll('tbody tr.line').length).toBeGreaterThan(0);
      expect(text()).toContain('Report 3f2a1c delivery failed after 3 attempts');
    });

    /**
     * The plan's instruction for this screen, in as many words: *"a filtered list of collapsed
     * entries that expand on tap, not a shrunken table"*. Two renderings, decided in TypeScript —
     * a `<table>` whose cells are forced to `display: block` loses its table role in every browser.
     */
    it('draws a list of collapsed lines below 1024, and no table at all', async () => {
      await render(false, false);

      expect(element.querySelector('table')).toBeNull();
      expect(element.querySelectorAll('.line-item').length).toBeGreaterThan(0);
      // Collapsed: the stack trace is not on the glass until somebody asks for it.
      expect(text()).not.toContain('SocketException');
    });

    /**
     * **The tablet gets the list too, and this is the guard that says so** (founder, 2026-09-02:
     * *"we will need a better structure of the logs for the phone and tablet, now it is a little
     * messy"*).
     *
     * The table used to be drawn from 768 up. Driven at 834 that left the message column about
     * 300 px — every message wrapping four and five lines, 150 px rows — while the time and level
     * columns held 250 px between them repeating the same timestamp shape and the same
     * `INFORMACIJA` down the page. A tablet was getting the desktop's layout with its one useful
     * column squeezed, which is the "narrowed copy of another device class" CLAUDE.md forbids.
     *
     * Worth its own spec because **no spec caught the change**: every table assertion here passes
     * `render(true, true)`, so all of them were really testing expanded, and the medium class was
     * pinned by nothing at all. It is pinned now.
     */
    it('draws the list at medium too, not a squeezed desktop table', async () => {
      await render(true, false);

      expect(element.querySelector('table')).toBeNull();
      expect(element.querySelectorAll('.line-item').length).toBeGreaterThan(0);
    });

    /** The ids column is width the expanded table has and the two classes below it do not. */
    it('spends the extra width on ids rather than on a wider margin', async () => {
      await render(true, false);
      expect(text()).not.toContain(sr.logs.column.ids);

      await render(true, true);
      expect(text()).toContain(sr.logs.column.ids);
    });
  });

  // ---- Standing in a corridor ------------------------------------------------------------------

  describe('the triage strip, below 1024', () => {
    /** The tiles, in order: errors, warnings. The loaded count is a span, not a control. */
    function tiles(): HTMLButtonElement[] {
      return [...element.querySelectorAll<HTMLButtonElement>('.stats__cell--tap')];
    }

    /**
     * **The question he is actually asking, answered where he is standing.**
     *
     * Until now the two counts that mean something were drawn at 1024 and up only, so a founder on
     * a phone had to read the lines to find out whether anything was wrong. Below 1024 they are the
     * first thing on the screen.
     */
    it('puts the two numbers that matter on the phone at all', async () => {
      await render(false, false);

      expect(element.querySelector('.stats')).not.toBeNull();
      expect(text()).toContain(sr.logs.summary.errors);
      expect(text()).toContain(sr.logs.summary.warnings);
    });

    /**
     * **And they are controls.** The gesture he reaches for the moment a tile says a number he does
     * not like: show me only those. Asked of the server, like every other filter on this screen.
     */
    it('asks the server for exactly that level when a tile is tapped', async () => {
      await render(false, false);

      tiles()[0].click();
      await settle();

      expect(gateway.logQueries.at(-1)?.levels).toEqual(['Error', 'Fatal']);
      expect(tiles()[0].getAttribute('aria-pressed')).toBe('true');
    });

    /**
     * Pressing it again goes back to **everything**, not to nothing: a tile that turned the stream
     * off would leave him looking at an empty screen he did not ask for.
     */
    it('gives the whole stream back when the same tile is tapped again', async () => {
      await render(false, false);

      tiles()[0].click();
      await settle();
      tiles()[0].click();
      await settle();

      expect(gateway.logQueries.at(-1)?.levels).toEqual([]);
      expect(tiles()[0].getAttribute('aria-pressed')).toBe('false');
    });

    /** The loaded count is a fact, not a question — it is not a button and cannot be pressed. */
    it('leaves the loaded count as plain text', async () => {
      await render(false, false);

      expect(tiles()).toHaveLength(2);
      expect(element.querySelectorAll('.stats__cell')).toHaveLength(3);
    });

    /** The same rule the summary card already had: never a count over an answer that never came. */
    it('is not drawn over a stream that could not be read', async () => {
      await render(false, false);
      gateway.logsError = platformHttpError(503);
      await press(sr.logs.reload);

      expect(element.querySelector('.stats')).toBeNull();
    });
  });

  describe('the filter card, below 1024', () => {
    /**
     * **Shut by default, because the lines come first.**
     *
     * PERIOD is four pills and NIVO is six more; at 390×844 that put 53 % of the first viewport
     * above the first log line, with the last option in each row sliced mid-word at the card's
     * edge. He is standing in a corridor asking whether anything is wrong.
     */
    it('keeps the ten filter pills behind one tap', async () => {
      await render(false, false);

      // Scoped to the card, not the page: `Greška` is also the word on an error row's own chip,
      // and asserting over the whole screen would be asking the filter card about the stream.
      const card = () => element.querySelector('.filters')?.textContent ?? '';
      expect(card()).not.toContain(sr.logs.range.hour);
      expect(card()).not.toContain(sr.logs.level.error);
      expect(card()).toContain(sr.logs.filters.title);

      (element.querySelector('.filters__disclosure') as HTMLButtonElement).click();
      await settle();

      expect(card()).toContain(sr.logs.range.hour);
      expect(card()).toContain(sr.logs.level.error);
    });

    /** …and it says when something is live, because a filter nobody can see is the whole trap. */
    it('says on its face when a filter is live', async () => {
      await render(false, false);
      expect(element.querySelector('.filters__disclosure .chip')).toBeNull();

      [...element.querySelectorAll<HTMLButtonElement>('.stats__cell--tap')][0].click();
      await settle();

      expect(element.querySelector('.filters__disclosure .chip')?.textContent?.trim()).toBe(
        sr.logs.filters.on,
      );
    });

    /** At 1024 and up there is room for both, so the card is simply open and has no disclosure. */
    it('is always open at expanded, with no disclosure at all', async () => {
      await render(true, true);

      expect(element.querySelector('.filters__disclosure')).toBeNull();
      expect(element.querySelector('.filters')?.textContent).toContain(sr.logs.range.hour);
    });
  });

  describe('the row, built for scanning', () => {
    /**
     * **`INFORMACIJA` on every row spends a phone's scarcest resource on the least surprising
     * fact** — and makes the two chips that matter invisible, which is the failure mode `levelTone`
     * documents for colour, applied to space. The level is never lost: it is a fact in the detail,
     * and the row wears its tone as a stripe.
     */
    it('draws a chip only for the levels worth alarm', async () => {
      await render(false, false);

      const chips = [...element.querySelectorAll('.line-item .chip')].map((c) =>
        c.textContent?.trim(),
      );
      expect(chips).not.toContain(sr.logs.level.information);
      expect(chips).toContain(sr.logs.level.error);
      expect(element.querySelector('.line-item--err')).not.toBeNull();
    });

    /**
     * **He is checking today.** A date on every row is a column of the same six characters; an
     * older line still says which day, because then the day is the surprising part.
     */
    it('drops the date from today’s lines and keeps it on older ones', async () => {
      const today = new Date();
      const older = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
      await render(false, false, [
        {
          id: '99002',
          at: today.toISOString(),
          level: 'Information',
          source: 'Teren.Api.Test',
          template: 'x',
          message: 'Danasnja linija',
          properties: null,
          exception: null,
          company_id: null,
          entry_id: null,
          correlation: null,
        },
        {
          id: '99001',
          at: older.toISOString(),
          level: 'Information',
          source: 'Teren.Api.Test',
          template: 'x',
          message: 'Starija linija',
          properties: null,
          exception: null,
          company_id: null,
          entry_id: null,
          correlation: null,
        },
      ]);

      const times = [...element.querySelectorAll('.line-item__time')].map((n) =>
        n.textContent?.trim(),
      );
      expect(times[0]).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(times[1]).toMatch(/^\d+\.\d+\. \d{2}:\d{2}:\d{2}$/);
    });
  });

  // ---- Opening a line --------------------------------------------------------------------------

  describe('opening a line', () => {
    it('expands in place on a phone, keeping the lines around it', async () => {
      await render(false, false);
      const before = element.querySelectorAll('.line-item').length;

      const row = element.querySelector('.line-item__summary') as HTMLButtonElement;
      row.click();
      await settle();

      expect(element.querySelectorAll('.line-item').length).toBe(before);
      expect(element.querySelectorAll('.detail').length).toBe(1);
    });

    it('shows the template, the properties and the scrubbed exception', async () => {
      await render(true, true);

      // The error line is the third row; it is the one with a stack trace on it.
      const toggles = [...element.querySelectorAll<HTMLButtonElement>('.line__toggle')];
      toggles[2].click();
      await settle();

      const detail = element.querySelector('.detail')?.textContent ?? '';
      expect(detail).toContain('Report {ReportId} delivery failed after {Attempts} attempts');
      expect(detail).toContain('ReportId');
      expect(detail).toContain('SocketException');
      expect(detail).toContain('c1a1f0e2-0000-4000-8000-000000000003');
    });

    it('says a line has no exception rather than leaving the block empty', async () => {
      await render(true, true);

      const toggles = [...element.querySelectorAll<HTMLButtonElement>('.line__toggle')];
      toggles[0].click();
      await settle();

      expect(element.querySelector('.detail')?.textContent).toContain(sr.logs.detail.noException);
    });

    it('closes everything on a reload, so a chevron cannot open a different line', async () => {
      await render(true, true);
      (element.querySelector('.line__toggle') as HTMLButtonElement).click();
      await settle();
      expect(element.querySelectorAll('.detail')).toHaveLength(1);

      await press(sr.logs.reload);

      expect(element.querySelectorAll('.detail')).toHaveLength(0);
    });
  });

  // ---- The count -------------------------------------------------------------------------------

  describe('what it says it knows', () => {
    /**
     * **The one sentence on this screen that separates it from every other table in the product.**
     *
     * The others print "showing 3 of 12" because they hold all twelve. This holds one keyset page
     * of a stream and cannot know a total, so it says what it does know — how many are loaded —
     * and never a fraction. A count that implied a total would be the same lie as a quietly
     * filtered directory, on the screen an owner opens precisely because he does not trust what he
     * is being told.
     */
    it('never prints a total it cannot know', async () => {
      await render(true, true);

      // What it does know, said once: how many lines are in hand.
      expect(summary()).toContain('Učitano 6');
      // …and nowhere a fraction. The strip that used to be checked here is gone; the chrome that
      // replaced it — the summary and the foot — is what could still carry one.
      expect(summary()).not.toMatch(/\bod\b|\bof\b/);
      expect(foot()).not.toMatch(/\bod\b|\bof\b/);
      expect(element.querySelector('.table-bar'), 'the duplicate count strip is gone').toBeNull();
    });

    /**
     * The other half of the same sentence, and the half a total would have hidden.
     *
     * The fixture is smaller than one page, so a cursor is stubbed in: what is under test is that
     * the screen repeats what the server told it — there is more behind this — rather than
     * implying that what is drawn is everything.
     */
    it('says when the server is holding more behind what is loaded', async () => {
      await render(true, true);
      pageInto(FIRST_PAGE);
      await press(sr.logs.reload);

      // **The control is the claim now.** With the sentence gone, "there is more behind this" is
      // said by the presence of a live "Učitaj još" and a next arrow that is not dead — which is
      // the honest form of it, because both are things the server's cursor actually licenses.
      expect(foot()).toContain(sr.logs.more.action);
      expect(nextArrow()?.disabled).toBe(false);
    });
  });

  // ---- Filtering, on the server ------------------------------------------------------------------

  describe('the filters, which run on the server', () => {
    it('asks the server again rather than narrowing the page it holds', async () => {
      await render(true, true);
      const before = gateway.logQueries.length;

      await filterColumn(sr.logs.column.source, 'EntryReporter');

      expect(gateway.logQueries.length).toBeGreaterThan(before);
      expect(gateway.logQueries.at(-1)?.source).toBe('EntryReporter');
      expect(element.querySelectorAll('tbody tr.line')).toHaveLength(1);
    });

    it('waits for him to stop typing before it asks', async () => {
      await render(true, true);
      const before = gateway.logQueries.length;

      const funnel = buttons().find((candidate) =>
        candidate.getAttribute('aria-label')?.includes(sr.logs.column.message),
      ) as HTMLButtonElement;
      funnel.click();
      await settle();

      const box = element.querySelector('.menu__input') as HTMLInputElement;
      for (const value of ['R', 'Re', 'Rep', 'Repo']) {
        box.value = value;
        box.dispatchEvent(new Event('input'));
      }
      await settle();

      // Nothing yet: four keystrokes are one question, not four.
      expect(gateway.logQueries.length).toBe(before);

      await settle(AFTER_TYPING_MS);
      expect(gateway.logQueries.length).toBe(before + 1);
      expect(gateway.logQueries.at(-1)?.q).toBe('Repo');
    });

    it('sends the levels as a set, and empty means every level', async () => {
      await render(true, true);
      expect(gateway.logQueries[0].levels).toEqual([]);

      await press(sr.logs.level.error);

      expect(gateway.logQueries.at(-1)?.levels).toEqual(['Error']);
      expect(element.querySelectorAll('tbody tr.line')).toHaveLength(1);
    });

    it('turns a period into an instant the server understands', async () => {
      await render(true, true);
      expect(gateway.logQueries[0].from).toBeUndefined();

      await press(sr.logs.range.hour);

      const from = gateway.logQueries.at(-1)?.from;
      expect(from).toBeTruthy();
      expect(Date.parse(from as string)).toBeLessThanOrEqual(Date.now());
    });

    it('opens with nothing filtered, so it cannot answer him wrongly before he touches it', async () => {
      await render(true, true);

      expect(gateway.logQueries[0]).toMatchObject({ levels: [] });
      expect(gateway.logQueries[0].source).toBeUndefined();
      expect(gateway.logQueries[0].q).toBeUndefined();
      expect(gateway.logQueries[0].from).toBeUndefined();
      // …and there is nothing to clear, so the way out is not offered over an unfiltered list.
      expect(text()).not.toContain(sr.logs.filters.clear);
    });

    /**
     * **A control may never be removed by the state it caused.**
     *
     * The table used to be dropped whole when an answer was empty, and the funnels — the filter
     * boxes — went with it. A founder who mistyped "EntryReporte" was then looking at an empty
     * screen with no way to correct the word: his only exit was "remove the filters", which also
     * threw away the level chips he had picked to get there.
     */
    it('keeps the control that emptied the list, so a typo can be corrected in place', async () => {
      await render(true, true);
      await press(sr.logs.level.error);
      await filterColumn(sr.logs.column.source, 'EntryReporte-typo');

      expect(element.querySelectorAll('tbody tr.line')).toHaveLength(0);
      // The header is still on screen, and so, still open, is the box he typed into.
      expect(element.querySelector('thead')).not.toBeNull();
      expect(
        buttons().some((candidate) =>
          candidate.getAttribute('aria-label')?.includes(sr.logs.column.source),
        ),
        'the source filter went away with the rows it emptied',
      ).toBe(true);
      const box = element.querySelector('.menu__input') as HTMLInputElement | null;
      expect(box, 'the filter box went away with the rows it emptied').not.toBeNull();

      // …and correcting the word in place brings the line back, level chip still picked.
      (box as HTMLInputElement).value = 'EntryReporter';
      (box as HTMLInputElement).dispatchEvent(new Event('input'));
      await settle(AFTER_TYPING_MS);

      expect(element.querySelectorAll('tbody tr.line')).toHaveLength(1);
      expect(gateway.logQueries.at(-1)?.levels).toEqual(['Error']);
      expect(gateway.logQueries.at(-1)?.source).toBe('EntryReporter');
    });

    it('offers one way back to the whole stream, and it really clears everything', async () => {
      await render(true, true);
      await press(sr.logs.level.error);
      await filterColumn(sr.logs.column.source, 'Reporter');

      await press(sr.logs.filters.clear);

      expect(gateway.logQueries.at(-1)).toMatchObject({ levels: [] });
      expect(gateway.logQueries.at(-1)?.source).toBeUndefined();
      expect(element.querySelectorAll('tbody tr.line').length).toBeGreaterThan(1);
    });
  });

  // ---- Keyset paging ----------------------------------------------------------------------------

  describe('load more', () => {
    /**
     * **It must not lose the reader's place.**
     *
     * A keyset cursor exists precisely so the rows he has already read do not move. A "load more"
     * that replaced the list would send him back to the top of a stream he was working his way
     * down, which on a log is the whole of the task.
     */
    it('follows the cursor and appends, keeping every line already on screen', async () => {
      await render(true, true);
      pageInto(FIRST_PAGE);
      await press(sr.logs.reload);

      const before = element.querySelectorAll('tbody tr.line').length;
      const firstBefore = element.querySelector('tbody tr.line')?.textContent;

      await press(sr.logs.more.action);

      expect(gateway.logQueries.at(-1)?.cursor).toBe('80423');
      expect(element.querySelectorAll('tbody tr.line').length).toBeGreaterThan(before);
      expect(element.querySelector('tbody tr.line')?.textContent).toBe(firstBefore);
    });

    it('shows a line once, even if a server restart repeats it across two pages', async () => {
      await render(true, true);
      pageInto(FIRST_PAGE);
      await press(sr.logs.reload);
      const before = element.querySelectorAll('tbody tr.line').length;

      // The same page again, which a restarted server can genuinely answer: it forgets the
      // cursor and replies from the top. Every row it sends is one the screen already holds.
      vi.spyOn(gateway, 'listLogs').mockImplementation(async (query = {}) => {
        gateway.logQueries.push(query);
        return { ...(await gateway.real.listLogs({ limit: FIRST_PAGE })), next_cursor: null };
      });
      await press(sr.logs.more.action);

      expect(element.querySelectorAll('tbody tr.line').length).toBe(before);
    });

    /**
     * The rows already on screen are still true. Emptying the list would turn "I could not ask"
     * into "there is no more", which are opposite things to a founder chasing an error.
     */
    it('keeps the lines it has when the next page cannot be fetched', async () => {
      await render(true, true);
      pageInto(FIRST_PAGE);
      await press(sr.logs.reload);
      const before = element.querySelectorAll('tbody tr.line').length;

      gateway.logsError = platformHttpError(503);
      await press(sr.logs.more.action);

      expect(element.querySelectorAll('tbody tr.line').length).toBe(before);
      expect(text()).toContain(sr.platform.stale.title);
    });
  });

  // ---- A control may never be removed by the request it fires ----------------------------------

  describe('while a request is in flight', () => {
    /**
     * **The property the file already claimed, re-proven against a loading frame that renders.**
     *
     * The spec above it — *"keeps the control that emptied the list"* — passed against the shipped
     * defect, and that was part of the finding rather than incidental: the mock resolves inside a
     * microtask, so `loading()` was never `true` at a `detectChanges()` and the assertion described
     * a frame the test never drew. Same pathology as the substituted `IJobQueueDepth` seam and the
     * microtask-settled navigation specs (CLAUDE.md, 2026-09-03): a spec that could not fail.
     *
     * So the gateway is held open here, and the first assertion is that the screen really is in the
     * state under test. Without that line the rest of this is decoration again.
     */
    it('keeps the filter box a keystroke destroyed, at 1024 where it lives in the table head', async () => {
      await render(true, true);

      // Open the message funnel and type, exactly as the founder does.
      const funnel = buttons().find((candidate) =>
        candidate.getAttribute('aria-label')?.includes(sr.logs.column.message),
      ) as HTMLButtonElement;
      funnel.click();
      await settle();

      const box = element.querySelector('.menu__input') as HTMLInputElement;
      expect(box, 'the filter box did not open').not.toBeNull();
      box.value = 'Ent';
      box.dispatchEvent(new Event('input'));

      // Held open *before* the debounce fires, so the refilter's `load()` is still in flight when
      // the screen is read.
      gateway.logsGate = platformDeferred();
      await settle(AFTER_TYPING_MS);

      // **The non-vacuity check, and it is deliberately not the fix's own marker.** `logs.loading`
      // is the screen reader's sentence, which both the old skeleton card and the new in-card
      // skeleton carry — so reverting the fix makes this spec fail on the *property* rather than
      // on the probe. Without this line the assertions below describe a frame nobody drew.
      expect(
        text(),
        'the loading frame never rendered — this spec would pass against the defect',
      ).toContain(sr.logs.loading);
      expect(element.querySelectorAll('tbody tr.line')).toHaveLength(0);

      // …and the header, the funnel and the focused box he is typing into are all still there.
      expect(element.querySelector('thead')).not.toBeNull();
      const live = element.querySelector('.menu__input') as HTMLInputElement | null;
      expect(live, 'the request destroyed the box that fired it').not.toBeNull();
      expect(live?.value).toBe('Ent');
      expect(document.activeElement, 'the box lost focus mid-word').toBe(live);

      // The next keystrokes go somewhere: the word is finished while the first answer is still out.
      (live as HTMLInputElement).value = 'Report';
      (live as HTMLInputElement).dispatchEvent(new Event('input'));
      gateway.logsGate.release();
      gateway.logsGate = null;
      await settle(AFTER_TYPING_MS);

      expect(gateway.logQueries.at(-1)?.q).toBe('Report');
      expect(element.querySelectorAll('tbody tr.line').length).toBeGreaterThan(0);
    });

    /** The same at 834 and 390, where the pills live in the filter card and always survived. */
    it('keeps the filter pill below 1024 too', async () => {
      await render(false, false);

      const funnel = buttons().find((candidate) =>
        candidate.getAttribute('aria-label')?.includes(sr.logs.column.message),
      );
      expect(funnel, 'the filter card is shut — open it first').toBeUndefined();

      await press(sr.logs.filters.title);
      const pill = buttons().find((candidate) =>
        candidate.getAttribute('aria-label')?.includes(sr.logs.column.message),
      ) as HTMLButtonElement;
      pill.click();
      await settle();

      const box = element.querySelector('.menu__input') as HTMLInputElement;
      box.value = 'Ent';
      box.dispatchEvent(new Event('input'));
      gateway.logsGate = platformDeferred();
      await settle(AFTER_TYPING_MS);

      expect(text()).toContain(sr.logs.loading);
      expect((element.querySelector('.menu__input') as HTMLInputElement | null)?.value).toBe('Ent');

      gateway.logsGate.release();
      gateway.logsGate = null;
      await settle();
    });

    /**
     * Where the bars now are, which is the fix stated as a shape: **inside** the card, with the
     * header above them. `aria-busy` on the card is what a screen reader gets for the same fact.
     */
    it('draws the skeleton in the card rather than in place of it', async () => {
      await render(true, true);

      gateway.logsGate = platformDeferred();
      button(sr.logs.reload).click();
      await settle();

      const card = element.querySelector('.stream');
      expect(card, 'the stream card was replaced whole').not.toBeNull();
      expect(card?.getAttribute('aria-busy')).toBe('true');
      expect(card?.querySelector('thead')).not.toBeNull();
      expect(card?.querySelector('.card--loading')).not.toBeNull();

      gateway.logsGate.release();
      gateway.logsGate = null;
      await settle();
      expect(element.querySelector('.stream')?.getAttribute('aria-busy')).toBe('false');
    });

    /**
     * **Nothing may claim the stream is empty while it is unknown.**
     *
     * `logs.empty.none` — *"nothing has happened"* — over rows that have not come back is the same
     * false claim the summary tiles are withheld for, on the screen whose whole job is saying
     * whether anything is wrong.
     */
    it('says nothing about an empty stream while the rows are still coming', async () => {
      // The **first** read, held open: no rows, no answer, nothing known. A reload cannot show
      // this — `load` keeps the previous rows until the new answer lands.
      await render(true, true, null, true);

      expect(text()).toContain(sr.logs.loading);
      expect(element.querySelectorAll('tbody tr.line')).toHaveLength(0);
      // *"Ništa se nije dogodilo"* over rows that have not come back is the same false claim the
      // summary tiles are withheld for, on the screen whose whole job is saying whether anything
      // is wrong — and a pager numbering pages of a list nobody has is the same mistake.
      expect(text(), 'the screen claimed the stream is empty').not.toContain(sr.logs.empty.none);
      expect(text()).not.toContain(sr.logs.empty.filtered);
      expect(element.querySelector('.pager'), 'a pager for a list nobody has').toBeNull();

      gateway.logsGate?.release();
      gateway.logsGate = null;
      await settle();
      expect(element.querySelectorAll('tbody tr.line').length).toBeGreaterThan(0);
    });
  });

  // ---- An older answer must never overwrite a newer question ------------------------------------

  describe('request generation', () => {
    /**
     * **The measured defect** (review, 2026-09-04): `q=a` stubbed at 2 s and `q=ab` at 100 ms;
     * type `a`, pause, type `b`; three seconds later the screen showed the rows for `a`.
     *
     * And the ordering is the ordinary one, not a contrived one: `ILIKE '%a%'` over a large
     * `app_log` is slower than `'%ab%'`, so the broader question a man types first is exactly the
     * one that comes back last.
     *
     * Driven with two gates rather than two timers, which is the same ordering without the wall
     * clock: hold the first question open, ask the second, let it answer, then release the first.
     */
    it('discards an answer to a question that is no longer being asked', async () => {
      await render(true, true);

      // Two questions, driven through the **level and period chips** rather than a filter box.
      // Those live in the filter card, which is outside the loading branch in every build — so
      // this spec is about `load`'s generation guard and nothing else, and reverting the template
      // fix cannot make it red for the wrong reason.
      const first = platformDeferred();
      gateway.logsGate = first;
      button(sr.logs.level.error).click();
      await settle();
      expect(gateway.logQueries.at(-1)?.levels).toEqual(['Error']);

      // The second question — the same chip, pressed again, which is *every* level — answers
      // immediately and paints. The narrow question coming back last is exactly the ordering a
      // large `app_log` produces on its own: `ILIKE '%a%'` is slower than `'%ab%'`.
      gateway.logsGate = null;
      await press(sr.logs.level.error);
      expect(gateway.logQueries.at(-1)?.levels).toEqual([]);
      const afterSecond = element.querySelectorAll('tbody tr.line').length;
      // More than the one line the first question would have left behind, so the two answers are
      // genuinely distinguishable on the glass.
      expect(afterSecond).toBeGreaterThan(1);

      // Now the slow first answer lands. It must change nothing at all.
      first.release();
      await settle();

      expect(
        element.querySelectorAll('tbody tr.line').length,
        'the old answer repainted the new question',
      ).toBe(afterSecond);
      // The information lines the current question asks for are still there: the stale answer
      // held one error row and nothing else.
      expect(text()).toContain('Report 3f2a1c delivery failed after 3 attempts');
      // …and the screen is not left saying it is still loading, which is the other way this
      // could go wrong: the newer request owns `loading` and cleared it.
      expect(text()).not.toContain(sr.logs.loading);
    });

    /**
     * **The second path, and the worse one.** `loadMore`'s `this.loading()` check runs *before* the
     * await, so a batch already in flight is not stopped by a filter change — it resolved and
     * appended fifty lines of the old query, and the old cursor, to the new filtered stream.
     */
    it('never appends a batch of the old query to a newly filtered stream', async () => {
      await render(true, true);

      // `pageInto` cannot be used here: its stub does not honour `logsGate`, and this spec needs
      // one batch held open while another question is asked. Same arithmetic, one gate.
      const real = gateway.real;
      let gate: PlatformDeferred | null = null;
      vi.spyOn(gateway, 'listLogs').mockImplementation(async (query = {}) => {
        gateway.logQueries.push(query);
        await gate?.promise;
        return real.listLogs({ ...query, limit: FIRST_PAGE });
      });
      await press(sr.logs.reload);
      expect(element.querySelectorAll('tbody tr.line')).toHaveLength(FIRST_PAGE);

      // "Učitaj još" against a slow server…
      const slow = platformDeferred();
      gate = slow;
      button(sr.logs.more.action).click();
      await settle();

      // …then a level chip, which is a different question and replaces the list.
      gate = null;
      await press(sr.logs.level.error);
      const filtered = element.querySelectorAll('tbody tr.line').length;
      expect(gateway.logQueries.at(-1)?.levels).toEqual(['Error']);

      // The late batch lands. Nothing of it may reach the screen.
      slow.release();
      await settle();

      expect(
        element.querySelectorAll('tbody tr.line').length,
        'the old batch was appended to the filtered stream',
      ).toBe(filtered);
      // Every row on screen still belongs to the question being asked.
      expect(
        [...element.querySelectorAll('tbody tr.line .chip')].every((chip) =>
          chip.textContent?.includes(sr.logs.level.error),
        ),
        'a row that is not an error survived on an error-filtered stream',
      ).toBe(true);
    });
  });

  // ---- The download ------------------------------------------------------------------------------

  describe('the download', () => {
    /**
     * **What he downloads must be what he is looking at.**
     *
     * The contract gives the export the same parameters as the stream for exactly this reason, and
     * the only way to prove it is to compare the two queries that actually reached the wire.
     */
    it('exports with the filters currently applied', async () => {
      await render(true, true);
      await press(sr.logs.level.error);
      await filterColumn(sr.logs.column.source, 'Reporter');

      await press(sr.logs.export.action);

      const listed = gateway.logQueries.at(-1);
      const exported = gateway.exportQueries.at(-1);
      expect(exported?.levels).toEqual(listed?.levels);
      expect(exported?.source).toBe(listed?.source);
      expect(exported?.q).toBe(listed?.q);
      expect(exported?.from).toBe(listed?.from);
    });

    /**
     * **…and only the filters.**
     *
     * The screen's page size used to live in the same computed as the filters, so the download
     * went out as `…/export?level=Error&limit=50` — a request for a *file* of the fifty lines
     * already on the glass, which is not what the button is for. Contract §2 gives the export the
     * filters and neither a cursor nor a limit, and says a caller who sends one is told rather
     * than ignored; the mock refuses them for that reason, so this is proven by the download
     * arriving at all as well as by the two undefineds.
     */
    it('asks for the whole of the query, with no page size and no cursor on it', async () => {
      await render(true, true);
      pageInto(FIRST_PAGE);
      await press(sr.logs.reload);
      await press(sr.logs.more.action);
      // A cursor is live on the stream at this point, which is the state that would leak one.
      expect(gateway.logQueries.at(-1)?.cursor).toBeTruthy();

      await press(sr.logs.export.action);

      const exported = gateway.exportQueries.at(-1);
      expect(exported?.limit).toBeUndefined();
      expect(exported?.cursor).toBeUndefined();
      expect(
        gateway.logQueries.at(-1)?.limit,
        'the stream itself still asks for one page',
      ).toBeGreaterThan(0);
      expect(text()).toContain(sr.logs.export.done);
    });

    it('hands the browser a CSV and says what it was called', async () => {
      await render(true, true);

      await press(sr.logs.export.action);

      expect(saved).toHaveLength(1);
      expect(saved[0].filename).toMatch(/\.csv$/);
      expect(text()).toContain(sr.logs.export.done);
      expect(text()).toContain(saved[0].filename);
    });

    it('names the file itself when the server’s own name cannot be read', async () => {
      await render(true, true);
      vi.spyOn(gateway, 'exportLogs').mockResolvedValue({
        body: new Blob(['x']),
        // Cross-origin without `Access-Control-Expose-Headers`, which is every development setup
        // here. An ordinary outcome, not a failure.
        contentDisposition: null,
      });

      await press(sr.logs.export.action);

      expect(saved[0].filename).toMatch(/^teren-logs-\d{8}-\d{4}\.csv$/);
    });

    /**
     * A 200 with nothing in it is not a log. Saved rather than refused, an empty CSV looks to a
     * founder exactly like a product that has done nothing — the one wrong conclusion this screen
     * must never invite.
     */
    it('refuses to save an empty file, and says the download did not go through', async () => {
      await render(true, true);
      gateway.emptyExport = true;

      await press(sr.logs.export.action);

      expect(saved).toHaveLength(0);
      expect(text()).toContain(sr.logs.export.failed);
    });

    it('says why, in the words the server’s answer earns', async () => {
      await render(true, true);
      gateway.exportError = platformHttpError(403);

      await press(sr.logs.export.action);

      expect(saved).toHaveLength(0);
      expect(text()).toContain(sr.logs.export.failed);
      expect(text()).toContain(sr.platform.reason.forbidden);
    });
  });

  // ---- Failure -------------------------------------------------------------------------------------

  describe('when the server cannot be asked', () => {
    it('says so before anything else, rather than showing an empty log', async () => {
      await render(true, true);
      gateway.logsError = platformHttpError(0);

      await press(sr.logs.reload);

      expect(text()).toContain(sr.platform.stale.title);
      expect(text()).toContain(sr.platform.reason.offline);
    });

    /**
     * **And it says only that.**
     *
     * A failed read empties the list, and the count strip and the empty state were drawn over it
     * regardless: under "Nije provereno na serveru" the screen printed *"Učitano 0 linija — to je
     * sve"* and *"Nijedna linija ne odgovara ovim filterima."* — "there is nothing" and "I could
     * not ask", on one screen, about the same instant. On the one screen an owner opens because he
     * does not trust what he is being told, that is the worst sentence in the product.
     */
    it('never counts an answer it did not get, or calls it empty', async () => {
      await render(true, true);
      expect(
        element.querySelector('.stats'),
        'the summary is drawn over a real answer',
      ).not.toBeNull();

      gateway.logsError = platformHttpError(503);
      await press(sr.logs.reload);

      // "GREŠKE 0" in the largest type on the screen says *nothing is wrong*, which is the one
      // conclusion a log viewer must never invite over an answer it never got.
      expect(element.querySelector('.stats')).toBeNull();
      expect(summary()).toBe('');
      // …and no foot either: an arrow or a "load more" over nothing would imply there is something
      // behind it, which is the same claim the deleted strip used to make in words.
      expect(foot()).toBe('');
      expect(text()).not.toContain(sr.logs.empty.none);
      expect(text()).not.toContain(sr.logs.empty.filtered);
      // What it says instead, once: nothing was loaded, and the notice above says why.
      expect(text()).toContain(sr.logs.unavailable);
      expect(text()).toContain(sr.platform.stale.title);
    });

    /**
     * The other half of the same rule: rows already on screen *are* an answer, so the strip that
     * counts them stays true and stays put when only the next page failed.
     */
    it('still counts the lines it holds when only the next page could not be fetched', async () => {
      await render(true, true);
      pageInto(FIRST_PAGE);
      await press(sr.logs.reload);

      gateway.logsError = platformHttpError(503);
      await press(sr.logs.more.action);

      expect(summary()).toContain(`Učitano ${FIRST_PAGE}`);
      expect(text()).toContain(sr.platform.stale.title);
      expect(text()).not.toContain(sr.logs.unavailable);
    });

    it('tells an empty stream apart from an empty filter', async () => {
      await render(true, true);
      await filterColumn(sr.logs.column.source, 'nothing-matches-this');

      expect(text()).toContain(sr.logs.empty.filtered);
      expect(text()).not.toContain(sr.logs.empty.none);
    });
  });

  // ---- Reachability ----------------------------------------------------------------------------

  /**
   * **A route can be registered, guarded correctly, fully tested — and unreachable.**
   *
   * That is what "the super admin pages aren't wired in" turned out to mean on 2026-09-01: three
   * individually correct guards and no door. So this asserts the journey rather than the
   * registration — a control on `/platform` is pressed, and the path it produces is resolved from
   * the shipped route table by component class, so a rename without its consumer is red here
   * rather than a wildcard redirect to Home.
   */
  describe('the way in', () => {
    it('is a control on the platform screen, pointing at the route the table really has', async () => {
      localStorage.clear();
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(STAFF));
      const logsUrl = await routeUrlFor(LogsPage);

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [
          PlatformPage,
          TranslocoTestingModule.forRoot({
            langs: { sr, en },
            translocoConfig: {
              availableLangs: ['sr', 'en'],
              defaultLang: 'sr',
              reRenderOnLangChange: true,
            },
            preloadLangs: true,
          }),
        ],
        providers: [
          provideRouter([]),
          { provide: PLATFORM_GATEWAY, useValue: new KnobbedPlatformGateway() },
          {
            provide: ViewportService,
            useValue: {
              atLeastMedium: () => true,
              expanded: () => true,
            } as unknown as ViewportService,
          },
        ],
      });

      const platform = TestBed.createComponent(PlatformPage);
      const router = TestBed.inject(Router);
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      for (let turn = 0; turn < 4; turn += 1) {
        platform.detectChanges();
        await platform.whenStable();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      platform.detectChanges();

      const host = platform.nativeElement as HTMLElement;
      const control = [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
        candidate.getAttribute('aria-label')?.includes(sr.platform.logs.open),
      );
      expect(control, 'no way into the log from the platform screen').toBeTruthy();

      control?.click();
      expect(navigate).toHaveBeenCalledWith([logsUrl]);
    });

    /**
     * And the guards let him through it, in combination.
     *
     * The real table, real order, real guards — `route-harness.ts` only swaps the lazy components
     * for an empty one. A guard put on the wrong route or the route pushed below the wildcard
     * shows up here as a navigation that lands somewhere else.
     */
    it('opens for Teren staff, and turns a customer’s admin away', async () => {
      const logsUrl = await routeUrlFor(LogsPage);

      // A customer's admin is bounced to `/login`, which — because he *is* signed in, just not as
      // staff — forwards him to his own surface by role rather than honouring `?next=`. Two
      // guards, one journey, and the destination is the second one's: honouring the return URL
      // there is the infinite redirect `requiresNoAdminSession` exists to refuse.
      for (const [session, expected] of [
        [STAFF, logsUrl],
        [{ ...STAFF, role: 'company_admin' as const, companyId: 'x' }, '/company'],
      ] as const) {
        localStorage.clear();
        localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(session));

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({ providers: [provideRouter(guardedRoutes())] });
        const harness = await RouterTestingHarness.create();
        const router = TestBed.inject(Router);

        await harness.navigateByUrl(logsUrl);
        expect(router.url.split('?')[0], `role ${session.role}`).toBe(expected);
      }
    });
  });

  // ---- Ten lines a page, over a stream whose end nobody knows -------------------------------------

  describe('paging', () => {
    /**
     * A day of the log long enough to page, handed to the mock rather than stubbed over it.
     *
     * **Newest first, ids descending**, exactly as the endpoint returns them — the mock's keyset
     * arithmetic is the thing under test here, and a fixture in another order would be describing a
     * server that does not exist. The messages are numbered so a page can be named exactly.
     */
    function stream(size: number): PlatformLogResponse[] {
      return Array.from({ length: size }, (_, index) => {
        const number = size - index;
        return {
          id: String(90000 + number),
          at: new Date(Date.UTC(2026, 8, 2, 12, 0, size - number)).toISOString(),
          level: 'Information',
          source: 'Teren.Api.Test.Stream',
          template: 'Line {Number}',
          message: `Linija ${String(number).padStart(3, '0')}`,
          properties: { Number: number },
          exception: null,
          company_id: null,
          entry_id: null,
          correlation: null,
        };
      });
    }

    function lines(): string[] {
      const selector = viewport.atLeastMedium()
        ? 'tbody tr.line .line__message'
        : '.line-item__message';
      return [...element.querySelectorAll(selector)].map((n) => n.textContent?.trim() ?? '');
    }

    /**
     * The page number under the foot row. `.pager__where`, not `.pager__position`: this screen's
     * pager is the `steps` shape, whose middle belongs to the "Učitaj još" button, so the position
     * sits on its own line beneath rather than between the arrows.
     */
    function position(): string {
      return element.querySelector('.pager__where')?.textContent?.trim() ?? '';
    }

    async function nextPage(): Promise<void> {
      const next = [...element.querySelectorAll<HTMLButtonElement>('.pager__step')].find(
        (candidate) => candidate.getAttribute('aria-label') === sr.table.pager.next,
      );
      if (!next) {
        throw new Error('no next-page control on screen');
      }
      next.click();
      await settle();
    }

    it('draws ten of the loaded lines at a time', async () => {
      await render(true, true, stream(30));

      expect(lines()).toHaveLength(10);
      expect(lines()[0]).toBe('Linija 030');
      expect(lines()[9]).toBe('Linija 021');
    });

    it('walks through the buffer without asking the server again', async () => {
      await render(true, true, stream(30));
      const asked = gateway.logQueries.length;

      await nextPage();

      expect(lines()[0]).toBe('Linija 020');
      expect(gateway.logQueries.length).toBe(asked);
    });

    /**
     * **The fifty and the ten meet here.**
     *
     * The stream is fetched in batches of fifty and read ten at a time, so four pages in five cost
     * nothing and the fifth fetches. Asking the server for ten would be five round trips per
     * screenful; paging fifty at a time would be a "load more" wearing a pager's clothes.
     */
    it('fetches the next batch when he walks off the end of what is loaded', async () => {
      await render(true, true, stream(120));
      expect(gateway.logQueries.at(-1)?.limit).toBe(50);

      for (let page = 0; page < 5; page += 1) {
        await nextPage();
      }

      expect(gateway.logQueries.at(-1)?.cursor).toBe('90071');
      expect(lines()[0]).toBe('Linija 070');
    });

    /**
     * **It never prints a total it does not know.**
     *
     * While a keyset cursor is outstanding the server has said *there is more behind this* and has
     * not said how much. "Strana 3" is a fact; "3 / 7" would be an invention, and this is the one
     * screen a founder opens precisely because he does not trust what he is being told.
     */
    it('says which page he is on, and never how many there are, while a cursor is live', async () => {
      await render(true, true, stream(120));

      expect(element.querySelectorAll('.pager__page')).toHaveLength(0);
      expect(position()).toBe('Strana 1');
      expect(position()).not.toContain('/');
    });

    /**
     * …and once the stream really has run out, the total **may** be named, because by then it is a
     * fact rather than a guess. The shape does not change — this screen's foot is two arrows around
     * a button at every width — only what the line beneath them is allowed to say.
     */
    it('may name the total once the server has said there is no more', async () => {
      await render(true, true, stream(30));

      expect(position()).toBe('1 / 3');
      expect(element.querySelectorAll('.pager__page')).toHaveLength(0);
    });

    /** A filter is a different question, and its answer starts at the top. */
    it('goes back to the first page when a filter changes', async () => {
      await render(true, true, stream(30));
      await nextPage();
      expect(lines()[0]).toBe('Linija 020');

      // A level every line in this fixture carries, so what changes is the *question* and not the
      // number of answers: page 1 of thirty lines, not page 1 of nothing.
      await press(sr.logs.level.information);

      expect(lines()[0]).toBe('Linija 030');
      expect(position()).toBe('1 / 3');
    });

    /**
     * **An expanded row that pages out of view takes its detail with it.**
     *
     * The detail is drawn by the same loop that draws the row, so this is structural rather than
     * remembered — and the set of open rows is pruned on every move, so it can never name a line
     * that is not on the glass.
     */
    it('leaves no detail behind when the row it belonged to pages away', async () => {
      await render(true, true, stream(30));

      (element.querySelector('tbody tr.line') as HTMLElement).click();
      await settle();
      expect(element.querySelectorAll('.detail')).toHaveLength(1);

      await nextPage();

      expect(element.querySelectorAll('.detail')).toHaveLength(0);

      // …and coming back does not resurrect it: the row is closed, not hidden.
      const previous = [...element.querySelectorAll<HTMLButtonElement>('.pager__step')].find(
        (candidate) => candidate.getAttribute('aria-label') === sr.table.pager.previous,
      );
      previous?.click();
      await settle();
      expect(element.querySelectorAll('.detail')).toHaveLength(0);
    });

    /** The summary goes on describing the **buffer**, which is the only thing this screen counts. */
    it('keeps counting what is loaded rather than what is on the page', async () => {
      await render(true, true, stream(30));

      expect(summary()).toContain('Učitano 30');
      expect(summary()).not.toMatch(/\bod\b/);
    });

    /**
     * **The count strip is gone, and with it three copy defects and their keys.**
     *
     * It duplicated the summary card's own number directly above the column heads, and the founder
     * had it removed off a 1920 screenshot (2026-09-02). `logs.count.*` went with it — an orphaned
     * key is a sentence nobody can see and nobody can fix — so what is pinned here is the absence,
     * because a strip is exactly the sort of thing that grows back by habit from the three other
     * tables that legitimately have one.
     */
    it('draws no count strip above the column heads at any width', async () => {
      for (const [medium, expanded] of [
        [true, true],
        [true, false],
        [false, false],
      ] as const) {
        await render(medium, expanded, stream(30));
        expect(element.querySelector('.table-bar')).toBeNull();
      }
    });

    /**
     * **One row at the foot: ‹ | Učitaj još | ›** (founder, 2026-09-02: *"have the pagination use
     * icons that are left/right from the load more button"*).
     *
     * The two used to stack as a "load more" row above a pager row above the table, which is what
     * he saw as "table overlaps down". The button is projected between the pager's own arrows, so
     * there is one row and one owner of the arrows — their disabled logic, their accessible names
     * and their 44 px targets are the same code the three other tables use.
     */
    it('flanks the load-more button with the two arrows, in one row', async () => {
      await render(true, true, stream(120));

      const row = element.querySelector('.pager__row');
      const inRow = [...(row?.children ?? [])].map((el) => el.className);
      expect(inRow).toHaveLength(3);
      expect(inRow[0]).toContain('pager__step');
      expect(inRow[1]).toContain('pager__slot');
      expect(inRow[2]).toContain('pager__step');
      expect(row?.querySelector('.pager__slot')?.textContent).toContain(sr.logs.more.action);

      // No second row of controls under it — that stacking is the whole complaint.
      expect(element.querySelector('.stream__more')).toBeNull();
      expect(element.querySelectorAll('.pager__row')).toHaveLength(1);
    });

    /**
     * **The reader's place stays visible.** Three pages into a stream with no number anywhere, and
     * no total to infer one from, he cannot tell where he is. It sits under the row rather than in
     * it, because the middle of that row belongs to the button.
     */
    it('keeps the page number under the row, and never a fraction it cannot know', async () => {
      await render(true, true, stream(120));
      expect(element.querySelector('.pager__where')?.textContent?.trim()).toBe('Strana 1');

      nextArrow()?.click();
      await settle();

      expect(element.querySelector('.pager__where')?.textContent?.trim()).toBe('Strana 2');
      expect(element.querySelector('.pager__where')?.textContent).not.toContain('/');
    });

    /** Six lines is one page: no foot at all, and the summary says so as it always did. */
    it('draws no pager over a stream that fits on one page', async () => {
      await render(true, true);

      expect(element.querySelector('.pager')).toBeNull();
      expect(summary()).toContain('Učitano 6');
    });
  });

  // ---- Every field the row actually holds --------------------------------------------------------

  describe('the detail', () => {
    /** The row's own number, which is what a founder quotes when he reports a line. */
    it('shows the line number, as the string it is on the wire', async () => {
      await render(true, true);

      (element.querySelector('tbody tr.line') as HTMLElement).click();
      await settle();

      const detail = element.querySelector('.detail')?.textContent ?? '';
      expect(detail).toContain(sr.logs.detail.id);
      expect(detail).toContain('80425');
    });

    /**
     * **The exact moment, with its offset and whose clock it is.**
     *
     * The table prints `d.M. HH:mm:ss` — no year, no zone — which is right for scanning a column
     * and useless for matching a line against a server console. And an offset with no owner is a
     * half-answer: the words say it is this device's clock, not the project's.
     */
    it('shows the full timestamp, and says which clock it is on', async () => {
      await render(true, true);

      (element.querySelector('tbody tr.line') as HTMLElement).click();
      await settle();

      const detail = element.querySelector('.detail')?.textContent ?? '';
      expect(detail).toContain(sr.logs.detail.at);
      expect(detail).toMatch(/2026/);
      expect(detail).toMatch(/GMT[+-]\d{2}:\d{2}/);
      expect(detail).toContain(sr.logs.detail.atZone);
    });

    /** The level as a value, not only as a colour: a chip is read as alarm rather than as a fact. */
    it('names the level in words', async () => {
      await render(true, true);

      (element.querySelector('tbody tr.line') as HTMLElement).click();
      await settle();

      const detail = element.querySelector('.detail')?.textContent ?? '';
      expect(detail).toContain(sr.logs.detail.level);
      expect(detail).toContain(sr.logs.level.information);
    });

    /** The phone gets exactly the same block — one template, so it cannot quietly lose a field. */
    it('shows the same fields on a phone', async () => {
      await render(false, false);

      (element.querySelector('.line-item__summary') as HTMLElement).click();
      await settle();

      const detail = element.querySelector('.detail')?.textContent ?? '';
      expect(detail).toContain(sr.logs.detail.id);
      expect(detail).toContain(sr.logs.detail.at);
      expect(detail).toContain(sr.logs.detail.level);
    });

    /**
     * At 1024 the row itself carries its number, because there is width for it and because a
     * founder should not have to open a line to be able to quote it.
     */
    it('puts the line number on the row itself once there is width for it', async () => {
      await render(true, false);
      expect(element.querySelector('.line__id')).toBeNull();

      await render(true, true);
      expect(element.querySelector('.line__id')?.textContent?.trim()).toBe('#80425');
    });
  });
});
