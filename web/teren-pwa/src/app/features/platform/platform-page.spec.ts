import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { MockPlatformGateway } from '../../core/platform/mock-platform-gateway';
import { PlatformUserResponse } from '../../core/platform/platform-types';
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
  // Null by construction: `ck_app_user_company_scope` makes a super admin inside a tenant
  // unstorable, and that constraint is what the add dialog's two tabs are about.
  companyId: null,
  companyName: null,
  signedInAt: '2026-09-01T08:00:00.000Z',
};

describe('PlatformPage', () => {
  let fixture: ComponentFixture<PlatformPage>;
  let element: HTMLElement;
  let router: Router;
  let gateway: KnobbedPlatformGateway;
  let writeText: ReturnType<typeof vi.fn>;

  /** Stubbed the way the office screens stub it: the device class decides what is rendered. */
  const viewport = { atLeastMedium: () => true, expanded: () => true };

  /**
   * The customers' own URL, resolved from the shipped table by the component class.
   *
   * Never spelled out. `platform/companies` renamed without this call site is precisely the F4b
   * defect — a navigation that builds clean, type-checks, and drops the founder on Home through
   * the wildcard.
   */
  let companiesUrl: string;

  beforeAll(async () => {
    companiesUrl = await routeUrlFor(CompaniesPage);
  });

  /**
   * Boot the screen against the knobbed backend.
   *
   * The **real** `PlatformService` and the **real** `AdminSessionService` are used, seeded through
   * `localStorage`: the narrowing between a wire response and a row on the glass, and the "is
   * anybody signed in" question that decides whether a request is sent at all, are both part of
   * what this screen has to get right.
   */
  async function render(signedIn = true): Promise<void> {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(STAFF));
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        PlatformPage,
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

    fixture = TestBed.createComponent(PlatformPage);
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

  /** A button by what it says — its label **or its accessible name**, since the head row is icons. */
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
   * Sort by a column, through its heading — never through `press(label)`, which matches any button
   * whose text or accessible name contains the string and would find the chrome's own controls
   * first on a screen where a column is headed *Firma* and an icon is labelled *Firme*.
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

  /**
   * Type into one column's filter box, through the control the founder actually uses: open the
   * column's menu from its funnel, then type.
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

  /** The group bands the directory is drawing, as a screen reader would read them out. */
  function groupBands(): string[] {
    return [...element.querySelectorAll('.group__label')].map(
      (node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
  }

  /** The names the directory is drawing, in the order it draws them, whichever rendering is on. */
  function listedNames(): string[] {
    const selector = viewport.atLeastMedium()
      ? 'tr.person .person__name'
      : '.row-button .person__name';
    return [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? '');
  }

  /** One person's row, so an assertion about *this* account cannot be answered by another. */
  function row(name: string): string {
    const selector = viewport.atLeastMedium() ? 'tr.person' : 'li.row';
    const found = [...element.querySelectorAll(selector)].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!found) {
      throw new Error(`no row for ${name}`);
    }
    return found.textContent ?? '';
  }

  function stats(): (string | undefined)[] {
    return [...element.querySelectorAll('.stats__value')].map((node) => node.textContent?.trim());
  }

  function dialog(): HTMLElement | null {
    return element.querySelector('[role="dialog"]');
  }

  /**
   * A button **inside the open dialog**, by what it says.
   *
   * Scoped deliberately: the head cluster's "Dodaj osobu" and the dialog's own controls share a
   * document, and a screen-wide search that found the wrong one would re-open the dialog instead of
   * submitting it — a spec that passes while asserting nothing.
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

  async function type(selector: string, value: string): Promise<void> {
    const input = element.querySelector<HTMLInputElement>(selector);
    if (!input) {
      throw new Error(`no input matching ${selector}`);
    }
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  /**
   * Pick a customer the way the founder does: open the list, click the row that says his name.
   *
   * **By name, not by id.** It used to set `.value` on a `<select>` and fire a `change`, which was
   * the only handle a native control offered — and which asserted nothing about whether the option
   * was reachable, labelled, or even rendered. `app-select-field` is a listbox, so the spec can
   * now do what a person does, and the name is what a person sees. A customer missing from the
   * list, or listed under the wrong name, fails here instead of passing.
   */
  async function chooseCustomer(name: string): Promise<void> {
    const combobox = element.querySelector<HTMLButtonElement>('[role="combobox"]');
    if (!combobox) {
      throw new Error('no customer dropdown on this dialog');
    }
    combobox.click();
    await settle();

    const option = Array.from(element.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (row) => row.textContent?.includes(name),
    );
    if (!option) {
      throw new Error(`no customer named ${name} in the dropdown`);
    }
    option.click();
    await settle();
  }

  function stubClipboard(impl: () => Promise<void> = () => Promise.resolve()): void {
    writeText = vi.fn(impl);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    gateway = new KnobbedPlatformGateway();
    viewport.atLeastMedium = () => true;
    viewport.expanded = () => true;
    stubClipboard();
  });

  afterEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  // ---- Reading the directory -------------------------------------------------------------------

  describe('the directory', () => {
    it('resolves the loading state into every account in the product, grouped by reach', async () => {
      await render();

      expect(text()).not.toContain('Učitavanje naloga…');

      // Staff, then the customers' administrators, then the foremen — the order of reach.
      expect(text()).toContain('Teren tim');
      expect(text()).toContain('Milovan Miletić');
      expect(text()).toContain('Administratori firmi');
      expect(text()).toContain('Petar Petrović');
      expect(text()).toContain('Poslovođe');
      expect(text()).toContain('Zoran Jovanović');

      const groups = [...element.querySelectorAll('.group__label')].map((node) =>
        node.textContent?.trim(),
      );
      expect(groups).toEqual(['Teren tim', 'Administratori firmi', 'Poslovođe']);
    });

    it('renders Serbian by default — the founder reads this screen', async () => {
      await render();

      expect(text()).toContain('Platforma');
      expect(text()).not.toContain('Everyone in the app');
    });

    it('names the customer each account belongs to, and says so when there is none', async () => {
      await render();

      expect(row('Petar Petrović')).toContain('Vodoinstal Petrović d.o.o.');
      // Staff belong to no customer. An em-dash says that; an empty cell would read as a name the
      // screen failed to load.
      expect(row('Milovan Miletić')).toContain('—');
    });

    /** The handle under a name is what the founder searches on and what an invite would go to. */
    it('shows the address that identifies each account', async () => {
      await render();

      expect(row('Milovan Miletić')).toContain('osnivac@teren.rs');
      expect(row('Zoran Jovanović')).toContain('zoran.jovanovic@vodoinstal-petrovic.example.com');
    });

    /**
     * The third number is the one that matters, and **workers are excluded from it deliberately**:
     * a foreman's password is unstorable by constraint, so counting him would put a permanent,
     * unfixable number on the founder's screen. Both pending accounts here are pending; only one
     * of them is an administrator, so this reads 1 and not 2.
     */
    it('counts staff, administrators, and only the administrators nobody has finished', async () => {
      await render();

      expect(stats()).toEqual(['1', '1', '1']);
    });

    /**
     * **A foreman is `passwordPending` for ever, and it must never read as a problem.** The chip an
     * unfinished administrator gets would otherwise sit beside every foreman on the platform.
     */
    it('never tells the founder a foreman has not signed in', async () => {
      await render();

      expect(row('Petar Petrović')).toContain('Nije se prijavio');
      expect(row('Zoran Jovanović')).not.toContain('Nije se prijavio');
      expect(row('Zoran Jovanović')).not.toContain('Aktivan');
      expect(row('Milovan Miletić')).toContain('Aktivan');
    });

    it('draws a list rather than a table below 768', async () => {
      viewport.atLeastMedium = () => false;
      await render();

      expect(element.querySelector('table')).toBeNull();
      expect(element.querySelectorAll('li.row').length).toBe(3);
      expect(row('Milovan Miletić')).toContain('Bez firme');
    });

    /**
     * The constraint that decides where the session control may live: the app header is
     * `display: none` below 768, and a member of staff does reach this screen on a phone. A
     * header-only sign-out would strand him with no way to end a password-backed session.
     */
    it('keeps a way out on a phone, where the header does not exist', async () => {
      await render();

      expect(element.querySelector('.bar--compact app-session-link')).not.toBeNull();
      expect(element.querySelector('app-header app-session-link')).not.toBeNull();
    });

    it('reloads the list on demand', async () => {
      await render();
      expect(gateway.userListings).toBe(1);

      element.querySelector<HTMLButtonElement>('.head__reload')?.click();
      await settle();

      expect(gateway.userListings).toBe(2);
      expect(text()).toContain('Milovan Miletić');
    });

    it('opens the customers by the path the route table registers', async () => {
      await render();

      await press('Firme');

      expect(router.navigate).toHaveBeenCalledWith([companiesUrl]);
    });
  });

  // ---- When the server did not answer -----------------------------------------------------------

  describe('a directory that could not be confirmed', () => {
    /**
     * A directory that is short because a request failed and one that is short because the product
     * is small look identical unless the screen says which it is.
     */
    it('says the server was not reached, and refuses to print three noughts under it', async () => {
      gateway.usersError = platformHttpError(500);
      await render();

      expect(text()).toContain('Nije provereno na serveru');
      expect(text()).toContain('Server trenutno ne odgovara.');
      // Em-dashes, not zeros: three noughts under that banner is the screen contradicting itself.
      expect(stats()).toEqual(['—', '—', '—']);
    });

    /** 401 and 403 are the split the taxonomy exists for; the remedies are different. */
    it('tells an expired sign-in from a role that may not do this', async () => {
      gateway.usersError = platformHttpError(401);
      await render();
      expect(text()).toContain('Prijava je istekla. Prijavite se ponovo.');

      gateway = new KnobbedPlatformGateway();
      gateway.usersError = platformHttpError(403);
      await render();
      expect(text()).toContain('Vaša uloga ovo ne može da uradi.');
      expect(text()).not.toContain('Prijava je istekla.');
    });

    it('says there is no internet rather than that the product is empty', async () => {
      gateway.usersError = platformHttpError(0);
      await render();

      expect(text()).toContain('Nema interneta. Ništa nije stiglo do servera.');
    });

    it('sends nothing at all when this browser holds no admin credential', async () => {
      await render(false);

      expect(text()).toContain('Niste prijavljeni.');
      expect(gateway.userListings).toBe(0);
      expect(gateway.companyListings).toBe(0);
    });

    /**
     * The people list *is* the screen. A customers list that failed on its own costs the add dialog
     * its dropdown and nothing else — saying "the server is unwell" over a directory that loaded
     * perfectly well would be the screen claiming something it does not know.
     */
    it('does not call the directory stale because only the customers failed', async () => {
      gateway.companiesError = platformHttpError(500);
      await render();

      expect(text()).not.toContain('Nije provereno na serveru');
      expect(stats()).toEqual(['1', '1', '1']);
      expect(text()).toContain('Milovan Miletić');
    });
  });

  // ---- Sorting -----------------------------------------------------------------------------------

  describe('sorting', () => {
    it('starts on state, and says which column is ordered to a screen reader', async () => {
      await render();

      expect(element.querySelector('.col--state')?.getAttribute('aria-sort')).toBe('ascending');
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('none');
    });

    it('turns a column round on a second tap, and only one column is ever the sorted one', async () => {
      await render();

      await sortByColumn('Osoba');
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('ascending');
      expect(element.querySelector('.col--state')?.getAttribute('aria-sort')).toBe('none');

      await sortByColumn('Osoba');
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('descending');
    });

    /**
     * The sort lives in the component. A query parameter per tap would re-run the route gate and
     * re-read every account in the product to paint the same rows in a different order.
     */
    it('does not navigate, and does not re-read the server, to reorder rows', async () => {
      await render();

      await sortByColumn('Firma');

      expect(router.navigate).not.toHaveBeenCalled();
      expect(gateway.userListings).toBe(1);
    });
  });

  // ---- Filtering -------------------------------------------------------------------------------

  /**
   * The other half of the founder's 2026-09-02 note: *"one standard option beside all columns so I
   * can filter or sort... super admin will have more than 10 clients hopefully"*. Three accounts
   * need no filter; sixty do, and the screen that lists them is the one he opens to answer "did
   * that admin ever set his password?".
   */
  describe('filtering', () => {
    it('narrows the directory to the account he is looking for', async () => {
      await render();

      await filterBy('Osoba', 'petar');

      expect(listedNames()).toEqual(['Petar Petrović']);
      // A group with nothing left in it takes its heading with it, rather than printing a band
      // over air that reads as rows which failed to load. Asserted on the bands themselves: the
      // words "Teren tim" are also this screen's subtitle and one of its three summary labels.
      expect(groupBands()).toEqual(['Administratori firmi']);
    });

    /** An address is what a support message carries, so the name column matches on it too. */
    it('finds a man by the address under his name', async () => {
      await render();

      await filterBy('Osoba', 'zoran.jovanovic');

      expect(listedNames()).toEqual(['Zoran Jovanović']);
    });

    /** One customer's people, which is the question a support call actually starts with. */
    it('narrows to one customer’s people, diacritics or not', async () => {
      await render();

      await filterBy('Firma', 'petrovic');

      expect(listedNames()).toEqual(['Petar Petrović', 'Zoran Jovanović']);
    });

    it('says how much it is hiding, and offers one tap back to everybody', async () => {
      await render();

      await filterBy('Osoba', 'petar');
      expect(element.querySelector('.table-bar')?.textContent).toContain('Prikazano 1 od 3');

      await press('Prikaži sve');

      expect(listedNames()).toEqual(['Milovan Miletić', 'Petar Petrović', 'Zoran Jovanović']);
      // The strip stays and goes quiet — see `company-page.spec.ts`, which reasons it out: the
      // count is printed always since paging, and the tint goes on meaning one thing only.
      const cleared = element.querySelector('.table-bar');
      expect(cleared?.classList.contains('table-bar--quiet')).toBe(true);
      expect(cleared?.textContent).toContain('Ukupno 3');
      expect(text()).not.toContain('Prikaži sve');
    });

    it('says a filter is why the directory is empty, not that the product is', async () => {
      await render();

      await filterBy('Osoba', 'nikola');

      expect(listedNames()).toEqual([]);
      expect(text()).toContain('Nijedan red ne odgovara filteru.');
      expect(text()).not.toContain('Još nema naloga.');
    });

    it('gives the phone the same controls, as pills', async () => {
      viewport.atLeastMedium = () => false;
      await render();

      expect(element.querySelectorAll('.column-bar app-column-menu').length).toBe(3);

      await filterBy('Osoba', 'petar');
      expect(listedNames()).toEqual(['Petar Petrović']);
    });

    it('does not navigate, and does not re-read the server, to hide a row', async () => {
      await render();

      await filterBy('Osoba', 'petar');

      expect(router.navigate).not.toHaveBeenCalled();
      expect(gateway.userListings).toBe(1);
    });
  });

  // ---- The add dialog ----------------------------------------------------------------------------

  describe('adding a person', () => {
    async function openAdd(): Promise<void> {
      await press('Dodaj osobu');
    }

    it('is a labelled modal dialog with two tabs, starting on the customer’s administrator', async () => {
      await render();
      expect(dialog()).toBeNull();

      await openAdd();

      const panel = dialog();
      expect(panel?.getAttribute('aria-modal')).toBe('true');
      expect(panel?.getAttribute('aria-label')).toBe('Dodaj osobu');
      expect(panel?.querySelectorAll('[role="tab"]').length).toBe(2);
      expect(inDialog('Admin firme').getAttribute('aria-selected')).toBe('true');
      expect(inDialog('Teren tim').getAttribute('aria-selected')).toBe('false');
      // A company admin needs a company; the field is on this tab and only this tab.
      expect(element.querySelector('[role="combobox"]')).not.toBeNull();
    });

    it('has no company field for a member of staff, because he must not have one', async () => {
      await render();
      await openAdd();

      await pressIn('Teren tim');

      expect(inDialog('Teren tim').getAttribute('aria-selected')).toBe('true');
      expect(element.querySelector('#platform-add-company')).toBeNull();
      expect(text()).toContain('Teren tim vidi sve naloge i sve firme.');
    });

    /**
     * **Switching tabs clears the company.** Not tidiness: `ck_app_user_company_scope` makes a
     * super admin inside a tenant unstorable, so a company id left behind from the other tab is a
     * 400 the founder could not account for — the field that caused it is no longer on screen.
     */
    it('sends no company for a member of staff, even after one was chosen on the other tab', async () => {
      await render();
      await openAdd();
      await chooseCustomer('Vodoinstal Petrović d.o.o.');

      await pressIn('Teren tim');
      await type('#platform-add-name', 'Nova Kolegica');
      await type('#platform-add-email', 'nova@teren.rs');
      await pressIn('Dodaj i pošalji poziv');

      expect(gateway.createdAdmins).toEqual([
        { role: 'super_admin', display_name: 'Nova Kolegica', email: 'nova@teren.rs' },
      ]);
      expect(gateway.createdAdmins[0]).not.toHaveProperty('company_id');
    });

    it('forgets the company on the way back too, so nothing stale can be submitted', async () => {
      await render();
      await openAdd();
      await chooseCustomer('Vodoinstal Petrović d.o.o.');

      await pressIn('Teren tim');
      await pressIn('Admin firme');

      // The dropdown is back to its placeholder, which is what "nothing is chosen" now looks like:
      // `app-select-field` has no `value` to read, it says the choice or it says the invitation.
      expect(
        element.querySelector('[role="combobox"]')?.textContent,
        'the dropdown came back still naming a customer nothing had chosen',
      ).toContain('Izaberite firmu');
      // And with no company the form cannot fire at all — the 400 arrives as a disabled button.
      await type('#platform-add-name', 'Jovan Jovanović');
      await type('#platform-add-email', 'jovan@firma.rs');
      expect(inDialog('Dodaj i pošalji poziv').disabled).toBe(true);

      element.querySelector('form')?.dispatchEvent(new Event('submit'));
      await settle();
      expect(gateway.createdAdmins).toEqual([]);
    });

    it('will not send a nameless or address-less person, and says so by refusing the button', async () => {
      await render();
      await openAdd();
      await chooseCustomer('Vodoinstal Petrović d.o.o.');

      expect(inDialog('Dodaj i pošalji poziv').disabled).toBe(true);

      await type('#platform-add-name', 'Jovan Jovanović');
      expect(inDialog('Dodaj i pošalji poziv').disabled).toBe(true);

      await type('#platform-add-email', 'jovan@firma.rs');
      expect(inDialog('Dodaj i pošalji poziv').disabled).toBe(false);
    });

    /**
     * **The dialog stays open on success and says what happened.** It used to show the
     * set-password link, which was the entire onboarding when there was no relay. There is one
     * now, the link is minted on the server inside the job that mails it, and the only honest
     * thing this screen can report is the address it went to.
     */
    it('says the invite was emailed, and shows no credential at all', async () => {
      await render();
      await openAdd();
      await chooseCustomer('Vodoinstal Petrović d.o.o.');
      await type('#platform-add-name', 'Jovan Jovanović');
      await type('#platform-add-email', 'jovan@firma.rs');

      await pressIn('Dodaj i pošalji poziv');

      expect(dialog()).not.toBeNull();
      expect(text()).toContain('Jovan Jovanović je dodat.');
      expect(text()).toContain('jovan@firma.rs');

      // The assertion that matters, and it is written against the rendered screen rather than a
      // named element: nothing token-shaped may appear anywhere on it.
      expect(text()).not.toContain('trn_p_');
      expect(element.querySelector('.issued__link')).toBeNull();

      // The form is gone: there is nothing left to fill in.
      expect(element.querySelector('#platform-add-name')).toBeNull();
    });

    it('re-reads the directory so the new account is on it', async () => {
      await render();
      await openAdd();
      await chooseCustomer('Vodoinstal Petrović d.o.o.');
      await type('#platform-add-name', 'Jovan Jovanović');
      await type('#platform-add-email', 'jovan@firma.rs');

      await pressIn('Dodaj i pošalji poziv');

      expect(gateway.userListings).toBe(2);
      // On the directory itself, not merely in the dialog that created him.
      expect(row('Jovan Jovanović')).toContain('jovan@firma.rs');
    });

    /**
     * With no relay the account exists and nobody can get into it, so the dialog says so. The
     * failure mode this prevents is the quiet one: a founder who believes a mail is on its way and
     * a customer who waits for it.
     */
    it('says plainly when nothing was sent', async () => {
      gateway.emailed = false;
      await render();
      await openAdd();
      await chooseCustomer('Vodoinstal Petrović d.o.o.');
      await type('#platform-add-name', 'Jovan Jovanović');
      await type('#platform-add-email', 'jovan@firma.rs');

      await pressIn('Dodaj i pošalji poziv');

      expect(text()).toContain('nije podešeno');
      expect(text()).not.toContain('Poslali smo');
    });

    it('starts clean every time it is opened, so no link outlives its dialog', async () => {
      await render();
      await openAdd();
      await chooseCustomer('Vodoinstal Petrović d.o.o.');
      await type('#platform-add-name', 'Jovan Jovanović');
      await type('#platform-add-email', 'jovan@firma.rs');
      await pressIn('Dodaj i pošalji poziv');
      await pressIn('Gotovo');

      await openAdd();

      expect(text()).not.toContain('NJEGOV LINK');
      expect(element.querySelector<HTMLInputElement>('#platform-add-name')?.value).toBe('');
      expect(inDialog('Admin firme').getAttribute('aria-selected')).toBe('true');
    });
  });

  // ---- When the create failed ---------------------------------------------------------------------

  describe('a create that did not work', () => {
    async function attempt(): Promise<void> {
      await render();
      await press('Dodaj osobu');
      await pressIn('Teren tim');
      await type('#platform-add-name', 'Nova Kolegica');
      await type('#platform-add-email', 'nova@teren.rs');
      await pressIn('Dodaj i pošalji poziv');
    }

    /**
     * A 409 on create is the one refusal the founder fixes without leaving the form, so it says
     * which address and what to do instead of it.
     */
    it('names a taken address, and keeps the form up so it can be corrected', async () => {
      gateway.createAdminError = platformHttpError(409);
      await attempt();

      expect(text()).toContain('Osoba nije mogla da se doda');
      expect(text()).toContain(
        'Ta adresa već ima nalog. Pozovite taj nalog umesto pravljenja drugog.',
      );
      expect(element.querySelector('#platform-add-name')).not.toBeNull();
      expect(text()).not.toContain('NJEGOV LINK');
    });

    /**
     * `serverAnswered`, on the one mutation this screen performs. A `POST /api/platform/users` that
     * got no verdict **may well have created the account and minted its link** — telling the
     * founder it failed invites a second press and a second account on the same address.
     */
    it('does not call an unanswered create a failure', async () => {
      gateway.createAdminError = platformHttpError(500);
      await attempt();

      expect(text()).toContain(
        'Server nije odgovorio, pa se ne zna da li je nalog napravljen. Osvežite pre nego što pokušate ponovo.',
      );
      expect(text()).not.toContain('Server trenutno ne odgovara.');
    });

    it('says plainly when the server refused, because then nothing changed', async () => {
      gateway.createAdminError = platformHttpError(403);
      await attempt();

      expect(text()).toContain('Vaša uloga ovo ne može da uradi.');
      expect(text()).not.toContain('Server nije odgovorio');
    });

    it('clears the complaint when the tab changes, because that is a different request', async () => {
      gateway.createAdminError = platformHttpError(409);
      await attempt();
      expect(text()).toContain('Ta adresa već ima nalog.');

      await pressIn('Admin firme');

      expect(text()).not.toContain('Ta adresa već ima nalog.');
    });
  });

  // ---- The info popover ----------------------------------------------------------------------------

  describe('the info popover', () => {
    /**
     * The founder asked for hover, and hover is right on a mouse. It is also the one gesture a
     * phone does not have, and a member of staff does reach this screen on a phone. jsdom reports
     * no fine pointer, which is exactly the phone's case — so what this exercises is the tap path.
     */
    it('explains what this surface may see, on a tap', async () => {
      await render();

      expect(text()).not.toContain('nikada transkript');

      await press('Šta se ovde vidi');

      expect(element.querySelector('.pop')?.textContent).toContain(
        'nikada transkript, fotografiju ili izveštaj',
      );
    });
  });

  // ---- Ten rows a page ---------------------------------------------------------------------------

  describe('paging', () => {
    /**
     * Foremen at one customer, generated rather than written out.
     *
     * Workers, because the fixture's three accounts are one of each role and a generated crew keeps
     * the three group bands meaningful: staff and administrators stay small, and it is the foremen
     * band that grows past a page — which is what the founder's directory will actually look like.
     */
    function crew(size: number): PlatformUserResponse[] {
      return Array.from({ length: size }, (_, index) => {
        const n = String(index + 1).padStart(2, '0');
        return {
          id: `66666666-6666-6666-6666-0000000000${n}`,
          company_id: MockPlatformGateway.VODOINSTAL_ID,
          company_name: 'Vodoinstal Petrović d.o.o.',
          role: 'worker',
          username: `radnik.${n}`,
          display_name: `Radnik ${n}`,
          email: null,
          language: 'sr',
          created_at: '2026-08-02T06:15:00.000Z',
          last_login_at: null,
          disabled_at: null,
          password_pending: true,
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

    /**
     * A second member of Teren's own staff, named so he sorts **last** alphabetically.
     *
     * The whole point of him. With seventeen accounts and the page cut from a flat sort, staff
     * whose names fall late in the alphabet land on page 2 — and a first page of the *accounts
     * directory* with no `Teren tim` band on it tells the founder Teren has no staff. `Ž` is the
     * last letter of the Serbian Latin alphabet, so this fixture fails on any order that is not the
     * drawn one.
     */
    function lateStaff(): PlatformUserResponse {
      return {
        id: '88888888-8888-8888-8888-000000000001',
        company_id: null,
        company_name: null,
        role: 'super_admin',
        username: null,
        display_name: 'Živko Žikić',
        email: 'zivko@teren.rs',
        language: 'sr',
        created_at: '2026-07-02T08:00:00.000Z',
        last_login_at: '2026-09-01T07:30:00.000Z',
        disabled_at: null,
        password_pending: false,
      };
    }

    /** The band each drawn row belongs under, read off the table as a screen reader would. */
    function bandOfEachRow(): string[] {
      const bands: string[] = [];
      let current = '';
      for (const node of element.querySelectorAll('tbody tr')) {
        const label = node.querySelector('.group__label');
        if (label) {
          current = label.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        } else if (node.classList.contains('person')) {
          bands.push(current);
        }
      }
      return bands;
    }

    /**
     * **The page is cut from the order the screen draws, not from the order it sorts.**
     *
     * Until the review of 2026-09-02 it was cut from a flat sort and only then regrouped, so a
     * page's membership came from the sort and its order came from the band — two orders, one
     * screen. Driven at 1280 this left the founder's own staff on page 2 with no `Teren tim` band
     * on page 1 at all, and gave a page reading V, Z, S, T, U, L, M under a column head claiming
     * ascending.
     *
     * Both halves are asserted, because each fails on its own: the staff band is **on page 1**,
     * and the bands the rows fall under are **contiguous and in reach order** rather than
     * interleaved.
     */
    it('cuts the page from the drawn order, so the first band is never left behind', async () => {
      gateway.extraUsers.push(lateStaff(), ...crew(14));
      await render();

      expect(groupBands()[0]).toBe('Teren tim');
      expect(listedNames().slice(0, 2)).toEqual(['Milovan Miletić', 'Živko Žikić']);

      // Contiguous: every band appears as one unbroken run, in reach order.
      const bands = bandOfEachRow();
      expect(bands).toEqual(
        [...bands].sort((a, b) => groupBands().indexOf(a) - groupBands().indexOf(b)),
      );
      expect(new Set(bands).size).toBe(groupBands().length);
    });

    /** The same, with the name sort the reviewer drove — the order a column head is claiming. */
    it('keeps each band’s own order under the column head that claims it', async () => {
      gateway.extraUsers.push(lateStaff(), ...crew(14));
      await render();

      await sortByColumn('Osoba');

      // Staff A→Ž first, then the administrators, then the foremen — never one flat alphabet
      // sliced and shuffled back into bands.
      expect(groupBands()[0]).toBe('Teren tim');
      expect(listedNames().slice(0, 3)).toEqual([
        'Milovan Miletić',
        'Živko Žikić',
        'Petar Petrović',
      ]);
    });

    /**
     * **Ten accounts a page, cut through the groups rather than inside them.**
     *
     * A page size applied per group would draw up to thirty rows under a control promising ten, and
     * the strip above it would be describing a screen nobody was looking at.
     */
    it('draws ten accounts to a page, across the bands', async () => {
      gateway.extraUsers.push(...crew(14));
      await render();

      expect(listedNames()).toHaveLength(10);
      expect(pages()).toEqual(['1', '2']);
      expect(element.querySelector('.table-bar')?.textContent).toContain('Prikazano 1–10 od 17');
    });

    /** A page holding only foremen prints one band, not three — the bands come from the slice. */
    it('draws only the bands the page actually has people in', async () => {
      gateway.extraUsers.push(...crew(14));
      await render();

      await goToPage('2');

      expect(listedNames()).toHaveLength(7);
      expect(groupBands()).toEqual(['Poslovođe']);
      expect(element.querySelector('.table-bar')?.textContent).toContain('Prikazano 11–17 od 17');
    });

    /** The rewind: an answer to a question he has just asked belongs on the first page. */
    it('goes back to the first page the moment the directory becomes a different list', async () => {
      gateway.extraUsers.push(...crew(14));
      await render();
      await goToPage('2');

      await filterBy('Osoba', 'radnik');

      expect(element.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('1');
      expect(listedNames()[0]).toBe('Radnik 01');
    });

    it('goes back to the first page when the order is changed', async () => {
      gateway.extraUsers.push(...crew(14));
      await render();
      await goToPage('2');

      await sortByColumn('Osoba');

      expect(element.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('1');
    });

    /** The two totals stay apart: what is on the glass, what answers the filter, what exists. */
    it('says which slice of which total, without letting paging look like filtering', async () => {
      gateway.extraUsers.push(...crew(14));
      await render();

      await filterBy('Osoba', 'radnik');

      const bar = element.querySelector('.table-bar');
      expect(bar?.textContent).toContain('Prikazano 1–10 od 14');
      expect(bar?.textContent).toContain('filtrirano iz 17');
    });

    it('draws no pager over a directory that fits on one page, and still says how many', async () => {
      await render();

      expect(element.querySelector('.pager')).toBeNull();
      expect(element.querySelector('.table-bar')?.textContent).toContain('Ukupno 3');
    });
  });
});
