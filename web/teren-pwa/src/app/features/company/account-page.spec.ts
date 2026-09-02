import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { COMPANY_GATEWAY } from '../../core/company/company-gateway';
import { MockCompanyGateway } from '../../core/company/mock-company-gateway';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import { KnobbedGateway, httpError } from '../../testing/company-gateway-double';
import { routeUrlFor } from '../../testing/route-table';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { AccountPage } from './account-page';
import { CompanyPage } from './company-page';

/** A signed-in owner, exactly as `POST /auth/login` left him in this browser. */
const ADMIN: AdminSession = {
  token: 'trn_s_a-real-admin-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'company_admin',
  userId: '99999999-9999-9999-9999-999999999999',
  displayName: 'Milan Gradnja',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Firma iz sesije d.o.o.',
  signedInAt: '2026-08-31T08:00:00.000Z',
};

/**
 * The company admin's own account (`/company/profile`).
 *
 * The property under test throughout is the one this screen shares with the worker's profile and
 * gets wrong in a different way: **it has two sources and must never blur them**. The server is the
 * truth; the credential this browser stored at sign-in is what it knows with no network; and
 * whenever the server was not reached the screen says so *before* it says anything else. A company
 * name remembered from a sign-in three weeks ago reads exactly like a current one otherwise.
 */
describe('AccountPage', () => {
  let fixture: ComponentFixture<AccountPage>;
  let element: HTMLElement;
  let gateway: KnobbedGateway;

  /** The people list's own URL, resolved from the shipped route table rather than spelled out. */
  let people: string;

  beforeAll(async () => {
    people = await routeUrlFor(CompanyPage);
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    gateway = new KnobbedGateway();
  });

  afterEach(() => localStorage.clear());

  async function render(signedIn = true): Promise<void> {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(ADMIN));
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        AccountPage,
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
      providers: [provideRouter([]), { provide: COMPANY_GATEWAY, useValue: gateway }],
    });

    fixture = TestBed.createComponent(AccountPage);
    element = fixture.nativeElement as HTMLElement;
    await settle();
  }

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
      throw new Error(`no button reading "${label}" on screen`);
    }
    return found;
  }

  it('shows the account the server described, not the one the browser remembered', async () => {
    await render();

    expect(text()).toContain('Petar Petrović');
    expect(text()).toContain(MockCompanyGateway.ADMIN_EMAIL);
    // The server's company name, not `ADMIN.companyName` — the session is a fallback, never a
    // source that competes with an answer.
    expect(text()).toContain('Vodoinstal Petrović d.o.o.');
    expect(text()).not.toContain('Firma iz sesije');
    expect(text()).toContain('Vlasnik firme');
  });

  it('reads the account through the office gateway, which carries the admin bearer', async () => {
    await render();

    // The one assertion that pins the credential. `ProfileService` asks the same route through
    // `TerenApiClient`, which sends the *device* token — on this screen that would either 401 or,
    // on the founder's own browser, quietly describe the demo phone's foreman instead of the owner.
    expect(gateway.real.meCalls).toBe(1);
  });

  it('says the server was not reached, and falls back to what this browser knows', async () => {
    gateway.meError = httpError(503);
    await render();

    expect(text()).toContain('Nije provereno na serveru');
    // The session's own copy, and it is labelled as unconfirmed above rather than presented as
    // current.
    expect(text()).toContain('Milan Gradnja');
    expect(text()).toContain('Firma iz sesije d.o.o.');
  });

  it('never fills in the address from anywhere, because the session has none', async () => {
    gateway.meError = httpError(503);
    await render();

    // `AdminSession` does not carry an email, and the screen must not invent one from the name or
    // leave the previous value on screen. A visible "no address on file" is the honest answer.
    expect(text()).toContain('Nema sačuvane imejl adrese');
    expect(text()).not.toContain('@');
  });

  it('says plainly when nothing was confirmed and nothing is remembered', async () => {
    gateway.meError = httpError(503);
    await render(false);

    expect(text()).toContain('Nalog nije mogao da se pročita');
    // Not an empty card: an account that failed to load and an account with nothing in it look
    // identical unless one of them says which it is.
    expect(text()).not.toContain('Milan Gradnja');
  });

  it('offers no re-activation and no code entry — those belong to a phone', async () => {
    await render();

    // The worker's profile offers `/activate`, because his way back in is a fresh code. An admin
    // has a password and no device, so the same control here would be a door to a screen his
    // credential cannot use.
    expect(text()).not.toContain('Unesite novi kod');
    expect(text()).not.toContain('Novi telefon');
  });

  it('goes back to the people, and to the route the table actually ships', async () => {
    await render();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    button('Vrati se na ljude').click();

    expect(navigate).toHaveBeenCalledWith([people]);
  });

  it('re-reads the account when the reload control is pressed', async () => {
    await render();
    expect(gateway.real.meCalls).toBe(1);

    button('Osveži').click();
    await settle();

    expect(gateway.real.meCalls).toBe(2);
  });
});
