import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { COMPANY_GATEWAY } from '../../core/company/company-gateway';
import { MockCompanyGateway } from '../../core/company/mock-company-gateway';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import { SESSION_STORAGE_KEY, Session } from '../../core/session/session';
import { KnobbedGateway, deferred, httpError } from '../../testing/company-gateway-double';
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
 * **The founder's own browser**: a phone activated as a device *and* signed in as an owner.
 *
 * `company-link.ts` names this population as the one this whole surface is built for, and it is
 * the population `session-link.ts` deliberately renders nothing for — a foreman has no password.
 * That combination is what made the 401 state on this screen a dead end, so it is a fixture.
 */
const DEVICE: Session = {
  token: 'trn_d_a-real-device-token',
  deviceId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  username: 'zoran.jovanovic',
  displayName: 'Zoran Jovanović',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Firma iz sesije d.o.o.',
  activatedAt: '2026-08-30T06:00:00.000Z',
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

  /**
   * @param signedIn whether this browser holds an admin credential.
   * @param onADevice whether it *also* holds a device session — the founder's own browser, and
   *   the case in which the chrome offers no sign-in control of its own.
   */
  async function render(signedIn = true, onADevice = false): Promise<void> {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(ADMIN));
    }
    if (onADevice) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(DEVICE));
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

  /**
   * **The founder's note of 2026-09-02, pinned**: *"we have duplicated stuff for translation here —
   * already have it in the header"*.
   *
   * The switcher belongs to the chrome, and this screen's chrome carries it twice over already: the
   * app header from 768 up, and the compact bar below it, where the header is `display: none`. A
   * third copy inside the content was one setting said three times on one screen. Asserted on the
   * **content** rather than on the document, because the two chrome copies both render here — jsdom
   * applies no media queries, so counting them all would pin the wrong thing.
   */
  it('carries no language control of its own — the chrome already has one at every width', async () => {
    await render();

    expect(element.querySelectorAll('.content app-language-switcher').length).toBe(0);
    // **Exactly two on the whole screen, not "none in the content"**: the header's and the compact
    // bar's, one of which is visible at any width. Counting the whole document rather than the
    // content is what makes a third copy anywhere — including a well-meaning one in the head row —
    // fail this (review, 2026-09-02).
    expect(element.querySelectorAll('app-language-switcher').length).toBe(2);
    expect(element.querySelectorAll('.bar--compact app-language-switcher').length).toBe(1);
  });

  /**
   * Built like the platform's own account screen (founder, same note): the person is the title, a
   * `detail` card carries his chips and a fact list, and an `actions` card beside it carries what
   * applies to him here. The two screens describe the same man to two different readers, and until
   * this they looked like two products.
   */
  it('is shaped like the platform’s account screen, not like a profile of its own', async () => {
    await render();

    expect(element.querySelector('.head__title')?.textContent?.trim()).toBe('Petar Petrović');
    expect(element.querySelector('.card.detail')).not.toBeNull();
    expect(element.querySelector('.card.actions')).not.toBeNull();
    // The label/value pairs the platform draws, in the same order of facts.
    // Sentence case in the dictionary: `.t-label` is what uppercases a label, and four of these
    // keys shouted in the JSON while the rest of the screen's did not (2026-09-02).
    expect(
      [...element.querySelectorAll('.detail .facts__row dt')].map((n) => n.textContent),
    ).toEqual(['Prijavljujete se sa', 'Firma', 'Nalog otvoren', 'Prethodna prijava']);
  });

  /**
   * **The head band names an address only when the server gave one.**
   *
   * `known()` is true from the stored session alone and `email()` is server-only, so the line under
   * his name printed "no address on file" for the length of every fetch — and, in the unreachable
   * state, printed that claim *above* the notice saying nothing had been confirmed. A caveat after
   * the claim it qualifies is not a caveat.
   */
  it('never claims there is no address before the server has answered', async () => {
    gateway.meError = httpError(503);
    await render();

    expect(element.querySelector('.head__sub')).toBeNull();
    // The fact row still says it, once, and it sits below the notice that explains why.
    const notice = text().indexOf('Nije provereno na serveru');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(text().indexOf('Nema sačuvane imejl adrese')).toBeGreaterThan(notice);
  });

  /** The same, in the state every visit passes through: nothing has come back yet. */
  it('says nothing about an address while the account is still loading', async () => {
    // Held open, so the screen is observed in the state it spends its first moments in.
    gateway.meGate = deferred();
    await render();

    expect(text()).toContain('Učitavanje naloga…');
    expect(text()).not.toContain('Nema sačuvane imejl adrese');
    expect(element.querySelector('.head__sub')).toBeNull();

    gateway.meGate.release();
    await settle();
    expect(element.querySelector('.head__sub')?.textContent?.trim()).toBe(
      MockCompanyGateway.ADMIN_EMAIL,
    );
  });

  /**
   * The sentence explaining the address sits **under the address**. At the foot of the card, where
   * the rebuild first put it, "this address and your password" pointed at a timestamp.
   */
  it('keeps the sign-in hint attached to the address it is about', async () => {
    await render();

    const row = element.querySelector('.detail .facts__row');
    expect(row?.textContent).toContain(MockCompanyGateway.ADMIN_EMAIL);
    expect(row?.textContent).toContain('Ova adresa i vaša lozinka');
  });

  /**
   * **A 401 must leave a door, and on the founder's own browser this screen was the only place
   * one could be.**
   *
   * `CompanyService.classify` signs the admin out on a 401 — one `localStorage` row — so `remote`
   * is null, `known()` is false, and the screen takes the empty-state branch. Both sentences it
   * prints there say *sign in again* (`company.reason.signedOut` in so many words), and the only
   * `<app-sign-in-again />` on the screen used to sit in the *other* branch, gated on
   * `unconfirmed() && known()`, which a 401 can never satisfy.
   *
   * The chrome cannot stand in for it: `session-link.ts` renders **nothing** when a device session
   * exists, by design. So the failing population is exactly the owner-foreman on his phone — the
   * founder's own browser, which is the demo phone and the office console at once — and what he
   * got was an instruction with nothing to press, then Home with no admin chrome one reload later.
   */
  it('leaves a way back to the form after a 401, on the browser whose chrome offers none', async () => {
    gateway.meError = httpError(401);
    await render(true, true);

    // The state the finding is about: nothing was confirmed, the credential is gone, and the
    // chrome is silent because this browser is also a phone.
    expect(text()).toContain(sr.company.account.unavailable.title);
    expect(text()).toContain(sr.company.reason.signedOut);
    expect(element.querySelectorAll('app-session-link button')).toHaveLength(0);

    // …and the control the copy names is on screen, inside the card that named it.
    const empty = element.querySelector('.state--empty');
    expect(empty?.querySelector('.sign-in'), 'no way back to the sign-in form').not.toBeNull();
    expect(empty?.textContent).toContain(sr.common.signIn);
  });

  /** And it really goes there, rather than being a second dead control beside a dead sentence. */
  it('sends him to the sign-in form when he presses it', async () => {
    gateway.meError = httpError(401);
    await render(true, true);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    (element.querySelector('.state--empty .sign-in') as HTMLButtonElement).click();

    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  /**
   * The other half of the same property: the empty state is **not** always a sign-in prompt.
   *
   * A 503 leaves the credential alone, so there is nothing to sign in again with and offering it
   * would send him round a loop. `SignInAgain` decides that for itself — this pins that the
   * decision is still being made rather than replaced by an unconditional control.
   */
  it('offers no sign-in when the credential is intact and only the server was unreachable', async () => {
    gateway.meError = httpError(503);
    await render(true, true);

    expect(element.querySelector('.state--empty')).toBeNull();
    expect(element.querySelector('.sign-in')).toBeNull();
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

  /**
   * **An older answer must not overwrite a newer question** (`ui/latest-request.ts`).
   *
   * The symptom on this screen: the reload is pressed twice, the slower attempt fails, and it
   * lands *after* the faster one succeeded — so "Nije provereno na serveru" is painted over the
   * account the server had just confirmed. The screen ends up less truthful than if it had never
   * been reloaded at all.
   */
  it('ignores a failed read that lands after a good one', async () => {
    await render();

    let call = 0;
    const slow = deferred();
    vi.spyOn(gateway, 'me').mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        await slow.promise;
        throw httpError(503);
      }
      return gateway.real.me();
    });

    // Reload once — held open — then again, which answers straight away.
    button('Osveži').click();
    await settle();
    button('Osveži').click();
    await settle();
    expect(text()).toContain('Petar Petrović');
    expect(text()).not.toContain('Nije provereno na serveru');

    // The stale failure lands. It must change nothing.
    slow.release();
    await settle();

    expect(text(), 'a stale failure painted "not confirmed" over data that was').not.toContain(
      'Nije provereno na serveru',
    );
    expect(text()).toContain('Petar Petrović');
    // …and the screen is not stuck saying it is loading either: the newer read owns that flag.
    expect(text()).not.toContain('Učitavanje naloga…');
  });

  it('re-reads the account when the reload control is pressed', async () => {
    await render();
    expect(gateway.real.meCalls).toBe(1);

    button('Osveži').click();
    await settle();

    expect(gateway.real.meCalls).toBe(2);
  });
});
