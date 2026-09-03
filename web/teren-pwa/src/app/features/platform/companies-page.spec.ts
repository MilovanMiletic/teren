import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { MockPlatformGateway } from '../../core/platform/mock-platform-gateway';
import { PlatformCompanyResponse } from '../../core/platform/platform-types';
import { PLATFORM_GATEWAY } from '../../core/platform/platform-gateway';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import { KnobbedPlatformGateway, platformHttpError } from '../../testing/platform-gateway-double';
import { routeUrlFor } from '../../testing/route-table';
import { ViewportService } from '../../ui/viewport.service';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { CompaniesPage } from './companies-page';
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

describe('CompaniesPage', () => {
  let fixture: ComponentFixture<CompaniesPage>;
  let element: HTMLElement;
  let router: Router;
  let gateway: KnobbedPlatformGateway;

  const viewport = { atLeastMedium: () => true, expanded: () => true };

  /** The people directory's own URL, resolved from the shipped table by the component class. */
  let peopleUrl: string;

  beforeAll(async () => {
    peopleUrl = await routeUrlFor(PlatformPage);
  });

  async function render(signedIn = true): Promise<void> {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(STAFF));
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        CompaniesPage,
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

    fixture = TestBed.createComponent(CompaniesPage);
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await settle();
  }

  /** The app is zoneless, so `whenStable()` knows nothing about an un-tracked `void this.load()`. */
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
   * Type into one column's filter box, through the control the founder actually uses: open the
   * column's menu from its funnel, then type. Never by calling the component — what is under test
   * is the path from a key press on the glass to a row leaving the list.
   */
  /**
   * Sort by a column, through its heading.
   *
   * **Not `press(label)`.** That helper matches any button whose text *or accessible name* contains
   * the string, and this screen carries "Odjavi se" in its chrome — so pressing "Od" for the *Od*
   * column signed the founder out instead, and the spec that did it looked like a broken sort.
   */
  async function sortByColumn(label: string): Promise<void> {
    const control = [...element.querySelectorAll<HTMLButtonElement>('.sort')].find((candidate) =>
      candidate.textContent?.trim().startsWith(label),
    );
    if (!control) {
      throw new Error(`no column headed "${label}"`);
    }
    control.click();
    await settle();
  }

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

  /**
   * A button **inside the open dialog**, by what it says.
   *
   * Scoped deliberately: the confirmation's own "Suspenduj" reads exactly like the one on every
   * customer's row, and the add dialog's "Dodaj" like the head cluster's "Dodaj firmu". A
   * document-wide search would find the row's button first and quietly re-open the question instead
   * of answering it — a spec that would pass while asserting nothing.
   */
  function inDialog(label: string): HTMLButtonElement {
    const panel = dialog();
    if (!panel) {
      throw new Error(`no dialog on screen to look for "${label}" in`);
    }
    const found = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!found) {
      throw new Error(
        `no button reading "${label}" in the dialog; there are: ` +
          [...panel.querySelectorAll('button')]
            .map((candidate) => `"${candidate.textContent?.trim()}"`)
            .join(', '),
      );
    }
    return found;
  }

  async function pressIn(label: string): Promise<void> {
    inDialog(label).click();
    await settle();
  }

  /** One customer's row, so an assertion about *this* customer cannot be answered by another. */
  function row(name: string): HTMLElement {
    const selector = viewport.atLeastMedium() ? 'tr.person' : 'li.row';
    const found = [...element.querySelectorAll<HTMLElement>(selector)].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!found) {
      throw new Error(`no row for ${name}`);
    }
    return found;
  }

  /** The action on one customer's row, which is the only place a suspend can start. */
  async function pressOn(name: string, label: string): Promise<void> {
    const action = [...row(name).querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!action) {
      throw new Error(`no "${label}" on ${name}'s row`);
    }
    action.click();
    await settle();
  }

  function listedNames(): string[] {
    const selector = viewport.atLeastMedium() ? 'tr.person .person__name' : 'li.row .person__name';
    return [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '');
  }

  function stats(): (string | undefined)[] {
    return [...element.querySelectorAll('.stats__value')].map((node) => node.textContent?.trim());
  }

  function dialog(): HTMLElement | null {
    return element.querySelector('[role="dialog"]');
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
    gateway = new KnobbedPlatformGateway();
    viewport.atLeastMedium = () => true;
    viewport.expanded = () => true;
  });

  afterEach(() => localStorage.clear());

  // ---- The list ---------------------------------------------------------------------------------

  describe('the customers', () => {
    it('resolves the loading state into who Teren sells to', async () => {
      await render();

      expect(text()).not.toContain('Učitavanje firmi…');
      expect(listedNames()).toEqual(['Elektro Nikolić d.o.o.', 'Vodoinstal Petrović d.o.o.']);
      expect(text()).toContain('Firme');
      expect(text()).toContain('Kome Teren prodaje');
    });

    /** People, never work: `active/total` answers "is this customer set up, or stuck?". */
    it('shows how many of a customer’s people can still sign in', async () => {
      await render();

      expect(row('Vodoinstal Petrović d.o.o.').textContent).toContain('3 / 3');
      expect(row('Elektro Nikolić d.o.o.').textContent).toContain('0 / 1');
    });

    it('marks a withdrawn customer, and counts the two states apart', async () => {
      await render();

      expect(row('Elektro Nikolić d.o.o.').textContent).toContain('Suspendovana');
      expect(row('Vodoinstal Petrović d.o.o.').textContent).not.toContain('Suspendovana');
      expect(stats()).toEqual(['1', '1']);
    });

    it('offers the opposite action on a customer who is already off', async () => {
      await render();

      expect(row('Vodoinstal Petrović d.o.o.').textContent).toContain('Suspenduj');
      expect(row('Elektro Nikolić d.o.o.').textContent).toContain('Vrati');
    });

    it('draws a list rather than a table below 768', async () => {
      viewport.atLeastMedium = () => false;
      await render();

      expect(element.querySelector('table')).toBeNull();
      expect(listedNames()).toEqual(['Elektro Nikolić d.o.o.', 'Vodoinstal Petrović d.o.o.']);
    });

    /**
     * A short list because a request failed and a short list because Teren has few customers look
     * identical unless the screen says which it is — and here the second reading ("we have no
     * customers") is the alarming one.
     */
    it('says the server was not reached rather than printing noughts under it', async () => {
      gateway.companiesError = platformHttpError(500);
      await render();

      expect(text()).toContain('Nije provereno na serveru');
      expect(text()).toContain('Server trenutno ne odgovara.');
      expect(stats()).toEqual(['—', '—']);
    });

    it('tells an expired sign-in from a role that may not do this', async () => {
      gateway.companiesError = platformHttpError(401);
      await render();
      expect(text()).toContain('Prijava je istekla. Prijavite se ponovo.');

      gateway = new KnobbedPlatformGateway();
      gateway.companiesError = platformHttpError(403);
      await render();
      expect(text()).toContain('Vaša uloga ovo ne može da uradi.');
      expect(text()).not.toContain('Prijava je istekla.');
    });

    it('sends nothing at all when this browser holds no admin credential', async () => {
      await render(false);

      expect(text()).toContain('Niste prijavljeni.');
      expect(gateway.companyListings).toBe(0);
    });

    it('reloads on demand', async () => {
      await render();
      expect(gateway.companyListings).toBe(1);

      element.querySelector<HTMLButtonElement>('.head__reload')?.click();
      await settle();

      expect(gateway.companyListings).toBe(2);
    });

    /** Both screens point at each other, so neither is a dead end. */
    it('goes back to the people by the path the route table registers', async () => {
      await render();

      // "Idi na ljude", not "Ljudi": this screen has a column headed *Ljudi*, and an icon whose
      // only name was the destination's noun made the two indistinguishable (2026-09-02).
      await press('Idi na ljude');

      expect(router.navigate).toHaveBeenCalledWith([peopleUrl]);
    });

    it('keeps a way out on a phone, where the header does not exist', async () => {
      await render();

      expect(element.querySelector('.bar--compact app-session-link')).not.toBeNull();
      expect(element.querySelector('app-header app-session-link')).not.toBeNull();
    });
  });

  // ---- Adding a customer --------------------------------------------------------------------------

  // ---- The column controls --------------------------------------------------------------------

  /**
   * The founder's 2026-09-02 note, both halves. *"Column headers in the second screenshot are
   * black and in all the others it's not like that"* — this screen's headings were plain `<th>`
   * text because it had no sort at all, so there was nothing in the cell to style. And *"one
   * standard option beside all columns so I can filter or sort... super admin will have more than
   * 10 clients hopefully"*.
   */
  describe('sorting and filtering the customers', () => {
    /**
     * The structural half of the founder's colour complaint: the heading is the **shared control**
     * every other table in the product uses, so it cannot drift back into the browser's own black
     * bold text without every table drifting with it.
     */
    it('heads every column with the same control the other tables use', async () => {
      await render();

      const heads = [...element.querySelectorAll('thead th')];
      expect(heads.length).toBe(4);
      // Three real columns carry the control; the fourth is the action and has nothing to sort.
      expect(element.querySelectorAll('thead app-column-menu').length).toBe(3);
      expect(heads[3].querySelector('.visually-hidden')?.textContent?.trim()).toBe('Radnja');
      expect(element.querySelector('table')?.classList.contains('data-table')).toBe(true);
    });

    it('sorts by name, and turns it round on a second tap', async () => {
      await render();

      expect(listedNames()).toEqual(['Elektro Nikolić d.o.o.', 'Vodoinstal Petrović d.o.o.']);
      expect(element.querySelector('.col--name')?.getAttribute('aria-sort')).toBe('ascending');

      await sortByColumn('Firma');

      expect(listedNames()).toEqual(['Vodoinstal Petrović d.o.o.', 'Elektro Nikolić d.o.o.']);
      expect(element.querySelector('.col--name')?.getAttribute('aria-sort')).toBe('descending');
    });

    /**
     * The useful direction on the first tap: the biggest customer, and the newest signing. A column
     * that needed two taps to say something useful would cost one on every use, for ever.
     */
    it('opens the two other columns at their interesting end', async () => {
      await render();

      await sortByColumn('Ljudi');
      expect(listedNames()).toEqual(['Vodoinstal Petrović d.o.o.', 'Elektro Nikolić d.o.o.']);
      expect(element.querySelector('.col--people')?.getAttribute('aria-sort')).toBe('descending');

      await sortByColumn('Od');
      // Elektro signed on 20 August, Vodoinstal on the 1st: newest first.
      expect(listedNames()).toEqual(['Elektro Nikolić d.o.o.', 'Vodoinstal Petrović d.o.o.']);
      expect(element.querySelector('.col--since')?.getAttribute('aria-sort')).toBe('descending');
      expect(element.querySelector('.col--people')?.getAttribute('aria-sort')).toBe('none');
    });

    it('narrows the list to the customer he is looking for, diacritics or not', async () => {
      await render();

      await filterBy('Firma', 'nikolic');

      expect(listedNames()).toEqual(['Elektro Nikolić d.o.o.']);
    });

    /**
     * **The dangerous state, said out loud** — and on this screen it is the most dangerous of the
     * three, because the button beside a customer's name suspends him. A founder who does not know
     * he is filtering is a founder about to suspend the wrong row.
     */
    it('says how much it is hiding, and offers one tap back to everybody', async () => {
      await render();

      await filterBy('Firma', 'nikolic');
      expect(element.querySelector('.table-bar')?.textContent).toContain('Prikazano 1 od 2');

      await press('Prikaži sve');

      expect(listedNames()).toEqual(['Elektro Nikolić d.o.o.', 'Vodoinstal Petrović d.o.o.']);
      // The strip stays and goes quiet — see `company-page.spec.ts`, which reasons it out: the
      // count is printed always since paging, and the tint goes on meaning one thing only.
      const cleared = element.querySelector('.table-bar');
      expect(cleared?.classList.contains('table-bar--quiet')).toBe(true);
      expect(cleared?.textContent).toContain('Ukupno 2');
      expect(text()).not.toContain('Prikaži sve');
    });

    it('says a filter is why the list is empty, not that Teren has no customers', async () => {
      await render();

      await filterBy('Firma', 'gradnja ilic');

      expect(listedNames()).toEqual([]);
      expect(text()).toContain('Nijedan red ne odgovara filteru.');
      expect(text()).not.toContain('Još nema firmi.');
    });

    /** The same controls on a phone, as pills — the founder reads this screen on one. */
    it('gives the phone the same controls, as pills', async () => {
      viewport.atLeastMedium = () => false;
      await render();

      expect(element.querySelectorAll('.column-bar app-column-menu').length).toBe(3);

      await filterBy('Firma', 'nikolic');
      expect(listedNames()).toEqual(['Elektro Nikolić d.o.o.']);
    });

    /** A sort and a filter are ways of looking at a list, not places in the app. */
    it('does not navigate, and does not re-read the server, to reorder or hide a row', async () => {
      await render();

      await sortByColumn('Ljudi');
      await filterBy('Firma', 'nikolic');

      expect(router.navigate).not.toHaveBeenCalled();
      expect(gateway.companyListings).toBe(1);
    });
  });

  describe('adding a customer', () => {
    async function openAdd(): Promise<void> {
      await press('Dodaj firmu');
    }

    it('is a labelled modal dialog that asks for a name and nothing else', async () => {
      await render();
      expect(dialog()).toBeNull();

      await openAdd();

      expect(dialog()?.getAttribute('aria-modal')).toBe('true');
      expect(dialog()?.getAttribute('aria-label')).toBe('Dodaj firmu');
      expect(text()).toContain('Dovoljno je ime.');
      expect(element.querySelector('#company-add-name')).not.toBeNull();
    });

    it('will not send a nameless customer, and says so by refusing the button', async () => {
      await render();
      await openAdd();

      expect(inDialog('Dodaj').disabled).toBe(true);

      element.querySelector('form')?.dispatchEvent(new Event('submit'));
      await settle();

      expect(gateway.createdCompanies).toEqual([]);
    });

    it('adds one, closes over it, and re-reads the list so the new customer is on it', async () => {
      await render();
      await openAdd();
      await type('#company-add-name', 'Gradnja Ilić d.o.o.');

      await pressIn('Dodaj');

      expect(gateway.createdCompanies).toEqual([{ name: 'Gradnja Ilić d.o.o.' }]);
      expect(dialog()).toBeNull();
      expect(gateway.companyListings).toBe(2);
      expect(listedNames()).toContain('Gradnja Ilić d.o.o.');
    });

    it('keeps the form up and says why when the server refused', async () => {
      gateway.createCompanyError = platformHttpError(400);
      await render();
      await openAdd();
      await type('#company-add-name', 'Gradnja Ilić d.o.o.');

      await pressIn('Dodaj');

      expect(text()).toContain('Firma nije mogla da se doda');
      expect(text()).toContain('Server ovo nije prihvatio.');
      expect(element.querySelector('#company-add-name')).not.toBeNull();
    });

    /**
     * A `POST /api/platform/companies` that got no verdict **may well have created the customer**;
     * telling the founder it failed invites a second press and two customers with one name.
     */
    it('does not call an unanswered add a failure', async () => {
      gateway.createCompanyError = platformHttpError(500);
      await render();
      await openAdd();
      await type('#company-add-name', 'Gradnja Ilić d.o.o.');

      await pressIn('Dodaj');

      expect(text()).toContain(
        'Server nije odgovorio, pa se ne zna da li je radnja izvršena. Osvežite pre nego što pokušate ponovo.',
      );
      expect(text()).not.toContain('Server trenutno ne odgovara.');
    });
  });

  // ---- Suspending and resuming ---------------------------------------------------------------------

  describe('suspending a customer', () => {
    /**
     * **The heaviest action on this surface, and the question says so.** `company.suspended_at` is
     * joined by the authenticator on every request with no cache: the moment it lands, every phone
     * and every session belonging to that customer starts getting a 401 on next contact. A mis-tap
     * here is a contractor's afternoon, so the dialog **names the customer** rather than asking
     * "are you sure?" over a row the founder may already have scrolled past.
     */
    it('asks first, naming the customer and what will happen to his phones', async () => {
      await render();

      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');

      expect(dialog()).not.toBeNull();
      expect(text()).toContain('Suspendovati Vodoinstal Petrović d.o.o.?');
      expect(text()).toContain('Svi njihovi telefoni i prijave prestaju da rade');
      // Nothing has been sent yet — the question is the whole point.
      expect(gateway.suspended).toEqual([]);
    });

    it('names the other customer when the other row is the one that was tapped', async () => {
      await render();

      await pressOn('Elektro Nikolić d.o.o.', 'Vrati');

      expect(text()).toContain('Vratiti Elektro Nikolić d.o.o.?');
      expect(text()).not.toContain('Vodoinstal Petrović d.o.o.?');
    });

    it('sends nothing when the question is declined', async () => {
      await render();
      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');

      await pressIn('Odustani');

      expect(dialog()).toBeNull();
      expect(gateway.suspended).toEqual([]);
    });

    it('withdraws the customer that was asked about, and shows him withdrawn', async () => {
      await render();
      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');

      await pressIn('Suspenduj');

      expect(gateway.suspended).toEqual([MockPlatformGateway.VODOINSTAL_ID]);
      expect(gateway.resumed).toEqual([]);
      expect(dialog()).toBeNull();
      expect(row('Vodoinstal Petrović d.o.o.').textContent).toContain('Suspendovana');
      expect(stats()).toEqual(['0', '2']);
    });

    it('puts one back, and the customer counts as active again', async () => {
      await render();
      await pressOn('Elektro Nikolić d.o.o.', 'Vrati');

      await pressIn('Vrati');

      expect(gateway.resumed).toEqual([MockPlatformGateway.ELEKTRO_ID]);
      expect(gateway.suspended).toEqual([]);
      expect(row('Elektro Nikolić d.o.o.').textContent).not.toContain('Suspendovana');
      expect(stats()).toEqual(['2', '0']);
    });

    /**
     * **Where the server gave no verdict the screen must not say "it failed".** Suspending may well
     * have suspended, and a founder told otherwise presses again over a customer who is already
     * off — or, worse, resumes one he meant to leave off. The sentence sends him to reload instead.
     */
    it('says to reload rather than that it failed, when the server never answered', async () => {
      gateway.suspendError = platformHttpError(500);
      await render();
      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');

      await pressIn('Suspenduj');

      expect(text()).toContain('Radnja nije prošla');
      expect(text()).toContain(
        'Server nije odgovorio, pa se ne zna da li je radnja izvršena. Osvežite pre nego što pokušate ponovo.',
      );
      expect(text()).not.toContain('Server trenutno ne odgovara.');
      // The question stays up: the founder has not finished with this customer.
      expect(dialog()).not.toBeNull();
    });

    it('says the same about a network that never carried the request', async () => {
      gateway.suspendError = platformHttpError(0);
      await render();
      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');

      await pressIn('Suspenduj');

      expect(text()).toContain('Server nije odgovorio, pa se ne zna da li je radnja izvršena.');
      expect(text()).not.toContain('Nema interneta. Ništa nije stiglo do servera.');
    });

    /**
     * A refusal is the opposite case: the server looked and said no, so **nothing changed** and the
     * remedy is the refusal itself rather than a reload.
     */
    it('says plainly when the server refused, because then nothing changed', async () => {
      gateway.suspendError = platformHttpError(403);
      await render();
      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');

      await pressIn('Suspenduj');

      expect(text()).toContain('Vaša uloga ovo ne može da uradi.');
      expect(text()).not.toContain('Server nije odgovorio');
    });

    /**
     * The two dialogs must not answer for each other. An action that got no verdict earlier would
     * otherwise put "the server did not answer, reload first" under an add the server plainly
     * refused — and the founder would go looking for a customer that was never created.
     */
    it('does not carry one dialog’s verdict into the other', async () => {
      gateway.suspendError = platformHttpError(500);
      gateway.createCompanyError = platformHttpError(400);
      await render();
      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');
      await pressIn('Suspenduj');
      expect(text()).toContain('Server nije odgovorio, pa se ne zna da li je radnja izvršena.');

      await pressIn('Odustani');
      await press('Dodaj firmu');
      await type('#company-add-name', 'Gradnja Ilić d.o.o.');
      await pressIn('Dodaj');

      expect(text()).toContain('Server ovo nije prihvatio.');
      expect(text()).not.toContain('Server nije odgovorio, pa se ne zna da li je radnja izvršena.');
    });

    it('asks again cleanly after a failure, with no stale complaint on the second question', async () => {
      gateway.suspendError = platformHttpError(403);
      await render();
      await pressOn('Vodoinstal Petrović d.o.o.', 'Suspenduj');
      await pressIn('Suspenduj');
      expect(text()).toContain('Vaša uloga ovo ne može da uradi.');

      await pressIn('Odustani');
      await pressOn('Elektro Nikolić d.o.o.', 'Vrati');

      expect(text()).toContain('Vratiti Elektro Nikolić d.o.o.?');
      expect(text()).not.toContain('Vaša uloga ovo ne može da uradi.');
    });
  });

  // ---- The info popover ------------------------------------------------------------------------------

  describe('the info popover', () => {
    it('explains what a suspension does, on a tap', async () => {
      await render();

      // 2026-09-03: the sentence itself changed with the sign-out policy — a suspended customer's
      // phones now sign themselves out, so his foremen stop recording and each phone has to be
      // joined again with a new code afterwards. What this spec is about is unchanged: the
      // explanation is behind a tap and is not on the screen until he asks for it.
      expect(text()).not.toContain('Telefoni se sami odjavljuju');

      await press('Šta radi suspenzija');

      expect(element.querySelector('.pop')?.textContent).toContain(
        'Telefoni se sami odjavljuju',
      );
    });
  });

  // ---- Ten rows a page ---------------------------------------------------------------------------

  describe('paging', () => {
    /** More customers than fit on a page, generated so a row can be named exactly. */
    function customers(size: number): PlatformCompanyResponse[] {
      return Array.from({ length: size }, (_, index) => {
        const n = String(index + 1).padStart(2, '0');
        return {
          id: `77777777-7777-7777-7777-0000000000${n}`,
          name: `Gradnja ${n} d.o.o.`,
          created_at: '2026-08-05T09:00:00.000Z',
          suspended_at: null,
          user_count: 2,
          active_user_count: 2,
        };
      });
    }

    function pages(): string[] {
      return [...element.querySelectorAll('.pager__page')].map((n) => n.textContent?.trim() ?? '');
    }

    async function goToPage(number: string): Promise<void> {
      const target = [...element.querySelectorAll<HTMLButtonElement>('.pager__page')].find(
        (candidate) => candidate.textContent?.trim() === number,
      );
      if (!target) {
        throw new Error(`no page control reading "${number}"; there are: ${pages().join(', ')}`);
      }
      target.click();
      await settle();
    }

    it('draws ten customers to a page', async () => {
      gateway.extraCompanies.push(...customers(14));
      await render();

      expect(listedNames()).toHaveLength(10);
      expect(pages()).toEqual(['1', '2']);
      expect(element.querySelector('.table-bar')?.textContent).toContain('Prikazano 1–10 od 16');
    });

    it('moves to the second page and draws the rest of them', async () => {
      gateway.extraCompanies.push(...customers(14));
      await render();

      await goToPage('2');

      expect(listedNames()).toHaveLength(6);
      expect(element.querySelector('.table-bar')?.textContent).toContain('Prikazano 11–16 od 16');
    });

    /**
     * **The rewind matters most on this screen**, because the button beside a customer's name
     * suspends him: a founder standing on page 2 of an answer to a question he asked on page 1 is a
     * founder acting on a row he did not mean to be looking at.
     */
    it('goes back to the first page the moment the list becomes a different list', async () => {
      gateway.extraCompanies.push(...customers(14));
      await render();
      await goToPage('2');

      await filterBy('Firma', 'gradnja');

      expect(element.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('1');
      expect(listedNames()[0]).toBe('Gradnja 01 d.o.o.');
    });

    it('goes back to the first page when the order is changed', async () => {
      gateway.extraCompanies.push(...customers(14));
      await render();
      await goToPage('2');

      await sortByColumn('Firma');

      expect(element.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('1');
    });

    it('says which slice of which total, without letting paging look like filtering', async () => {
      gateway.extraCompanies.push(...customers(14));
      await render();

      await filterBy('Firma', 'gradnja');

      const bar = element.querySelector('.table-bar');
      expect(bar?.textContent).toContain('Prikazano 1–10 od 14');
      expect(bar?.textContent).toContain('filtrirano iz 16');
    });

    it('draws no pager over two customers, and still says how many', async () => {
      await render();

      expect(element.querySelector('.pager')).toBeNull();
      expect(element.querySelector('.table-bar')?.textContent).toContain('Ukupno 2');
    });
  });
});
