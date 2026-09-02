import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';

import { AdminSession } from '../core/session/admin-session';
import { AdminSessionService } from '../core/session/admin-session.service';
import { SessionService } from '../core/session/session.service';
import { ActionLogService } from '../core/telemetry/action-log.service';
import { ACTIONS } from '../core/telemetry/actions';
import { LoginPage } from '../features/auth/login-page';
import { routeUrlFor } from '../testing/route-table';
import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { SessionLink } from './session-link';

/**
 * The one control that is both the way out and the way in, and the three states it has to tell
 * apart. The founder's F7 item 2 — *"the login button should be on the header"* — is item 1 here;
 * the other two tests are the ones that stop it becoming the dead control item 3 complained about.
 */
describe('SessionLink', () => {
  let fixture: ComponentFixture<SessionLink>;
  let element: HTMLElement;

  /** Resolved from the shipped route table, never spelled out — see `testing/route-table.ts`. */
  let loginUrl: string;

  beforeAll(async () => {
    loginUrl = await routeUrlFor(LoginPage);
  });

  const admin: AdminSession = {
    token: 'trn_s_whatever',
    role: 'company_admin',
    userId: '44444444-4444-4444-4444-444444444444',
    displayName: 'Petar Petrović',
    companyId: '33333333-3333-3333-3333-333333333333',
    companyName: 'Vodoinstal Petrović',
    expiresAt: '2026-09-29T08:00:00.000Z',
    signedInAt: '2026-08-31T08:00:00.000Z',
  };

  /**
   * Both credentials are mutable per test, because the interesting behaviour is what happens when
   * one of them changes *while the screen is open* — see the expiry test at the foot of this file.
   */
  let signedInAs: AdminSession | null;
  let deviceActivated: boolean;
  const signOut = vi.fn();

  function render(): void {
    TestBed.configureTestingModule({
      imports: [
        SessionLink,
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
      providers: [
        provideRouter([]),
        {
          provide: AdminSessionService,
          useValue: {
            signedIn: () => signedInAs !== null,
            session: () => signedInAs,
            signOut,
          },
        },
        { provide: SessionService, useValue: { activated: () => deviceActivated } },
      ],
    });

    fixture = TestBed.createComponent(SessionLink);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
  }

  function button(): HTMLButtonElement | null {
    return element.querySelector<HTMLButtonElement>('.session');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    signedInAs = null;
    deviceActivated = false;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('offers a signed-in admin the way out, and takes his credential with it', () => {
    signedInAs = admin;
    render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    expect(button()?.textContent).toContain('Odjavi se');
    button()?.click();

    expect(signOut).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith([loginUrl]);
  });

  it('offers the way in when nobody is signed in, and signs nobody out doing it', () => {
    render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    expect(button()?.textContent).toContain('Prijavi se');
    button()?.click();

    // The distinction the two branches exist for: `signOut()` on the way *in* would clear a
    // credential adopted in another tab a second earlier.
    expect(signOut).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith([loginUrl]);
  });

  /**
   * The third state, and the only one that renders nothing.
   *
   * A foreman has no sign-in to leave — decision 4 gives passwords to admins only — and a
   * "Prijavi se" on his header would point at `/login`, which `requiresNoDevice` bounces an
   * activated phone straight back out of. That is the dead control the founder photographed,
   * rebuilt one component to the left.
   */
  it('shows a foreman nothing at all', () => {
    deviceActivated = true;
    render();

    expect(button()).toBeNull();
    expect(element.textContent?.trim()).toBe('');
  });

  /**
   * The founder's own phone: activated as a device *and* signed in as an admin. The admin
   * credential wins — he is the one person who has both, and he is the one person who needs to be
   * able to put the office down.
   */
  it('lets the man who holds both credentials out of the office', () => {
    signedInAs = admin;
    deviceActivated = true;
    render();

    expect(button()?.textContent).toContain('Odjavi se');
  });

  /**
   * Why `state()` is a method and not a `computed`, pinned.
   *
   * `AdminSessionService.signedIn()` applies the session's expiry against the clock, so its answer
   * changes with time and not with a signal write. A `computed` would cache "signed in" from the
   * moment the credential was adopted and hold it for thirty days of wall-clock time — leaving an
   * expired admin looking at a sign-*out* button on a screen that is at that moment telling him it
   * could not read his company. Convert `state()` to a computed and this test fails.
   */
  it('asks again rather than remembering, so an expired session turns the control round', () => {
    signedInAs = admin;
    render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    expect(button()?.textContent).toContain('Odjavi se');

    // His session expires while the screen sits open. Nothing writes a signal when that happens —
    // it is the clock that moved — so the control is still showing him the way *out* when he
    // reaches for it. Pressing it is therefore the realistic first moment the app finds out, and
    // it is also what makes the view dirty: under zoneless OnPush a plain `detectChanges()` over a
    // view nothing has invalidated refreshes nothing at all.
    signedInAs = null;
    button()?.click();
    fixture.detectChanges();

    // Pressing a stale sign-out is harmless and lands him where he needs to be anyway.
    expect(navigate).toHaveBeenCalledWith([loginUrl]);
    // And the control has turned round. A `computed` would still read 'out' here — no signal has
    // changed, so nothing would have invalidated it — and an expired admin would be left pressing
    // sign-out over and over on a screen that could not read his company. That is the mutation
    // this test exists to catch.
    expect(button()?.textContent).toContain('Prijavi se');
  });

  /**
   * The label is visible, but the accessible name is not the same string — it carries who is being
   * signed out, which is the part that matters on a shared office tablet.
   */
  it('names who it would sign out, in both languages', async () => {
    signedInAs = admin;
    render();

    expect(button()?.getAttribute('aria-label')).toBe('Odjavi se — Petar Petrović');

    TestBed.inject(TranslocoService).setActiveLang('en');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(button()?.getAttribute('aria-label')).toBe('Sign out — Petar Petrović');
    expect(button()?.textContent).toContain('Sign out');
  });

  /**
   * What this control tells the action log (D5).
   *
   * It is one button wearing two actions, which is exactly why the slug is recorded in the handler
   * instead of declared on the element: a `data-log="session.logout"` would file every press of the
   * *way in* as a sign-out that never happened.
   *
   * The order is load-bearing too. `ActionLogService` picks a batch's bearer from the surface the
   * row was captured on, and the admin token this row needs is gone the line after `signOut()`.
   */
  describe('the action log', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      // `signOut` is a plain `vi.fn()`, so `restoreAllMocks` does not touch the implementation one
      // of these tests gives it — and `clearAllMocks` in the outer `beforeEach` clears the calls
      // and not the implementation either. Left behind, it would push into a dead array for ever.
      signOut.mockReset();
    });

    it('records the sign-out before the credential it would be sent under is dropped', () => {
      signedInAs = admin;
      render();
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const order: string[] = [];
      vi.spyOn(ActionLogService.prototype, 'record').mockImplementation((action) => {
        order.push(action);
      });
      signOut.mockImplementation(() => order.push('signOut'));

      button()?.click();

      expect(order).toEqual([ACTIONS.sessionLogout, 'signOut']);
    });

    it('records nothing when the same control is the way in', () => {
      render();
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const record = vi.spyOn(ActionLogService.prototype, 'record');

      button()?.click();

      expect(record).not.toHaveBeenCalled();
    });
  });
});
