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

      await press('Ljudi');

      expect(router.navigate).toHaveBeenCalledWith([peopleUrl]);
    });

    it('keeps a way out on a phone, where the header does not exist', async () => {
      await render();

      expect(element.querySelector('.bar--compact app-session-link')).not.toBeNull();
      expect(element.querySelector('app-header app-session-link')).not.toBeNull();
    });
  });

  // ---- Adding a customer --------------------------------------------------------------------------

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

      expect(text()).not.toContain('Poslovođe i dalje mogu da snimaju');

      await press('Šta radi suspenzija');

      expect(element.querySelector('.pop')?.textContent).toContain(
        'Poslovođe i dalje mogu da snimaju',
      );
    });
  });
});
