import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { COMPANY_GATEWAY } from '../../core/company/company-gateway';
import { MockCompanyGateway } from '../../core/company/mock-company-gateway';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import { KnobbedGateway, httpError } from '../../testing/company-gateway-double';
import { routePathFor, routeUrlFor } from '../../testing/route-table';
import { ViewportService } from '../../ui/viewport.service';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { AccountPage } from './account-page';
import { CompanyPage } from './company-page';
import { WorkerPage } from './worker-page';

/** A signed-in company admin, as `POST /auth/login` left him in this browser. */
const ADMIN: AdminSession = {
  token: 'trn_s_a-real-admin-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'company_admin',
  userId: '99999999-9999-9999-9999-999999999999',
  displayName: 'Milan Gradnja',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Vodoinstal Petrović d.o.o.',
  signedInAt: '2026-08-31T08:00:00.000Z',
};

describe('CompanyPage', () => {
  let fixture: ComponentFixture<CompanyPage>;
  let element: HTMLElement;
  let router: Router;
  let gateway: KnobbedGateway;

  /** Stubbed the way `archive-page.spec.ts` stubs it: the device class decides what is rendered. */
  const viewport = { atLeastMedium: () => true, expanded: () => true };

  /**
   * The worker route's own base, resolved from the shipped table by the component class.
   *
   * Never spelled out. `company/worker/:workerId` renamed without this call site is precisely the
   * F4b defect — a navigation that builds clean, type-checks, and drops an admin on Home through
   * the wildcard.
   */
  let workerBase: string;

  /** The owner's own account, resolved the same way and for the same reason. */
  let accountUrl: string;

  beforeAll(async () => {
    accountUrl = await routeUrlFor(AccountPage);
    const path = await routePathFor(WorkerPage);
    workerBase = `/${path.replace(/\/:[A-Za-z0-9_]+$/, '')}`;
  });

  /**
   * Boot the screen against the knobbed backend.
   *
   * The **real** `CompanyService` and the **real** `AdminSessionService` are used, seeded through
   * `localStorage`: the narrowing between a wire response and a row on the glass, and the "is
   * anybody signed in" question that decides whether a request is sent at all, are both part of
   * what this screen has to get right.
   */
  async function render(signedIn = true): Promise<void> {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(ADMIN));
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        CompanyPage,
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
        { provide: COMPANY_GATEWAY, useValue: gateway },
        { provide: ViewportService, useValue: viewport as unknown as ViewportService },
      ],
    });

    fixture = TestBed.createComponent(CompanyPage);
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await settle();
  }

  /**
   * Drive change detection until the promise chains the screen started have all landed.
   *
   * The macrotask yield is what makes this reliable rather than lucky: the app is zoneless, so
   * `whenStable()` knows nothing about an un-tracked `void this.load()`.
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
    return element.textContent ?? '';
  }

  function buttons(): HTMLButtonElement[] {
    return [...element.querySelectorAll<HTMLButtonElement>('button')];
  }

  /**
   * A button by what it says — its label **or its accessible name**.
   *
   * The head row's three controls are icons now (founder, 2026-09-01), so their only name is the
   * `aria-label`. A spec that could not see them would be a spec that stopped covering the way an
   * owner adds a foreman, and it would have gone green while doing it.
   */
  function button(label: string): HTMLButtonElement {
    const found = buttons().find(
      (candidate) =>
        candidate.textContent?.includes(label) ||
        candidate.getAttribute('aria-label')?.includes(label),
    );
    if (!found) {
      throw new Error(
        `no button reading "${label}" on screen; there are: ` +
          buttons()
            .map(
              (candidate) =>
                `"${candidate.textContent?.trim() || candidate.getAttribute('aria-label')}"`,
            )
            .join(', '),
      );
    }
    return found;
  }

  async function press(label: string): Promise<void> {
    button(label).click();
    await settle();
  }

  /**
   * Type into one column's filter box, through the control an owner actually uses: open the
   * column's menu from its funnel, then type.
   *
   * Deliberately not a call to `setFilter` on the component. What is under test is the path from a
   * key press on the glass to a row leaving the list, and a spec that reaches past the control
   * would stay green with the funnel unwired — which is exactly the class of defect that shipped a
   * screen nobody could navigate in `ee37f04`.
   */
  async function filterBy(column: string, value: string): Promise<void> {
    const funnel = buttons().find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith(`Kolona ${column}`),
    );
    if (!funnel) {
      throw new Error(`no column control for "${column}"`);
    }
    funnel.click();
    await settle();

    const box = element.querySelector<HTMLInputElement>('.menu__input');
    if (!box) {
      throw new Error(`the "${column}" column offers no filter box`);
    }
    box.value = value;
    box.dispatchEvent(new Event('input'));
    await settle();
  }

  /** The group bands the table is drawing, as a screen reader would read them out. */
  function groupBands(): string[] {
    return [...element.querySelectorAll('tbody th[scope="rowgroup"], .list__group')].map(
      (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
  }

  /** The people in the order the screen lists them, whichever rendering is on. */
  /**
   * The **foremen**, in the order the list is drawing them.
   *
   * `:not(.person--you)` is not tidying. The owner's own row became openable on 2026-09-01 and so
   * gained the same classes a foreman's row wears; without the exclusion every sorting assertion
   * here would be asserting on a list with the reader wedged at the top of it, and the sort under
   * test would look broken while working perfectly.
   */
  function listedNames(): string[] {
    const rows = viewport.atLeastMedium()
      ? element.querySelectorAll('tbody tr.person--open:not(.person--you) .person__name')
      : element.querySelectorAll('.row-button:not(.row--you) .person__name');
    return [...rows].map((node) => node.textContent?.trim() ?? '');
  }

  async function type(selector: string, value: string): Promise<void> {
    const input = element.querySelector<HTMLInputElement>(selector);
    if (!input) {
      throw new Error(`no input matching ${selector}`);
    }
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    gateway = new KnobbedGateway();
    viewport.atLeastMedium = () => true;
    viewport.expanded = () => true;
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ---- Reading the office --------------------------------------------------------------------

  describe('loading', () => {
    it('resolves the loading state into the company’s people, by role', async () => {
      await render();

      expect(text()).not.toContain('Učitavanje radnika…');
      // The owner group is the session in this browser, marked as his own row. The heading is
      // `profile.role.company_admin` — one role, one name across the app (founder, 2026-09-01).
      expect(text()).toContain('Vlasnik firme');
      expect(text()).toContain('Milan Gradnja');
      expect(text()).toContain('vi');
      // And his foremen, with the chips that decide what he does next.
      expect(text()).toContain('Poslovođe');
      expect(text()).toContain('Zoran Jovanović');
      expect(text()).toContain('zoran.jovanovic');
      expect(text()).toContain('Marko Marković');
      expect(text()).toContain('Telefon aktivan');
      expect(text()).toContain('Nema telefon');
      expect(text()).toContain('Kod ga čeka');
    });

    it('renders Serbian by default — this is the owner’s own office', async () => {
      await render();

      expect(text()).toContain('Firma');
      expect(text()).toContain('Poslovođe');
      expect(text()).not.toContain('Foremen');
    });

    /**
     * The three numbers, and the third one is the point: it counts the men a code is waiting for
     * without the screen ever holding a code.
     */
    it('counts his men, the phones that can still record, and the codes that are waiting', async () => {
      await render();

      const values = [...element.querySelectorAll('.stats__value')].map((n) =>
        n.textContent?.trim(),
      );
      expect(values).toEqual(['2', '1', '1']);
      // Summed from the workers' own device counts: this screen does not read the device list.
      expect(gateway.deviceListings).toBe(0);
    });

    it('is honest about a man who has never called home', async () => {
      await render();

      // Marko's `last_seen_at` is null on the wire, and null is a word here, never a blank.
      expect(text()).toContain('Nikad');
    });

    it('names the company, and the man whose session the way out would end', async () => {
      await render();

      expect(text()).toContain('Vodoinstal Petrović d.o.o.');
      expect(element.querySelector<HTMLButtonElement>('.session')?.getAttribute('aria-label')).toBe(
        'Odjavi se — Milan Gradnja',
      );
    });

    /**
     * The constraint that decides where the session control may live.
     *
     * The app header is `display: none` below 768, and decision 9 puts this screen on every device
     * — so an admin doing the rounds on his phone can reach `/company`. A header-only sign-out
     * would strand him there with no way to end a password-backed session on the device most
     * likely to be lost. The screen therefore carries it twice, in the two pieces of chrome that
     * are never both visible.
     */
    it('keeps a way out on a phone, where the header does not exist', async () => {
      await render();

      expect(element.querySelectorAll('.session').length).toBe(2);
      expect(element.querySelector('.bar--compact app-session-link')).not.toBeNull();
      expect(element.querySelector('app-header app-session-link')).not.toBeNull();
    });

    /**
     * A list of men that is short because a request failed and a list that is short because the
     * company is small look identical unless one of them says which it is. This screen must say.
     */
    it('renders a sentence rather than an empty screen when the company could not be read', async () => {
      gateway.workersError = httpError(500);
      await render();

      expect(text()).toContain('Nije provereno na serveru');
      expect(text()).toContain('Server trenutno ne odgovara.');
      expect(text()).not.toContain('Dodajte prvog i dajte mu kod.');
    });

    /**
     * 401 and 403 are the split `CompanyStatus` exists for. Signing in again fixes one and cannot
     * fix the other, and offering the wrong remedy is a screen lying about what it knows.
     */
    it('tells an expired sign-in from a role that may not do this', async () => {
      gateway.workersError = httpError(401);
      await render();
      expect(text()).toContain('Server više ne prihvata ovu prijavu.');

      gateway = new KnobbedGateway();
      gateway.workersError = httpError(403);
      await render();
      expect(text()).toContain('Ovaj nalog to ne sme.');
      expect(text()).not.toContain('Server više ne prihvata ovu prijavu.');
    });

    it('says there is no internet rather than that the company is empty', async () => {
      gateway.workersError = httpError(0);
      await render();

      expect(text()).toContain('Nema interneta, pa ništa nije moglo da se proveri na serveru.');
    });

    it('sends nothing at all when this browser holds no admin credential', async () => {
      await render(false);

      expect(text()).toContain('Niste prijavljeni, pa ništa nije moglo da se pročita.');
      expect(gateway.workerListings).toBe(0);
    });

    it('reloads the list on demand, and spends nothing doing it', async () => {
      await render();
      expect(gateway.workerListings).toBe(1);

      element.querySelector<HTMLButtonElement>('.head__reload')?.click();
      await settle();

      expect(gateway.workerListings).toBe(2);
      expect(text()).toContain('Zoran Jovanović');
      // Refreshing is a read of the office, never a mint or a revoke.
      expect(gateway.issues).toEqual([]);
      expect(gateway.revokes).toEqual([]);
    });
  });

  // ---- Decision 13: no code may exist on this screen -----------------------------------------

  describe('codes are not on this screen at all', () => {
    /**
     * **Hard rule 1, as a property of the running screen.**
     *
     * A code plus a username activates a phone, so a message carrying several names and codes
     * pasted into a site group chat lets any man in that chat record evidence signed with another
     * man's name. The old office kept one code on screen at a time by arithmetic; this one cannot
     * hold a code at all — it never even asks for one.
     */
    it('never reads, shows or copies a code', async () => {
      await render();

      expect(gateway.reads).toEqual([]);
      expect(gateway.issues).toEqual([]);
      expect(element.querySelector('[data-code]')).toBeNull();
      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(buttons().some((b) => /kopiraj|copy|podeli|share/i.test(b.textContent ?? ''))).toBe(
        false,
      );
      // …and there is no bulk export anywhere, which is the whole point of decision 13.
      expect(buttons().some((b) => /svi|sve kod/i.test(b.textContent ?? ''))).toBe(false);
    });

    it('shows only *that* a code is waiting, which is a boolean', async () => {
      await render();

      const row = [...element.querySelectorAll('tr.person--open')].find((candidate) =>
        candidate.textContent?.includes('Zoran'),
      );
      expect(row?.textContent).toContain('Kod ga čeka');
      expect(row?.textContent).not.toContain(MockCompanyGateway.LIVE_CODE);
    });

    /**
     * The structural half of the same rule, asserted against the shipped source rather than the DOM
     * — because what is being ruled out is a *future* edit. A screen that cannot reach the code
     * endpoints cannot be made to leak a code by a well-meaning patch, and moving codes to a
     * per-worker route is what bought that.
     */
    it('holds no code path to a code, or to the clipboard', () => {
      // `people.ts` is in the list because the list imports it: the chips and the sort live there,
      // and a code reaching the glass through a helper is a code reaching the glass. The two shared
      // `ui/` components joined it when the rail became a popover and a dialog — two new surfaces,
      // and the whole point of decision 13 is that *no* surface may carry a code.
      const source = [
        ...['company-page.ts', 'company-page.html', 'people.ts'].map((file) =>
          readFileSync(join(process.cwd(), 'src', 'app', 'features', 'company', file), 'utf8'),
        ),
        ...['info-popover.ts', 'modal-sheet.ts', 'column-menu.ts', 'table-controls.ts'].map(
          (file) => readFileSync(join(process.cwd(), 'src', 'app', 'ui', file), 'utf8'),
        ),
      ]
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');

      for (const forbidden of ['readCode', 'issueCode', 'shareText', 'clipboard', 'data-code']) {
        expect(source, `the people list must not reach for ${forbidden}`).not.toContain(forbidden);
      }
    });
  });

  // ---- Filtering ----------------------------------------------------------------------------

  /**
   * The half of the founder's 2026-09-02 note that is not about colour: *"one standard option
   * beside all columns so I can filter or sort... super admin will have more than 10 clients
   * hopefully and the company admin can have more workers"*.
   *
   * The filter matches **the words the cell shows**, which is what lets one box serve a name, a
   * date and a row of chips without any column declaring a type.
   */
  describe('filtering', () => {
    it('narrows the list to the man he is looking for, and takes his own row with it', async () => {
      await render();

      await filterBy('Osoba', 'zoran');

      expect(listedNames()).toEqual(['Zoran Jovanović']);
      // His own row goes too — he is a row in this table like any other, and a directory that
      // answers "Zoran" with the reader's own name at the top did not do what it was asked.
      expect(element.querySelector('.person--you')).toBeNull();
      expect(groupBands()).toEqual(['Poslovođe 1']);
    });

    /**
     * An owner hunting for Marković types `markovic`; on a phone keyboard every accented letter is
     * a long press. `foldForFilter` is what makes that work, and this is the screen proving it.
     */
    it('finds a Serbian surname typed without its diacritics', async () => {
      await render();

      await filterBy('Osoba', 'markovic');

      expect(listedNames()).toEqual(['Marko Marković']);
    });

    /** The state column is chips, and a chip is a word — so it filters like any other column. */
    it('filters on what the chips say, not on a field nobody can see', async () => {
      await render();

      await filterBy('Stanje', 'kod ga čeka');

      expect(listedNames()).toEqual(['Zoran Jovanović']);
    });

    /**
     * **The dangerous state, said out loud.** A table quietly showing one of three rows is how a
     * screen makes an owner believe a foreman has been removed from his company.
     */
    it('says how much it is hiding, and offers one tap back to everybody', async () => {
      await render();

      await filterBy('Osoba', 'zoran');

      const bar = element.querySelector('.table-bar');
      expect(bar?.textContent).toContain('Prikazano 1 od 3');

      await press('Prikaži sve');

      expect(listedNames()).toEqual(['Marko Marković', 'Zoran Jovanović']);
      expect(element.querySelector('.table-bar')).toBeNull();
      expect(element.querySelector('.person--you')).not.toBeNull();
    });

    /**
     * Three different silences, and the screen never confuses them: the server could not be
     * reached, the company has no foremen, or a filter is hiding them.
     */
    it('says a filter is why the list is empty, not that the company is', async () => {
      await render();

      await filterBy('Osoba', 'nikola');

      expect(listedNames()).toEqual([]);
      expect(text()).toContain('Nijedan red ne odgovara filteru.');
      expect(text()).not.toContain('Dodajte prvog i dajte mu kod');
    });

    /**
     * The phone gets the same control, because an owner reaches this screen on one (decision 9) and
     * a list of twelve men is exactly where a filter earns its place.
     */
    it('filters on a phone through the same control the table uses', async () => {
      viewport.atLeastMedium = () => false;
      viewport.expanded = () => false;
      await render();

      expect(element.querySelectorAll('.column-bar app-column-menu').length).toBe(3);

      await filterBy('Osoba', 'zoran');

      expect(listedNames()).toEqual(['Zoran Jovanović']);
      expect(element.querySelector('.table-bar')?.textContent).toContain('Prikazano 1 od 3');
    });

    /**
     * **The way out survives the filter that needs it.** The control bar is drawn from two rows up,
     * so a filter narrowing the list to one row would have taken the only "show all" on a phone
     * away with it — leaving an owner looking at one man and no way back.
     */
    it('keeps the phone’s controls on screen when the filter has left one row', async () => {
      viewport.atLeastMedium = () => false;
      viewport.expanded = () => false;
      await render();

      await filterBy('Osoba', 'zoran');

      expect(element.querySelectorAll('.column-bar app-column-menu').length).toBe(3);
      expect(buttons().some((b) => b.textContent?.includes('Prikaži sve'))).toBe(true);
    });

    /** A sort is a way of looking at a list; so is a filter. Neither is a place in the app. */
    it('does not navigate, and does not re-read the server, to hide a row', async () => {
      await render();

      await filterBy('Osoba', 'zoran');

      expect(router.navigate).not.toHaveBeenCalled();
      expect(gateway.workerListings).toBe(1);
    });
  });

  // ---- One man's page ------------------------------------------------------------------------

  describe('opening a foreman', () => {
    it('opens his own page from his row, by the path the route table registers', async () => {
      await render();

      const row = [...element.querySelectorAll<HTMLElement>('tr.person--open')].find((candidate) =>
        candidate.textContent?.includes('Zoran'),
      );
      row?.click();
      await settle();

      expect(router.navigate).toHaveBeenCalledWith([workerBase, MockCompanyGateway.ZORAN_ID]);
    });

    /** The row is a pointer convenience; the button inside it is what a keyboard reaches. */
    it('opens him once, not twice, when the control inside the row is used', async () => {
      await render();

      const link = [...element.querySelectorAll<HTMLButtonElement>('.person__link')].find(
        (candidate) => candidate.textContent?.includes('Zoran'),
      );
      link?.click();
      await settle();

      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledWith([workerBase, MockCompanyGateway.ZORAN_ID]);
    });

    /**
     * **The director's row opens too, since 2026-09-01.** It used to be inert, and the sentence
     * here used to say there was no endpoint behind one — which was true of `/api/workers` and
     * false of `/api/me`. The consequence of believing it was that the owner of a paying company
     * was the only person in the product who could not see his own account: his address, the date
     * it was opened and the last sign-in were readable by Teren staff and by nobody else.
     */
    it('opens the director on his own account', async () => {
      await render();

      const rows = [...element.querySelectorAll('tr.person')].filter((row) =>
        row.textContent?.includes('Milan Gradnja'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].classList.contains('person--open')).toBe(true);

      rows[0].querySelector('button')?.click();
      await settle();

      // Resolved from the shipped table by the component class, never spelled out.
      expect(router.navigate).toHaveBeenCalledWith([accountUrl]);
    });

    /**
     * **Not `/profile`**, which is the worker's screen and is gated on this browser holding a
     * *device* session. An admin has none, so a navigation there would be answered by the gate
     * with a redirect to Welcome — a join-by-code screen — and the office would appear to have
     * bounced him out of the product.
     */
    it('does not send him to the foreman profile route', async () => {
      await render();

      const rows = [...element.querySelectorAll('tr.person')].filter((row) =>
        row.textContent?.includes('Milan Gradnja'),
      );
      rows[0].querySelector('button')?.click();
      await settle();

      expect(router.navigate).not.toHaveBeenCalledWith(['/profile']);
    });
  });

  // ---- Sorting ------------------------------------------------------------------------------

  describe('sorting', () => {
    it('starts in the order the server already sends, so the first paint does not reshuffle', async () => {
      await render();

      expect(listedNames()).toEqual(['Marko Marković', 'Zoran Jovanović']);
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('ascending');
    });

    it('turns a column round on a second tap, and says so to a screen reader', async () => {
      await render();

      await press('Osoba');

      expect(listedNames()).toEqual(['Zoran Jovanović', 'Marko Marković']);
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('descending');
    });

    /**
     * "Sort by state" means the order an owner reads the list in to answer *who cannot record
     * today*: a man with no phone and no code first, a man with a phone last.
     */
    it('sorts by state, and only one column is ever the sorted one', async () => {
      await render();

      await press('Stanje');

      // Marko has neither phone nor code; Zoran has a phone.
      expect(listedNames()).toEqual(['Marko Marković', 'Zoran Jovanović']);
      expect(element.querySelector('.col--state')?.getAttribute('aria-sort')).toBe('ascending');
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('none');

      await press('Stanje');
      expect(listedNames()).toEqual(['Zoran Jovanović', 'Marko Marković']);
      expect(element.querySelector('.col--state')?.getAttribute('aria-sort')).toBe('descending');
    });

    /** The column is headed *Aktivnost* since 2026-09-02 — see the dictionary, not this spec. */
    it('sorts by last contact with the most recent first on the first tap', async () => {
      await render();

      await press('Aktivnost');

      // Zoran called home; Marko never has, and "never" is not the oldest date.
      expect(listedNames()).toEqual(['Zoran Jovanović', 'Marko Marković']);
      expect(element.querySelector('.col--contact')?.getAttribute('aria-sort')).toBe('descending');
    });

    /**
     * The sort lives in the component. A query parameter per tap would re-run
     * `requiresCompanyAdmin` and re-read the whole list from the server to paint the same rows in
     * a different order — and "my foremen sorted by last contact" is not a place anybody links to.
     */
    it('does not navigate, and does not re-read the server, to reorder rows', async () => {
      await render();

      await press('Stanje');

      expect(router.navigate).not.toHaveBeenCalled();
      expect(gateway.workerListings).toBe(1);
    });
  });

  // ---- Adding a foreman ---------------------------------------------------------------------

  describe('adding a foreman', () => {
    async function openForm(): Promise<void> {
      await press('Dodaj poslovođu');
    }

    it('will not send a nameless man, and says so by refusing the button', async () => {
      await render();
      await openForm();

      expect(button('Dodaj i napravi kod').disabled).toBe(true);

      element.querySelector('form')?.dispatchEvent(new Event('submit'));
      await settle();

      expect(gateway.added).toEqual([]);
    });

    /**
     * Adding a man you cannot then activate is not a finished action — so this ends on *his* page,
     * where his first code is waiting. It must never end with a code on the list.
     */
    it('adds him and goes to his page, with no code anywhere on this screen', async () => {
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');
      await type('input[type="email"]', 'Petar@Firma.RS');

      await press('Dodaj i napravi kod');

      expect(gateway.added).toEqual([{ display_name: 'Petar Petrović', email: 'petar@firma.rs' }]);
      expect(router.navigate).toHaveBeenCalledWith([workerBase, expect.any(String)]);
      expect(element.querySelector('[data-code]')).toBeNull();
      expect(text()).not.toMatch(/NEW\d-CODE/);
    });

    it('sends no address at all rather than an empty one', async () => {
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(gateway.added).toEqual([{ display_name: 'Petar Petrović' }]);
    });

    /**
     * The two conflicts have different remedies and must not share a sentence: a taken address is
     * his to change, a lost username race is the server's and the answer is to press again.
     */
    it('names a taken email address', async () => {
      gateway.addError = httpError(409, { code: 'email_taken' });
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');
      await type('input[type="email"]', 'zauzeto@firma.rs');

      await press('Dodaj i napravi kod');

      expect(text()).toContain('Ta imejl adresa je već na jednom Teren nalogu.');
      expect(text()).not.toContain('To ime je zauzeto');
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('names a lost username race separately', async () => {
      gateway.addError = httpError(409, { code: 'username_taken' });
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(text()).toContain('To ime je zauzeto dok je dodavan.');
      expect(text()).not.toContain('Ta imejl adresa');
    });

    /**
     * `serverAnswered`, on the one mutation this screen still performs. A `POST /api/workers` that
     * got no verdict **may well have created the man** — telling the owner it failed invites a
     * second submission and a second foreman with the same name and a different username.
     */
    it('does not call an unanswered add a failure', async () => {
      gateway.addError = httpError(500);
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(text()).toContain('Server nije odgovorio, pa se ne zna da li je dodat.');
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('says plainly when the server refused, because then nothing changed', async () => {
      gateway.addError = httpError(403);
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(text()).toContain('Ovaj nalog to ne sme.');
      expect(text()).not.toContain('Server nije odgovorio');
    });

    it('clears the complaint as soon as he edits the field', async () => {
      gateway.addError = httpError(409, { code: 'email_taken' });
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');
      await type('input[type="email"]', 'zauzeto@firma.rs');
      await press('Dodaj i napravi kod');

      await type('input[type="email"]', 'drugo@firma.rs');

      expect(text()).not.toContain('Ta imejl adresa je već na jednom Teren nalogu.');
    });
  });

  // ---- The head row's action cluster ---------------------------------------------------------

  describe('the info popover', () => {
    function popover(): HTMLElement | null {
      return element.querySelector('.pop');
    }

    function infoButton(): HTMLButtonElement {
      return button('Kako kodovi rade');
    }

    /**
     * The founder asked for hover, and hover is right on a mouse. It is also the one gesture a phone
     * does not have — and a company admin reaches this screen on a phone — so the same explanation
     * has to open on a tap and on a keyboard focus as well. jsdom reports no fine pointer, which is
     * exactly the phone's case, so what this exercises is the tap path.
     */
    it('opens the explanation on a tap and closes it again', async () => {
      await render();

      expect(popover()).toBeNull();
      expect(infoButton().getAttribute('aria-expanded')).toBe('false');

      await press('Kako kodovi rade');

      expect(popover()?.textContent).toContain('Kod važi jednom i traje sedam dana.');
      expect(infoButton().getAttribute('aria-expanded')).toBe('true');
      // A disclosure, not a tooltip: the button owns the thing it opens.
      expect(infoButton().getAttribute('aria-controls')).toBe(popover()?.id);

      await press('Kako kodovi rade');
      expect(popover()).toBeNull();
    });

    it('closes on Escape and on a tap outside it', async () => {
      await render();
      await press('Kako kodovi rade');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      expect(popover()).toBeNull();

      await press('Kako kodovi rade');
      element
        .querySelector<HTMLElement>('.head__title')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      expect(popover()).toBeNull();
    });

    /**
     * The card that used to carry this text is gone from the page body — that was the point of the
     * change. It must be *reachable*, not merely deleted.
     */
    it('is the only place the code explanation lives now', async () => {
      await render();

      expect(text()).not.toContain('Kod važi jednom i traje sedam dana.');

      await press('Kako kodovi rade');

      expect(text()).toContain('Kod važi jednom i traje sedam dana.');
    });

    /** It carries an explanation and nothing else — decision 13 on a brand-new surface. */
    it('carries no code and no share text', async () => {
      await render();
      await press('Kako kodovi rade');

      expect(element.querySelector('[data-code]')).toBeNull();
      expect(popover()?.textContent).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(popover()?.querySelector('button')).toBeNull();
      expect(gateway.reads).toEqual([]);
    });
  });

  describe('the add-a-foreman dialog', () => {
    function dialog(): HTMLElement | null {
      return element.querySelector('[role="dialog"]');
    }

    it('is a labelled modal dialog, with the form inside it', async () => {
      await render();
      expect(dialog()).toBeNull();

      await press('Dodaj poslovođu');

      const panel = dialog();
      expect(panel?.getAttribute('aria-modal')).toBe('true');
      expect(panel?.getAttribute('aria-label')).toBe('Novi poslovođa');
      expect(panel?.querySelector('form')).not.toBeNull();
      // The same form as before: same fields, same optional-address hint, same actions.
      expect(panel?.textContent).toContain('IME I PREZIME');
      expect(panel?.textContent).toContain('Sa adresom može sam da zatraži novi kod');
      expect(button('Dodaj i napravi kod')).toBeTruthy();
    });

    /**
     * Focus in on open, **and back to the button that opened it on close**. The return is the half
     * usually missed, and without it a keyboard user closing this lands at the top of the document.
     */
    it('moves focus into the form and hands it back on close', async () => {
      await render();
      const opener = button('Dodaj poslovođu');
      opener.focus();

      await press('Dodaj poslovođu');
      expect(document.activeElement?.tagName).toBe('INPUT');

      await press('Otkaži');
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(button('Dodaj poslovođu'));
      expect(button('Dodaj poslovođu')).toBe(opener);
    });

    it('closes on Escape and on a click on the backdrop', async () => {
      await render();
      await press('Dodaj poslovođu');

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      expect(dialog()).toBeNull();

      await press('Dodaj poslovođu');
      element.querySelector<HTMLElement>('.modal')?.click();
      await settle();
      expect(dialog()).toBeNull();
    });

    /** The page behind a dialog must not scroll under it, and must scroll again afterwards. */
    it('locks the page behind it, and unlocks it again', async () => {
      await render();
      await press('Dodaj poslovođu');
      expect(document.body.style.overflow).toBe('hidden');

      await press('Otkaži');
      expect(document.body.style.overflow).toBe('');
    });

    /**
     * **The one that would cost a duplicate foreman.**
     *
     * A submit that fails puts the only sentence explaining why on the screen. If the dialog closed
     * on a failed submit, that sentence would be destroyed at the moment it matters — and an owner
     * who read "it failed" nowhere would press the button again and mint a second foreman with the
     * same name and a different username.
     */
    it('stays open when the submit fails, with the reason still on screen', async () => {
      gateway.addError = httpError(409, { code: 'email_taken' });
      await render();
      await press('Dodaj poslovođu');
      await type('input[type="text"]', 'Petar Petrović');
      await type('input[type="email"]', 'zauzeto@firma.rs');

      await press('Dodaj i napravi kod');

      expect(dialog()).not.toBeNull();
      expect(dialog()?.textContent).toContain('Ta imejl adresa je već na jednom Teren nalogu.');
      // …and what he typed is still there, so the fix is one edit rather than a retype.
      expect(element.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe(
        'Petar Petrović',
      );
      expect(router.navigate).not.toHaveBeenCalled();
    });

    /** The same, for the failure that must never read as a plain failure. */
    it('stays open, and says it could not confirm, when the server gave no verdict', async () => {
      gateway.addError = httpError(500);
      await render();
      await press('Dodaj poslovođu');
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(dialog()).not.toBeNull();
      expect(dialog()?.textContent).toContain(
        'Server nije odgovorio, pa se ne zna da li je dodat.',
      );
    });

    it('carries no code and no copy action', async () => {
      await render();
      await press('Dodaj poslovođu');

      expect(element.querySelector('[data-code]')).toBeNull();
      expect(dialog()?.textContent).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(
        [...(dialog()?.querySelectorAll('button') ?? [])].some((b) =>
          /kopiraj|podeli/i.test(b.textContent ?? ''),
        ),
      ).toBe(false);
    });
  });

  // ---- The two renderings -------------------------------------------------------------------

  describe('the table, and the row list under it', () => {
    /**
     * A real table to a screen reader from 768 up: a caption, a header cell per column with
     * `scope`, a `scope="rowgroup"` header per role group, and `aria-sort` on the ordered column.
     */
    it('is a table with headers and groups at 768 and up', async () => {
      await render();

      const table = element.querySelector('table');
      expect(table).not.toBeNull();
      expect(table?.querySelector('caption')?.textContent).toContain('Svi u firmi');
      expect(
        [...(table?.querySelectorAll('thead th') ?? [])].map((th) => th.getAttribute('scope')),
      ).toEqual(['col', 'col', 'col', 'col']);
      expect(
        [...(table?.querySelectorAll('tbody th[scope="rowgroup"]') ?? [])].map((th) =>
          th.textContent?.replace(/\s+/g, ' ').trim(),
        ),
      ).toEqual(['Vlasnik firme', 'Poslovođe 2']);
      // Every group header spans the whole table; a `display: flex` on the `<th>` would silently
      // drop the colspan and shrink the band to one column.
      expect(
        [...(table?.querySelectorAll('tbody th[scope="rowgroup"]') ?? [])].every(
          (th) => th.getAttribute('colspan') === '4',
        ),
      ).toBe(true);
      // Each foreman's name is the accessible row header.
      expect(table?.querySelector('tbody th[scope="row"]')).not.toBeNull();
    });

    /**
     * **A table is the wrong answer at 375**, and not merely visually: a table whose cells are
     * forced to `display: block` loses its table role in every browser, so restyling one markup
     * would give a phone the semantics of neither a table nor a list. Two renderings, one at a
     * time, decided in TypeScript.
     */
    it('is a list of tappable rows below 768, with no table at all', async () => {
      viewport.atLeastMedium = () => false;
      viewport.expanded = () => false;
      await render();

      expect(element.querySelector('table')).toBeNull();
      expect(listedNames()).toEqual(['Marko Marković', 'Zoran Jovanović']);
      // One row is one control, not a card that expands. Three of them: the owner's own row is a
      // control here too since 2026-09-01, which is why the foremen are counted apart from it.
      const rows = [
        ...element.querySelectorAll<HTMLButtonElement>('.row-button.row:not(.row--you)'),
      ];
      expect(rows.length).toBe(2);
      expect(element.querySelectorAll('.row-button.row').length).toBe(3);

      rows[1].click();
      await settle();
      expect(router.navigate).toHaveBeenCalledWith([workerBase, MockCompanyGateway.ZORAN_ID]);
    });

    /** The column headers carry the sort above 768; below it, three pills do. */
    it('keeps the list sortable on a phone', async () => {
      viewport.atLeastMedium = () => false;
      await render();

      expect(element.querySelectorAll('.sort-pill').length).toBe(3);

      await press('Stanje');
      expect(listedNames()).toEqual(['Marko Marković', 'Zoran Jovanović']);
      expect(element.querySelector('.sort-pill--on')?.getAttribute('aria-pressed')).toBe('true');
    });
  });

  /**
   * Decision 9, and the founder rule behind it: every screen ships a deliberate layout for all
   * three device classes. Read off the shipped stylesheet, because a media query has no DOM to
   * interrogate under jsdom — the widths themselves were checked in a browser at 375, 768, 834,
   * 1280 and 1920.
   */
  describe('three device classes', () => {
    const css = readFileSync(
      join(process.cwd(), 'src', 'app', 'features', 'company', 'company-page.css'),
      'utf8',
    );
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

    it('gives a phone chrome of its own, since the app header starts at 768', async () => {
      viewport.atLeastMedium = () => false;
      await render();

      expect(element.querySelector('.bar--compact')).not.toBeNull();
      expect(element.querySelector('.bar--compact app-language-switcher')).not.toBeNull();
      expect(rules).toMatch(
        /@media \(min-width: 768px\)\s*\{\s*\.bar--compact\s*\{\s*display: none/,
      );
    });

    /**
     * The medium class is designed rather than inherited — and since the rail went it is designed by
     * *subtraction*: a table on the 640 column with the numbers above it, and nothing else. The
     * founder's 768 complaint was that the "new foreman" form dominated the screen and the one
     * worker was a small card above it; the form is behind an icon now and cannot dominate anything.
     */
    it('designs the medium class instead of stretching the phone through it', async () => {
      viewport.atLeastMedium = () => true;
      viewport.expanded = () => false;
      await render();

      // A table rather than the phone's row list…
      expect(element.querySelector('table')).not.toBeNull();
      // …the numbers above it…
      expect(element.querySelectorAll('.stats__cell').length).toBe(3);
      // …and no form anywhere in the page body until it is asked for.
      expect(element.querySelector('form')).toBeNull();
      expect(text()).not.toContain('IME I PREZIME');
      // The rail is gone from the stylesheet, not merely from the markup.
      expect(rules).not.toContain('pane--aside');
    });

    /**
     * **The founder's 1920 note, finally answered by subtraction.**
     *
     * The rail used to hold the whole useful half of the screen while the table beside it held air.
     * There is no rail: the table takes all twelve columns, and the two things that used to sit
     * beside it are behind the head row's icons. The card's `min-height` is a couple of rows' worth
     * of tail rather than the viewport's height — at full width the stretched version printed a
     * 1150 × 330 slab of white, which is louder than the canvas it was trying to fill, and the two
     * screenshots at 1920 are what settled it.
     */
    it('gives the expanded class a real application layout, not a centred phone column', async () => {
      await render();
      const expanded = rules.split('@media (min-width: 1024px)')[1] ?? '';

      expect(expanded).toContain('grid-template-columns: repeat(12, 1fr)');
      // The people card is `wide`, which is the class that spans all twelve columns.
      expect(element.querySelector('.people')?.classList.contains('wide')).toBe(true);
      expect(expanded).toContain('grid-column: 1 / -1');
      expect(expanded).toMatch(/\.people\s*\{[^}]*min-height/);
      // Neither a rail nor an eight-column table survives anywhere in the sheet.
      expect(rules).not.toContain('pane--aside');
      expect(rules).not.toContain('span 8');
    });

    it('takes every colour from the design tokens', () => {
      // `design/tokens.md` is binding, and a raw hex is how a screen drifts out of the system.
      expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
  });
});
