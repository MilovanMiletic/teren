import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { MockPlatformGateway } from '../../core/platform/mock-platform-gateway';
import { PLATFORM_GATEWAY } from '../../core/platform/platform-gateway';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import {
  KnobbedPlatformGateway,
  platformHttpError,
} from '../../testing/platform-gateway-double';
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

      await press('Osoba');
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('ascending');
      expect(element.querySelector('.col--state')?.getAttribute('aria-sort')).toBe('none');

      await press('Osoba');
      expect(element.querySelector('.col--person')?.getAttribute('aria-sort')).toBe('descending');
    });

    /**
     * The sort lives in the component. A query parameter per tap would re-run the route gate and
     * re-read every account in the product to paint the same rows in a different order.
     */
    it('does not navigate, and does not re-read the server, to reorder rows', async () => {
      await render();

      await press('Firma');

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
      expect(text()).toContain('Ta adresa već ima nalog. Pozovite taj nalog umesto pravljenja drugog.');
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
});
