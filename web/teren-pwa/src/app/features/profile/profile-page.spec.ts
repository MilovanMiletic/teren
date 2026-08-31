import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { Profile, ProfileResult, ProfileService } from '../../core/identity/profile.service';
import { SESSION_STORAGE_KEY, Session } from '../../core/session/session';
import { ActivatePage } from '../auth/activate-page';
import { routeUrlFor } from '../../testing/route-table';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { ProfilePage } from './profile-page';

/** What the phone stored when Zoran activated it — everything this screen can say with no signal. */
const SESSION: Session = {
  token: 'trn_d_a-real-device-token',
  deviceId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  username: 'zoran.jovanovic',
  displayName: 'Zoran Jovanović',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Vodoinstal Petrović d.o.o.',
  activatedAt: '2026-08-30T08:00:00.000Z',
};

const WORKER: Profile = {
  role: 'worker',
  userId: SESSION.userId,
  displayName: 'Zoran Jovanović',
  username: 'zoran.jovanovic',
  companyName: 'Vodoinstal Petrović d.o.o.',
  deviceName: 'Zoranov telefon',
  language: 'sr',
};

describe('ProfilePage', () => {
  let fixture: ComponentFixture<ProfilePage>;
  let element: HTMLElement;
  let router: Router;

  const profiles = { load: vi.fn<() => Promise<ProfileResult>>() };

  /**
   * The code screen's URL, resolved from the shipped route table once, before any test runs.
   *
   * Resolved in `beforeAll` for the reason `device.guard.spec.ts` records: `routeUrlFor` runs a
   * real dynamic `import()`, and doing that inside a 5 s test is how a suite gains a timeout that
   * has nothing to do with the behaviour under test.
   */
  let activate: string;

  beforeAll(async () => {
    activate = await routeUrlFor(ActivatePage);
  });

  /**
   * Boot the screen with a given server answer and a given phone memory.
   *
   * The **real** `SessionService` is used, seeded through `localStorage`, because "what the phone
   * remembers" is the fallback this screen's honesty depends on and a stub of it would prove
   * nothing about the narrowing that stands between storage and the glass.
   */
  async function render(result: ProfileResult, session: Session | null = SESSION): Promise<void> {
    localStorage.clear();
    if (session) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }
    profiles.load.mockResolvedValue(result);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        ProfilePage,
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
      providers: [provideRouter([]), { provide: ProfileService, useValue: profiles }],
    });

    fixture = TestBed.createComponent(ProfilePage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows the man his name, his username, his company and his phone', async () => {
    await render({ status: 'ok', profile: WORKER });

    expect(element.textContent).toContain('Zoran Jovanović');
    expect(element.textContent).toContain('zoran.jovanovic');
    expect(element.textContent).toContain('Vodoinstal Petrović d.o.o.');
    expect(element.textContent).toContain('Zoranov telefon');
    // The role, as the server said it.
    expect(element.textContent).toContain('Na gradilištu');
  });

  /**
   * Decision 7, which is the whole reason this screen exists.
   *
   * The username outlives the phone; the device credential merely proves it. A man standing next
   * to a broken phone needs to read it here and type it on the new one, so it is a labelled value
   * with the sentence that says what it is for — not a technicality in small print.
   */
  it('says out loud that the username is what survives a broken phone', async () => {
    await render({ status: 'ok', profile: WORKER });

    expect(element.textContent).toContain('KORISNIČKO IME');
    expect(element.textContent).toContain('Ostaje vaše i kad promenite telefon');
  });

  /**
   * The one screen whose header does *not* offer the way to the profile.
   *
   * Every other screen takes `showProfile`'s default; this one turns it off, because a control
   * that navigates to the screen already on the glass is noise a thumb can hit by accident.
   */
  it('does not offer a way to the screen the man is already on', async () => {
    await render({ status: 'ok', profile: WORKER });

    expect(element.querySelector('app-profile-link')).toBeNull();
    // The rest of the header chrome is untouched — language is still reachable from here.
    expect(element.querySelector('app-header app-language-switcher')).not.toBeNull();
  });

  it('renders Serbian by default — no English leaks onto a site phone', async () => {
    await render({ status: 'ok', profile: WORKER });

    expect(element.textContent).toContain('Moj nalog');
    expect(element.textContent).not.toContain('My account');
  });

  /**
   * Offline is not an empty screen and it is not a silent one.
   *
   * The phone knows who it belongs to without a network, so it says so — and, because a company
   * name months old would be believed, it says in the same breath that nothing was checked.
   */
  it('falls back to what the phone remembers, and admits it did not check', async () => {
    await render({ status: 'offline', profile: null });

    expect(element.textContent).toContain('Zoran Jovanović');
    expect(element.textContent).toContain('zoran.jovanovic');
    expect(element.textContent).toContain('Nije provereno na serveru');
    expect(element.textContent).toContain('Nema interneta');
    // The role is the one thing it will not guess: a stored session says nothing about a role.
    expect(element.textContent).not.toContain('Na gradilištu');
  });

  it('says a revoked phone was not confirmed — and does not lock the screen', async () => {
    // Decision 8: revocation is never a door. It is a sentence, and nothing else changes.
    await render({ status: 'unauthorized', profile: null });

    expect(element.textContent).toContain('Server nije prihvatio ovaj telefon');
    expect(element.textContent).toContain('ništa se ne briše');
    expect(element.textContent).toContain('Zoran Jovanović');
  });

  /**
   * The failure mode this project has shipped five times: a screen that claims to know something
   * it does not.
   *
   * No server answer and no stored session — a phone still running on the build-time token, or one
   * whose storage was cleared. There is nothing true to say about the man, so it says nothing about
   * him at all and explains why.
   */
  it('shows no profile at all rather than an empty or invented one', async () => {
    await render({ status: 'offline', profile: null }, null);

    expect(element.textContent).toContain('Podaci o nalogu nisu učitani');
    expect(element.textContent).toContain('Nema interneta');
    // Not a blank name card, not a row with nothing in it, and not somebody else's name.
    expect(element.textContent).not.toContain('KORISNIČKO IME');
    expect(element.textContent).not.toContain('Zoran');
    // And the promise that matters most to a man reading this: his recordings are still there.
    expect(element.textContent).toContain('Snimci i dalje stoje na telefonu');
  });

  /**
   * `/api/me` answers for all three roles and this screen must not assume a worker.
   *
   * A super admin has no username, no company and no device — by database constraint, not by
   * accident — so the screen renders what exists and omits the rest.
   */
  it('does not break on a role that has no username, no company and no phone', async () => {
    await render(
      {
        status: 'ok',
        profile: {
          role: 'super_admin',
          userId: 'aaaa',
          displayName: 'Milovan Miletić',
          username: null,
          companyName: null,
          deviceName: null,
          language: 'sr',
        },
      },
      null,
    );

    expect(element.textContent).toContain('Milovan Miletić');
    expect(element.textContent).toContain('Teren tim');
    expect(element.textContent).not.toContain('KORISNIČKO IME');
    expect(element.textContent).not.toContain('Firma');
    // A card with no rows would read as broken; the screen says there is nothing else on file.
    expect(element.textContent).toContain('Nema drugih podataka');
  });

  it('names an unknown role instead of showing a raw wire string', async () => {
    await render({ status: 'ok', profile: { ...WORKER, role: 'unknown' } }, null);

    expect(element.textContent).toContain('Uloga koju ova verzija aplikacije ne prepoznaje');
  });

  /**
   * The answer to "this is not me": re-activation, which replaces a credential and deletes
   * nothing (PROJECT.md principle 3, plan §10.4).
   */
  it('offers the re-activation door, and it leads to the code screen', async () => {
    await render({ status: 'ok', profile: WORKER });

    const button = element.querySelector<HTMLButtonElement>('.reactivate');
    expect(button?.textContent).toContain('Novi telefon ili drugi nalog');

    button?.click();

    // Derived from the route table, never spelled out: a rename of `/activate` must fail here.
    expect(router.navigate).toHaveBeenCalledWith([activate]);
  });

  /**
   * **There is no sign-out, and no code path from this screen into the store.**
   *
   * An unsent day of evidence outranks a wrong name on a screen. Asserted against the shipped
   * source rather than against the rendered DOM, because the thing being ruled out is a *future*
   * edit — someone adding a tidy "sign out" that clears the outbox on the way past.
   */
  it('holds no way to delete anything on this phone', async () => {
    await render({ status: 'ok', profile: WORKER });

    expect(element.textContent).not.toContain('Odjav');

    // Comments first, the way `i18n.spec.ts` does it: this file's own doc comment names
    // `EntryStore` in order to say it must never be reached for, and a guard that failed on prose
    // is a guard the next person deletes.
    const source = readFileSync(
      join(process.cwd(), 'src', 'app', 'features', 'profile', 'profile-page.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    for (const forbidden of [
      'core/db',
      'EntryStore',
      'TEREN_DB',
      'TerenDb',
      'removeItem',
      'clear(',
    ]) {
      expect(source, `the profile screen must not reach for ${forbidden}`).not.toContain(forbidden);
    }
  });
});
