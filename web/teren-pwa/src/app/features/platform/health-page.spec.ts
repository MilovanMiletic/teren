import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { MockPlatformGateway } from '../../core/platform/mock-platform-gateway';
import { PLATFORM_GATEWAY } from '../../core/platform/platform-gateway';
import { PlatformHealthResponse } from '../../core/platform/platform-types';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import { KnobbedPlatformGateway, platformHttpError } from '../../testing/platform-gateway-double';
import { guardedRoutes } from '../../testing/route-harness';
import { routeUrlFor } from '../../testing/route-table';
import { TABLE_PAGE_SIZE } from '../../ui/table-controls';
import { ViewportService } from '../../ui/viewport.service';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { HealthPage } from './health-page';
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

/**
 * One site of an estate built for a spec, healthy unless the spec says otherwise.
 *
 * Deliberately a builder rather than a copy of the mock's three sites: the questions that matter
 * on this screen — does it page at ten, does it say what the server left out, does a filter narrow
 * loudly — need twelve or five hundred rows, and the mock is three legible ones on purpose.
 */
function site(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    company_id: MockPlatformGateway.VODOINSTAL_ID,
    company_name: 'Vodoinstal Petrović d.o.o.',
    project_id: 'p-1',
    project_name: 'Gradilište',
    pipeline: {
      entry_count: 4,
      received: 0,
      processing: 0,
      awaiting_confirmation: 0,
      needs_review: 0,
      confirmed: 0,
      reported: 4,
    },
    pipeline_failures: [],
    delivery: { report_count: 4, sending: 0, sent: 4, failed: 0 },
    delivery_failures: [],
    ...overrides,
  };
}

/** An estate of `count` healthy sites, each with a name a spec can name exactly. */
function sites(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) =>
    site({
      project_id: `p-${String(index + 1).padStart(3, '0')}`,
      project_name: `Gradilište ${String(index + 1).padStart(3, '0')}`,
    }),
  );
}

function estate(overrides: Partial<PlatformHealthResponse> = {}): PlatformHealthResponse {
  return {
    at: '2026-09-03T09:40:00.000Z',
    pipeline: {
      entry_count: 10,
      received: 0,
      processing: 0,
      awaiting_confirmation: 0,
      needs_review: 0,
      confirmed: 0,
      reported: 10,
    },
    pipeline_failures: [],
    delivery: { report_count: 10, sending: 0, sent: 10, failed: 0 },
    delivery_failures: [],
    queue: {
      available: true,
      detail: null,
      enqueued: 0,
      scheduled: 0,
      processing: 0,
      failed: 0,
      servers: 1,
    },
    sites: [],
    sites_omitted: 0,
    ...overrides,
  } as PlatformHealthResponse;
}

describe('HealthPage', () => {
  let fixture: ComponentFixture<HealthPage>;
  let element: HTMLElement;
  let gateway: KnobbedPlatformGateway;

  /** The device class decides what is rendered, so it is stubbed rather than measured. */
  let viewport = { atLeastMedium: () => true, expanded: () => true };

  /**
   * @param health an estate handed to the mock before the screen reads it. The gateway is minted
   *   here, so a spec that seeded one of its own before calling this would be seeding the instance
   *   the last spec threw away.
   */
  async function render(
    medium = true,
    expanded = true,
    health: PlatformHealthResponse | null = null,
  ): Promise<void> {
    localStorage.clear();
    localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(STAFF));

    gateway = new KnobbedPlatformGateway();
    if (health) {
      gateway.real.useHealth(health);
    }
    viewport = { atLeastMedium: () => medium, expanded: () => expanded };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        HealthPage,
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
      ],
    });

    fixture = TestBed.createComponent(HealthPage);
    element = fixture.nativeElement as HTMLElement;
    await settle();
  }

  /**
   * Drive change detection until the promise chains the screen started have all landed.
   *
   * `setTimeout(0)` inside the loop and not only microtasks: a macrotask turn is what a router
   * navigation and a real gateway promise need, and a settle that drained only the microtask queue
   * is how a negative assertion comes to prove nothing (the caution from 2026-09-03).
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 4; turn += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  }

  function text(): string {
    return (element.textContent ?? '').replace(/\s+/g, ' ');
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

  async function press(label: string): Promise<void> {
    button(label).click();
    await settle();
  }

  /** Every site name the screen is actually drawing, in the order it draws them. */
  function drawnSites(): string[] {
    return [...element.querySelectorAll('.site__name')].map(
      (node) => node.textContent?.trim() ?? '',
    );
  }

  /** The card a card's `aria-label` names, so a count is read out of the right block. */
  function block(label: string): HTMLElement {
    const found = element.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    if (!found) {
      throw new Error(`no block labelled "${label}"`);
    }
    return found;
  }

  /** The label/value pairs of one block's count grid, as `LABEL VALUE` strings. */
  function counts(label: string): string[] {
    return [...block(label).querySelectorAll('.counts__cell')].map((cell) =>
      [cell.querySelector('dt')?.textContent?.trim(), cell.querySelector('dd')?.textContent?.trim()]
        .join(' ')
        .replace(/\s+/g, ' '),
    );
  }

  /** One block's failure tallies, as `reason count`. */
  function tallies(label: string): string[] {
    return [...block(label).querySelectorAll('.tallies__row')].map((row) =>
      [
        row.querySelector('.tallies__reason')?.textContent?.trim(),
        row.querySelector('.tallies__count')?.textContent?.trim(),
      ].join(' '),
    );
  }

  /** Type into one column's filter box, through the control every table in the product uses. */
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
    await settle();
  }

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  // ---- The stamp, and the refusal to look live ------------------------------------------------

  /**
   * **The server's own moment, printed.**
   *
   * This is the screen an owner opens because he already doubts what he is told, so numbers that
   * looked live would be the one thing it must never do. The stamp is the server's `at` and not a
   * clock read on the device: "at 09:40" and "at 09:40 on whichever machine you are sitting at"
   * are different claims.
   */
  it('prints the moment the server counted, not a clock of its own', async () => {
    await render(true, true, estate({ at: '2026-09-03T09:40:00.000Z' }));

    expect(text()).toContain('Stanje na serveru u');
    // 09:40 UTC rendered in the runner's zone, so the assertion is on the minute and the seconds
    // rather than on an hour that moves with `TZ`.
    expect(text()).toMatch(/:40:00/);
    // …and not the screen's fallback subtitle, which is what a server that said nothing gets.
    expect(text()).not.toContain(sr.health.subtitle);
  });

  it('falls back to the subtitle rather than inventing a stamp', async () => {
    await render(true, true, estate({ at: null }));

    expect(text()).toContain(sr.health.subtitle);
    expect(text()).not.toContain('Stanje na serveru u');
  });

  // ---- "Nothing is queued" is not "I could not tell" ------------------------------------------

  /**
   * The gating find from `/platform/logs`, arrived at from the other end.
   *
   * There, a failed load printed *"Učitano 0 linija — to je sve"* beneath a notice saying the
   * server was unreachable. Here the same mistake would be five zeros under the word "red poslova"
   * — and an empty queue is the healthiest state the system has, while a reader that could not ask
   * is one of the worst. So the numbers become em-dashes and the screen says which of the two
   * fixed reasons applies.
   */
  it('draws an unreadable queue as unknown, never as an empty one', async () => {
    await render(
      true,
      true,
      estate({
        queue: {
          available: false,
          detail: 'not_configured',
          enqueued: 0,
          scheduled: 0,
          processing: 0,
          failed: 0,
          servers: 0,
        },
      }),
    );

    expect(text()).toContain(sr.health.queue.unknownTitle);
    expect(text()).toContain('Ovaj server ne vodi poslove');

    // Every one of the five is the em-dash the product uses for "not known", and not a zero.
    const values = [...block(sr.health.queue.title).querySelectorAll('.counts__value')].map(
      (node) => node.textContent?.trim(),
    );
    expect(values).toHaveLength(5);
    expect(values.every((value) => value === sr.platform.none)).toBe(true);
    expect(values).not.toContain('0');
  });

  /**
   * …and the opposite: an empty queue with a worker running is good news and reads as good news.
   *
   * The two states must not render alike, which is the whole point, so this is the other half of
   * the pair rather than a second happy-path spec.
   */
  it('draws an empty queue as zeros, and says nothing is wrong', async () => {
    await render(true, true, estate());

    const values = [...block(sr.health.queue.title).querySelectorAll('.counts__value')].map(
      (node) => node.textContent?.trim(),
    );
    expect(values).toEqual(['0', '0', '0', '0', '1']);
    expect(text()).not.toContain(sr.health.queue.unknownTitle);
    expect(text()).not.toContain(sr.health.queue.noServers.title);
  });

  /**
   * The third state, and the one that looks perfectly healthy from every other screen.
   *
   * `available: true` with `servers: 0` means the queue answered and nobody is emptying it: every
   * request still returns 200 while nothing is transcribed, extracted or sent. It is a **different
   * sentence** from "could not read the queue", because the remedy is different.
   */
  it('says so when the queue answered and no worker is running it', async () => {
    await render(
      true,
      true,
      estate({
        queue: {
          available: true,
          detail: null,
          enqueued: 7,
          scheduled: 0,
          processing: 0,
          failed: 0,
          servers: 0,
        },
      }),
    );

    expect(text()).toContain(sr.health.queue.noServers.title);
    // The numbers are real, because the queue really answered. Only the workers are zero.
    expect(counts(sr.health.queue.title)).toContain('U redu 7');
    expect(text()).not.toContain(sr.health.queue.unknownTitle);
  });

  // ---- The two failure lists overlap, and are never drawn as a partition ----------------------

  /**
   * **The reason a chart is banned on this screen, asserted rather than commented.**
   *
   * `entry.failure_reason` is written by the pipeline *and* by the report pass, and
   * `superseded_after_send` exists nowhere else at all — so one reason legitimately appears in both
   * tallies. The backend's own first cut folded entry reasons through the pipeline vocabulary
   * alone, reported every delivery failure as `unrecognised`, and hid `superseded_after_send`
   * entirely; drawing the two as parts of a whole would re-tell that lie in the UI.
   *
   * So: both lists carry `storage_unavailable`, both are drawn, the count in each is the count the
   * server sent, and the card says the overlap out loud instead of leaving a reader to deduce it.
   */
  it('draws one reason in both lists without reconciling them, and says why', async () => {
    await render(
      true,
      true,
      estate({
        pipeline_failures: [
          { reason: 'storage_unavailable', count: 2 },
          { reason: 'superseded_after_send', count: 1 },
        ],
        delivery_failures: [{ reason: 'storage_unavailable', count: 1 }],
      }),
    );

    expect(tallies(sr.health.pipeline.title)).toEqual([
      `${sr.health.reason.storageUnavailable} 2`,
      `${sr.health.reason.supersededAfterSend} 1`,
    ]);
    expect(tallies(sr.health.delivery.title)).toEqual([`${sr.health.reason.storageUnavailable} 1`]);

    // The overlap, in words, on the card that shows both counts of it.
    expect(text()).toContain('ne sabirajte ih');
  });

  /**
   * And nothing anywhere adds the two together.
   *
   * The headline "carrying a failure" number is a sum **within one list**, which is legitimate:
   * `pipeline_failures` partitions the entries that carry a reason. Adding the delivery total to
   * it would double-count the very overlap above — 3 + 1 = 4 against an estate of 3.
   */
  it('never sums the two failure lists into one number', async () => {
    await render(
      true,
      true,
      estate({
        pipeline_failures: [
          { reason: 'storage_unavailable', count: 2 },
          { reason: 'superseded_after_send', count: 1 },
        ],
        delivery_failures: [{ reason: 'storage_unavailable', count: 1 }],
      }),
    );

    const failing = [...element.querySelectorAll('.stats__cell')]
      .map((cell) => ({
        label: cell.querySelector('dt')?.textContent?.trim(),
        value: cell.querySelector('dd')?.textContent?.trim(),
      }))
      .find((cell) => cell.label === sr.health.summary.failing);

    expect(failing?.value).toBe('3');
  });

  /**
   * A code this build has never heard of prints **as itself**.
   *
   * The vocabulary lives in `src/Teren.Core/` and no compiler joins it to this screen, so a newer
   * server can name a failure this one cannot translate. The two wrong answers are a raw
   * translation key on the glass and — far worse — a dropped row, which under-reports failures on
   * the one screen whose job is saying what is wrong.
   */
  it('prints an unknown failure code as itself rather than dropping it', async () => {
    await render(
      true,
      true,
      estate({ pipeline_failures: [{ reason: 'a_code_from_next_year', count: 4 }] }),
    );

    expect(tallies(sr.health.pipeline.title)).toEqual(['a_code_from_next_year 4']);
    expect(text()).not.toContain('health.reason.');
  });

  /** …and the server's own token for a code *it* does not declare gets a sentence. */
  it('names the server’s own unrecognised token', async () => {
    await render(true, true, estate({ pipeline_failures: [{ reason: 'unrecognised', count: 2 }] }));

    expect(tallies(sr.health.pipeline.title)).toEqual([`${sr.health.reason.unrecognised} 2`]);
  });

  /**
   * **…and that sentence blames nobody, which is the point of it.**
   *
   * It read *"Razlog koji ova verzija aplikacije ne poznaje"* — a reason this version of the app
   * does not know. True of one of the two cases the token covers and false of the commoner one:
   * the **server** answers with the literal `unrecognised` for a code its own vocabulary does not
   * declare, and no build of this app could have known it. A screen that blames the wrong end
   * sends a founder to update a phone when what wants looking at is a deployment (review,
   * 2026-09-04).
   */
  it('does not blame the app for a code the server is what did not recognise', async () => {
    await render(true, true, estate({ pipeline_failures: [{ reason: 'unrecognised', count: 2 }] }));

    expect(text(), 'the sentence still points at the app').not.toContain('aplikacije');
    expect(sr.health.reason.unrecognised).not.toContain('aplikacij');
    expect(en.health.reason.unrecognised.toLowerCase()).not.toContain('app');
  });

  /** A tally of zero is not a fact anybody needs a row for; the narrowing drops it. */
  it('drops a tally of nothing', async () => {
    await render(
      true,
      true,
      estate({
        pipeline_failures: [
          { reason: 'render_failed', count: 0 },
          { reason: 'render_timeout', count: 1 },
        ],
      }),
    );

    expect(tallies(sr.health.pipeline.title)).toEqual([`${sr.health.reason.renderTimeout} 1`]);
  });

  // ---- Truncation is announced ----------------------------------------------------------------

  /**
   * **`sites_omitted` is said in words the moment it is non-zero.**
   *
   * The cap is only safe because of the ordering — the server puts sites needing attention first,
   * so what is dropped is always healthy — and that guarantee is worth nothing if the screen does
   * not admit the truncation happened. A table quietly showing some of the rows is the defect
   * F11's "Prikazano 1 od 12" strip exists to prevent, arrived at from the server's end.
   */
  it('says when the server did not send the whole estate', async () => {
    await render(true, true, estate({ sites: sites(3), sites_omitted: 497 }));

    expect(text()).toContain('Server je poslao 3 od 500 gradilišta');
    // …and *why* it is safe, not only that it happened.
    expect(text()).toContain('prvo stavlja ona kojima nešto treba');
  });

  it('stays quiet when the estate is whole', async () => {
    await render(true, true, estate({ sites: sites(3), sites_omitted: 0 }));

    expect(text()).not.toContain('Server je poslao');
  });

  /**
   * **One card, one "Prikazano".**
   *
   * The notice and the count strip live in the same card and both used to open with *"Prikazano
   * X od Y"* — the server's cap and the page's slice, two different arithmetics wearing one
   * sentence, stacked. A reader comparing "Prikazano 3 od 500" with "Prikazano 3 od 3" two lines
   * below has been given a contradiction to resolve on the screen he came to for the truth. The
   * server's line says what the *server* did; the strip keeps the count vocabulary every other
   * table in the product uses.
   */
  it('prints the count vocabulary once in the sites card', async () => {
    // Twelve sites, so the strip is in its paging form — which is the state a truncated estate is
    // always in, the cap being 500. Three sites would put "Ukupno 3" there instead and the two
    // sentences would never have met, which is what made a laxer version of this spec vacuous.
    await render(true, true, estate({ sites: sites(12), sites_omitted: 497 }));

    const card = element.querySelector('.sites');
    expect(card?.textContent, 'the paging strip is not in its range form').toContain(
      `Prikazano 1–${TABLE_PAGE_SIZE} od 12`,
    );
    const said = (card?.textContent ?? '').match(/Prikazano/g) ?? [];
    expect(said.length, 'two "Prikazano" totals in one card').toBe(1);
    expect(card?.textContent).toContain('Server je poslao 12 od 509 gradilišta');
  });

  // ---- There is no answer at all --------------------------------------------------------------

  /**
   * A read that failed leaves the previous numbers **off** the screen.
   *
   * The archive keeps its rows behind a staleness notice, and that is right there and wrong here:
   * five-minute-old counts standing under "the server could not be reached" is precisely the
   * screen an owner would be right to stop believing.
   */
  it('shows no numbers at all when the read failed', async () => {
    await render(true, true, estate({ sites: sites(3) }));
    expect(element.querySelector('.stats')).not.toBeNull();

    gateway.healthError = platformHttpError(503);
    await press(sr.health.reload);

    expect(text()).toContain(sr.platform.stale.title);
    expect(text()).toContain(sr.health.unavailable);
    expect(element.querySelector('.stats')).toBeNull();
    expect(element.querySelector('.sites')).toBeNull();
    expect(drawnSites()).toEqual([]);
  });

  /**
   * A `200` whose body this build cannot read is the same answer as a refusal — never an estate of
   * zeroes.
   *
   * No error path reaches this branch: a thrown `HttpErrorResponse` is classified, an unreadable
   * body is not. "There is nothing wrong anywhere" and "I could not find out" are opposite claims,
   * and this is the screen that exists because somebody already doubts the first one.
   */
  it('refuses to read an unreadable body as a healthy estate', async () => {
    await render();
    gateway.unreadableHealth = true;
    await press(sr.health.reload);

    expect(text()).toContain(sr.health.unavailable);
    expect(element.querySelector('.stats')).toBeNull();
    // Not "zero days, nothing failing" — which is the most reassuring possible rendering of a
    // payload nobody could read.
    expect(text()).not.toContain(sr.health.summary.days);
  });

  /**
   * **An older answer must not overwrite a newer question** (`ui/latest-request.ts`).
   *
   * This screen has a `loading` flag and had no generation guard, so a reload pressed twice could
   * end with the slower failure landing after the faster success — the numbers stripped off the
   * screen and *"Nije provereno na serveru"* over them, on the one screen whose whole job is
   * saying what is wrong. The founder's own gesture: press refresh, nothing happens fast enough,
   * press it again.
   */
  it('ignores a failed reading that lands after a good one', async () => {
    await render(true, true, estate({ sites: sites(3) }));

    let call = 0;
    let release = (): void => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(gateway, 'getHealth').mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        await slow;
        throw platformHttpError(503);
      }
      return gateway.real.getHealth();
    });

    button(sr.health.reload).click();
    await settle();
    button(sr.health.reload).click();
    await settle();
    expect(element.querySelector('.stats')).not.toBeNull();

    release();
    await settle();

    expect(text(), 'a stale failure painted "not confirmed" over numbers that were').not.toContain(
      sr.platform.stale.title,
    );
    expect(
      element.querySelector('.stats'),
      'the numbers were stripped by a stale answer',
    ).not.toBeNull();
    expect(text()).not.toContain(sr.health.unavailable);
  });

  /** A reload really asks the server again; a repaint is not a reading. */
  it('re-reads the estate on refresh', async () => {
    await render();
    expect(gateway.healthReadings).toBe(1);

    await press(sr.health.reload);
    expect(gateway.healthReadings).toBe(2);
  });

  // ---- Three deliberate layouts ---------------------------------------------------------------

  /**
   * At 1024 and up the sites are a real `<table>`; below it they are a list.
   *
   * Decided in TypeScript and not by `display: none`: a `<table>` whose cells are forced to
   * `display: block` loses its table role in every browser, so the markup itself changes.
   */
  it('draws a real table at expanded width', async () => {
    await render(true, true, estate({ sites: sites(3) }));

    const table = element.querySelector('table.data-table');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('thead th')).toHaveLength(5);
    expect(element.querySelector('ul.rows')).toBeNull();
    expect(drawnSites()).toHaveLength(3);
  });

  /**
   * **Medium is a list, not a squeezed table** — and this is the class that had never been pinned.
   *
   * Every table spec in this product passed `render(true, true)`, so all of them were really
   * testing expanded. The mistake `/platform/logs` was corrected for at 834 is exactly this: five
   * columns on a 640 column give the one useful column about 300 px and spend the rest repeating
   * near-constant text.
   */
  it('draws a list and no table at medium', async () => {
    await render(true, false, estate({ sites: sites(3) }));

    expect(element.querySelector('table')).toBeNull();
    expect(element.querySelector('ul.rows')).not.toBeNull();
    expect(drawnSites()).toHaveLength(3);
    // The pill bar carries the same controls the column heads would have.
    expect(element.querySelector('.column-bar')).not.toBeNull();
  });

  it('draws a list and no table on a phone', async () => {
    await render(false, false, estate({ sites: sites(3) }));

    expect(element.querySelector('table')).toBeNull();
    expect(element.querySelector('ul.rows')).not.toBeNull();
    // The screen's own bar, because the app header is `display: none` below 768 and a founder must
    // still be able to change language and end a password-backed session.
    expect(element.querySelector('.bar--compact')).not.toBeNull();
  });

  // ---- Ten rows a page, clamped on every read -------------------------------------------------

  /** The product's number, not this screen's. */
  it('pages at the product’s page size', async () => {
    await render(true, true, estate({ sites: sites(TABLE_PAGE_SIZE + 2) }));

    expect(drawnSites()).toHaveLength(TABLE_PAGE_SIZE);
    expect(text()).toContain(`Prikazano 1–${TABLE_PAGE_SIZE} od 12`);
  });

  it('shows the rest on the second page, and the same rows in both renderings', async () => {
    const estateOf12 = estate({ sites: sites(12) });

    await render(true, true, estateOf12);
    const firstTable = drawnSites();
    await press(sr.table.pager.next);
    const secondTable = drawnSites();

    expect(secondTable).toHaveLength(2);
    expect(firstTable.some((name) => secondTable.includes(name))).toBe(false);

    // The list below 1024 is the *same* list: one control for both renderings, because two pagers
    // would be two places for the page to drift.
    await render(true, false, estateOf12);
    expect(drawnSites()).toEqual(firstTable);
  });

  /**
   * **The clamp is applied on every read, not on the events somebody remembered.**
   *
   * Stand on page 2, let a reload answer with three sites, and the screen must show those three —
   * not an empty table under "page 2 of 1". A filter, a sort, a reload and a shrinking list are
   * four paths and there will be a fifth, which is why the arithmetic lives behind
   * `TableControls.pageOn`/`slice` rather than in a handler here.
   */
  it('never draws an empty page when the estate shrinks under the reader', async () => {
    await render(true, true, estate({ sites: sites(12) }));
    await press(sr.table.pager.next);
    expect(drawnSites()).toHaveLength(2);

    gateway.real.useHealth(estate({ sites: sites(3) }));
    await press(sr.health.reload);

    expect(drawnSites()).toHaveLength(3);
    expect(text()).toContain('Ukupno 3');
  });

  /**
   * A live filter is loud, and the count comes back with one tap.
   *
   * A table quietly showing one of twelve rows is how this screen would make a founder believe a
   * customer has no problems.
   */
  it('narrows loudly on a filter, and says how to get back', async () => {
    await render(true, true, estate({ sites: sites(12) }));

    await filterColumn(sr.health.sites.site, 'Gradilište 007');

    expect(drawnSites()).toEqual(['Gradilište 007']);
    expect(text()).toContain('Prikazano 1 od 12');
    expect(element.querySelector('.table-bar--quiet')).toBeNull();

    await press(sr.table.filter.clearAll);
    expect(drawnSites()).toHaveLength(TABLE_PAGE_SIZE);
  });

  /** No sites at all, and none that answer the filter, are two different sentences. */
  it('tells an empty estate from an empty filter', async () => {
    await render(true, true, estate({ sites: [] }));
    expect(text()).toContain(sr.health.sites.empty);

    await render(true, true, estate({ sites: sites(3) }));
    await filterColumn(sr.health.sites.site, 'nema takvog');
    expect(text()).toContain(sr.table.filter.empty);
    expect(text()).not.toContain(sr.health.sites.empty);
  });

  /**
   * **The drawn order is the order that is sliced.**
   *
   * The gating find on `/platform`: it sliced the flat sort and *then* regrouped into bands, so
   * seventeen accounts under the default sort put no `Teren tim` band on page 1 at all. This screen
   * has no bands, and the property that must hold is the same one — the ten rows on screen are the
   * first ten of the list the reader is reading, in that order.
   */
  it('slices the order it draws', async () => {
    // Attention-first is the default sort, so the two troubled sites must be the first two rows —
    // and therefore on page one — even though the server sent them last.
    const troubled = [
      site({
        project_id: 'p-bad-1',
        project_name: 'Problem jedan',
        pipeline: {
          entry_count: 3,
          received: 0,
          processing: 0,
          awaiting_confirmation: 0,
          needs_review: 3,
          confirmed: 0,
          reported: 0,
        },
      }),
      site({
        project_id: 'p-bad-2',
        project_name: 'Problem dva',
        delivery: { report_count: 3, sending: 0, sent: 1, failed: 2 },
      }),
    ];

    await render(true, true, estate({ sites: [...sites(12), ...troubled] }));

    const drawn = drawnSites();
    expect(drawn).toHaveLength(TABLE_PAGE_SIZE);
    expect(drawn.slice(0, 2)).toEqual(['Problem jedan', 'Problem dva']);
  });

  // ---- What a row says about itself -----------------------------------------------------------

  /**
   * Every condition gets its own chip rather than one worst-state word, because the founder's next
   * action differs per condition: a handed-back day is a phone call to a foreman, a failed report
   * is a look at the log.
   */
  it('names every condition a site is in, not just the worst one', async () => {
    await render(
      true,
      true,
      estate({
        sites: [
          site({
            project_name: 'Sve odjednom',
            pipeline: {
              entry_count: 9,
              received: 0,
              processing: 0,
              awaiting_confirmation: 0,
              needs_review: 2,
              confirmed: 0,
              reported: 7,
            },
            pipeline_failures: [{ reason: 'extraction_failed', count: 3 }],
            delivery: { report_count: 7, sending: 1, sent: 5, failed: 1 },
          }),
        ],
      }),
    );

    const chips = [...element.querySelectorAll('.site__chips .chip')].map((c) =>
      c.textContent?.trim(),
    );
    expect(chips).toEqual(['2 vraćeno', '3 sa greškom', '1 nije poslato', '1 u slanju']);
  });

  /**
   * The two plain states, which must not read as problems.
   *
   * A site that has recorded nothing is a real and common state — two of the three demo sites are
   * in it — and a site with days and nothing wrong is the answer this screen exists to be able to
   * give. Neither may borrow a warning tone.
   */
  it('tells a site with nothing wrong from a site with nothing on it', async () => {
    await render(
      true,
      true,
      estate({
        sites: [
          site({ project_id: 'p-ok', project_name: 'Uredan' }),
          site({
            project_id: 'p-new',
            project_name: 'Nov',
            pipeline: {
              entry_count: 0,
              received: 0,
              processing: 0,
              awaiting_confirmation: 0,
              needs_review: 0,
              confirmed: 0,
              reported: 0,
            },
            delivery: { report_count: 0, sending: 0, sent: 0, failed: 0 },
          }),
        ],
      }),
    );

    const byName = new Map(
      [...element.querySelectorAll('tr.site')].map((row) => [
        row.querySelector('.site__name')?.textContent?.trim(),
        row.querySelector('.chip')!,
      ]),
    );

    expect(byName.get('Uredan')?.textContent?.trim()).toBe(sr.health.site.ok);
    expect(byName.get('Uredan')?.className).toContain('chip--ok');
    expect(byName.get('Nov')?.textContent?.trim()).toBe(sr.health.site.empty);
    expect(byName.get('Nov')?.className).toContain('chip--neutral');
  });

  /** A row with no customer name and no site name is a line of numbers nobody can act on. */
  it('drops a site the server did not name', async () => {
    await render(
      true,
      true,
      estate({
        sites: [site({ project_name: null }), site({ project_id: 'p-ok', project_name: 'Uredan' })],
      }),
    );

    expect(drawnSites()).toEqual(['Uredan']);
    // …and the count strip counts what it drew, so the screen cannot claim two.
    expect(text()).toContain('Ukupno 1');
  });

  // ---- The way in, and the guards that stand at it --------------------------------------------

  describe('reachability', () => {
    /**
     * **A route can be registered, guarded correctly, fully tested and unreachable.**
     *
     * That is what "the super admin pages aren't wired in" turned out to mean on 2026-09-01, and
     * the defect lived entirely in the combination of three individually correct guards. This
     * screen is the one on the surface with no other producer — no email links to it and no
     * notification opens it — so the door is pressed here and followed through the real route
     * table rather than asserted as a path.
     */
    it('is reachable from the platform screen', async () => {
      const healthUrl = await routeUrlFor(HealthPage);

      localStorage.clear();
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(STAFF));

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
        candidate.getAttribute('aria-label')?.includes(sr.platform.health.open),
      );
      expect(control, 'no way into the health screen from the platform screen').toBeTruthy();
      // **A door nobody can see is not a door**, and this assertion is here because the first cut
      // of this spec did not have it: adding `hidden` to that button left all thirty specs green,
      // and only deleting it outright failed. `hidden` and `display: none` are the two ways a
      // control stays in the DOM and out of reach; jsdom lays nothing out, so `offsetParent` is
      // useless here and the property is what can be checked.
      expect(control?.hidden, 'the door is in the DOM but hidden').toBe(false);
      expect(
        control?.getAttribute('style') ?? '',
        'the door is in the DOM but styled away',
      ).not.toContain('display: none');

      control?.click();
      expect(navigate).toHaveBeenCalledWith([healthUrl]);
    });

    /**
     * And the guards let staff through it while turning a customer's admin away.
     *
     * The sharpest gate on this surface: one response carries **every customer's** company name,
     * site names and failure counts, so a company admin allowed through would learn which of his
     * competitors is behind on his reports. Real table, real order, real guards —
     * `route-harness.ts` only swaps the lazy components for an empty one.
     */
    it('opens for Teren staff, and turns a customer’s admin away', async () => {
      const healthUrl = await routeUrlFor(HealthPage);

      for (const [session, expected] of [
        [STAFF, healthUrl],
        [{ ...STAFF, role: 'company_admin' as const, companyId: 'x' }, '/company'],
      ] as const) {
        localStorage.clear();
        localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(session));

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({ providers: [provideRouter(guardedRoutes())] });
        const harness = await RouterTestingHarness.create();
        const router = TestBed.inject(Router);

        await harness.navigateByUrl(healthUrl);
        expect(router.url.split('?')[0], `role ${session.role}`).toBe(expected);
      }
    });

    /** …and the way back, so the screen is not a dead end. */
    it('goes back to the platform screen', async () => {
      await render();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      await press(sr.health.back);
      expect(navigate).toHaveBeenCalledWith(['/platform']);
    });
  });
});
