import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';

import { PlatformPage } from '../features/platform/platform-page';
import { AdminSession, ADMIN_SESSION_STORAGE_KEY } from '../core/session/admin-session';
import { routeUrlFor } from '../testing/route-table';
import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { PlatformLink } from './platform-link';

const STAFF: AdminSession = {
  token: 'trn_s_a-real-session-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'super_admin',
  userId: '44444444-4444-4444-4444-444444444444',
  displayName: 'Milovan Miletić',
  companyId: null,
  companyName: null,
  signedInAt: '2026-09-01T08:00:00.000Z',
};

const OWNER: AdminSession = {
  ...STAFF,
  role: 'company_admin',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Gradnja d.o.o.',
};

describe('PlatformLink', () => {
  let fixture: ComponentFixture<PlatformLink>;
  let element: HTMLElement;

  /**
   * The platform screen's URL, out of the **real** route table, resolved once before any test.
   *
   * Never spelled out here, for `profile-link.spec.ts`'s reason: a renamed path is invisible to
   * the compiler, and a spec that restated `/platform` would agree with a control that had
   * stopped working.
   */
  let platformUrl: string;

  beforeAll(async () => {
    platformUrl = await routeUrlFor(PlatformPage);
  });

  function render(session: AdminSession | null): void {
    localStorage.clear();
    if (session) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(session));
    }

    TestBed.configureTestingModule({
      imports: [
        PlatformLink,
        // The real dictionaries: a spec carrying its own copies would pass while the shipped
        // Serbian had no string behind the key.
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
      providers: [provideRouter([])],
    });

    fixture = TestBed.createComponent(PlatformLink);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('opens the platform screen the route table registers', () => {
    render(STAFF);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    element.querySelector<HTMLButtonElement>('.platform-link')?.click();

    expect(navigate).toHaveBeenCalledWith([platformUrl]);
  });

  /**
   * The reason this component exists, asserted as the thing it is: a way *back*.
   *
   * Until 2026-09-01 the only navigation into `/platform` anywhere in the app was the one
   * `login-page.ts` performs on a successful sign-in. Every route was registered and every guard
   * was right, and the surface still vanished the moment the founder reloaded or tapped Home.
   */
  it('is present for the man who has somewhere to go', () => {
    render(STAFF);

    expect(element.querySelector('.platform-link')).not.toBeNull();
  });

  /**
   * **Not "company admin or better".** The roles are not a hierarchy: a super admin has no company
   * by construction and is refused by every evidence route on purpose, so a control that treated
   * them as ranks would be the first step towards staff reading a customer's diary. It is also the
   * plain case of a dead control — `/platform` answers a company admin with a redirect.
   */
  it('is absent for a company admin, whose surface this is not', () => {
    render(OWNER);

    expect(element.querySelector('.platform-link')).toBeNull();
  });

  it('is absent for a foreman, who has no admin session at all', () => {
    render(null);

    expect(element.querySelector('.platform-link')).toBeNull();
  });

  /**
   * An expired credential is not a credential.
   *
   * `AdminSessionService` applies the session's own expiry on every read, so this control turns
   * itself off at the moment the token stops working rather than at the next navigation. Written
   * because `visible()` is a method for exactly this reason, and a future refactor to a `computed`
   * would cache the answer for thirty days of wall-clock time and pass every other spec here.
   */
  it('is absent once the session has expired', () => {
    render({ ...STAFF, expiresAt: '2020-01-01T00:00:00.000Z' });

    expect(element.querySelector('.platform-link')).toBeNull();
  });

  /**
   * An icon with no name is a control only a sighted user has.
   *
   * Asserted in both languages, because the accessible name is the *only* text this control
   * carries — there is no visible label to notice a missing translation by.
   */
  it('carries an accessible name in both languages, never a hardcoded one', async () => {
    render(STAFF);

    expect(element.querySelector('.platform-link')?.getAttribute('aria-label')).toBe('Platforma');

    TestBed.inject(TranslocoService).setActiveLang('en');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.querySelector('.platform-link')?.getAttribute('aria-label')).toBe('Platform');
  });
});
