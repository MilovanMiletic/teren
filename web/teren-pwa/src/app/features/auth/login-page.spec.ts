import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { ActivationService } from '../../core/auth/activation.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { RETURN_URL_PARAM } from '../../core/session/return-url';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { LoginPage } from './login-page';

describe('LoginPage', () => {
  let fixture: ComponentFixture<LoginPage>;
  let element: HTMLElement;

  const activation = { activate: vi.fn(), requestCode: vi.fn(), login: vi.fn() };

  let router: Router;

  function render(online = true, next?: string): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        LoginPage,
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
        { provide: ActivationService, useValue: activation },
        { provide: ConnectivityService, useValue: { online: () => online } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap(next ? { [RETURN_URL_PARAM]: next } : {}),
            },
          },
        },
      ],
    });
    fixture = TestBed.createComponent(LoginPage);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  }

  function field(id: string): HTMLInputElement {
    const input = element.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) {
      throw new Error(`no #${id} on screen`);
    }
    return input;
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function submit(): Promise<void> {
    element.querySelector('form')?.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    return fixture.whenStable().then(() => fixture.detectChanges());
  }

  beforeEach(() => {
    vi.clearAllMocks();
    activation.login.mockResolvedValue({
      ok: true,
      failure: null,
      role: 'company_admin',
      displayName: 'Milan Gradnja',
    });
    render();
  });

  it('takes an email address and a password', () => {
    expect(field('login-email').getAttribute('type')).toBe('email');
    expect(field('login-password').getAttribute('autocomplete')).toBe('current-password');
  });

  function clickJoin(): void {
    const button = [...element.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Pridruži se gradilištu kodom'),
    );
    button?.click();
  }

  it('offers the code path in plain sight, for a foreman who followed the wrong link', () => {
    // He has no password and never will (`ck_app_user_worker_has_no_password`), so a screen that
    // only offered a password would be a dead end for the product's primary user.
    clickJoin();

    expect(router.navigate).toHaveBeenCalledWith(['/activate'], { queryParams: {} });
  });

  it('carries his destination to the code screen', () => {
    // He is the man `?next=` was written for: the gate sent him to Welcome holding the URL of an
    // entry and he picked the wrong door. The parameter has to survive this tap too.
    render(true, '/diary?entry=8f0d');
    clickJoin();

    expect(router.navigate).toHaveBeenCalledWith(['/activate'], {
      queryParams: { [RETURN_URL_PARAM]: '/diary?entry=8f0d' },
    });
  });

  it('reveals the password on request, and hides it again', () => {
    const toggle = element.querySelector<HTMLButtonElement>('.field__toggle');
    expect(field('login-password').getAttribute('type')).toBe('password');

    toggle?.click();
    fixture.detectChanges();
    // A long password on a glass keyboard is wrong about a third of the time; the alternative to
    // revealing it is retyping it blind.
    expect(field('login-password').getAttribute('type')).toBe('text');

    toggle?.click();
    fixture.detectChanges();
    expect(field('login-password').getAttribute('type')).toBe('password');
  });

  it('signs in and says so, storing nothing this build could misuse', async () => {
    type(field('login-email'), 'vlasnik@gradnja.rs');
    type(field('login-password'), 'lozinka');

    await submit();

    expect(activation.login).toHaveBeenCalledWith('vlasnik@gradnja.rs', 'lozinka');
    expect(element.textContent).toContain('Prijava je uspela');
    expect(element.textContent).toContain('Milan Gradnja');
    // The password does not outlive the request that used it.
    expect(field('login-password').value).toBe('');
  });

  /**
   * The one screen F4 deliberately leaves standing still, and why that is not an inconsistency.
   *
   * A successful sign-in stores nothing — `Session` describes a *device*, and an admin has none —
   * so `SessionService.activated()` is still false afterwards. A redirect Home would be turned
   * round by the gate and land him back on Welcome: the app bouncing him between two screens as
   * its way of saying "that worked". The sentence on screen is the honest version, and it lasts
   * exactly as long as the condition does.
   */
  it('does not navigate on success, because there is nothing yet to navigate to', async () => {
    type(field('login-email'), 'vlasnik@gradnja.rs');
    type(field('login-password'), 'lozinka');

    await submit();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    // Said out loud on screen, so a man is not left wondering what he is supposed to press.
    expect(element.textContent).toContain('Ekrani za kancelariju se još prave');
  });

  /**
   * The defect the founder photographed, pinned.
   *
   * A successful sign-in clears the password — it is not kept a moment longer than the request
   * that used it — and the empty field then satisfied `touched() && !passwordGiven()`. The screen
   * showed "Prijava je uspela" and "Upišite lozinku" at the same time, with the field ringed red:
   * one successful login, and the form demanding a password it had deleted itself.
   */
  it('does not demand a password it has just deleted itself', async () => {
    type(field('login-email'), 'vlasnik@gradnja.rs');
    type(field('login-password'), 'lozinka');

    await submit();

    expect(element.textContent).toContain('Prijava je uspela');
    expect(element.textContent).not.toContain('Upišite lozinku');
    // Nor the silent half of it: a red ring under a success panel says the same thing in colour.
    expect(element.querySelector('.field__box--invalid')).toBeNull();
    expect(element.querySelector('.form__message--err')).toBeNull();
  });

  it('still asks for a password on the next attempt, once the sign-in is set aside', async () => {
    // The fix must not disable validation for good: submitting again starts a new attempt, and an
    // empty field is a missing field however the previous one went.
    type(field('login-email'), 'vlasnik@gradnja.rs');
    type(field('login-password'), 'lozinka');
    await submit();

    await submit();

    expect(element.textContent).toContain('Upišite lozinku');
    expect(element.textContent).not.toContain('Prijava je uspela');
  });

  it('gives one sentence for a wrong email and a wrong password alike', async () => {
    activation.login.mockResolvedValue({
      ok: false,
      failure: 'rejected',
      role: null,
      displayName: null,
    });
    type(field('login-email'), 'vlasnik@gradnja.rs');
    type(field('login-password'), 'pogresno');

    await submit();

    // Two different sentences would make this screen an account-enumeration oracle by reading.
    expect(element.textContent).toContain('Pogrešna imejl adresa ili lozinka');
  });

  it('will not send an empty form, and says which field is missing', async () => {
    await submit();

    expect(activation.login).not.toHaveBeenCalled();
    expect(element.textContent).toContain('Upišite imejl adresu');
  });

  it('says a connection is needed before he types', () => {
    render(false);
    expect(element.textContent).toContain('Nema interneta');
  });

  it('does not offer a password reset it cannot perform', () => {
    // The artboard carries "Zaboravljena lozinka?", but `/auth/password-reset` does not exist and
    // needs an SMTP relay nobody has chosen yet. A link that visibly does nothing is worse than
    // an absence on the screen whose whole job is to be trusted with a credential; it returns
    // with D7.
    expect(element.textContent).not.toContain('Zaboravljena lozinka');
  });
});
