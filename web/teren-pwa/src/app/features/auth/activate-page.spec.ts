import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { ActivationService } from '../../core/auth/activation.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { RETURN_URL_PARAM } from '../../core/session/return-url';
import { Session } from '../../core/session/session';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { ActivatePage } from './activate-page';

const SESSION: Session = {
  token: 'trn_d_x',
  deviceId: '44444444-4444-4444-4444-444444444444',
  userId: '22222222-2222-2222-2222-222222222222',
  username: 'zoran.jovanovic',
  displayName: 'Zoran Jovanović',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Gradnja d.o.o.',
  activatedAt: '2026-08-30T08:00:00.000Z',
};

describe('ActivatePage', () => {
  let fixture: ComponentFixture<ActivatePage>;
  let element: HTMLElement;

  const online = { online: () => true };
  const offline = { online: () => false };

  const activation = {
    activate: vi.fn(),
    requestCode: vi.fn(),
    login: vi.fn(),
  };

  let router: Router;

  /** Render the screen as the gate would have left it — optionally holding a destination. */
  function render(connectivity: unknown = online, next?: string): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        ActivatePage,
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
        { provide: ConnectivityService, useValue: connectivity },
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
    fixture = TestBed.createComponent(ActivatePage);
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

  /** Type, the way a keyboard does: the caret ends up at the end of what was typed. */
  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function paste(input: HTMLInputElement, text: string): void {
    const event = new Event('paste') as Event & { clipboardData: { getData: () => string } };
    event.clipboardData = { getData: () => text };
    input.dispatchEvent(event);
    fixture.detectChanges();
  }

  function submit(): Promise<void> {
    element.querySelector('form')?.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    return fixture.whenStable().then(() => fixture.detectChanges());
  }

  beforeEach(() => {
    vi.clearAllMocks();
    activation.activate.mockResolvedValue({
      ok: true,
      failure: null,
      session: SESSION,
      released: 0,
    });
    activation.requestCode.mockResolvedValue({ ok: true, failure: null });
  });

  it('asks for a username and a code, and never for a password', () => {
    render();

    expect(field('activate-username')).toBeTruthy();
    expect(field('activate-code').getAttribute('autocomplete')).toBe('one-time-code');
    // The line the whole role model turns on: a worker has no password, by database constraint.
    // A password field on this screen would be an invitation to look for one he does not have.
    expect(element.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('is one input, not eight boxes, and does not cap the raw length below a formatted code', () => {
    render();
    // Segmented boxes break paste and screen readers on Android, and paste is how most codes
    // arrive. A `maxlength` of 8 would truncate a pasted `XKD4-7HMP` — nine characters — before
    // the component ever saw the last one.
    expect(element.querySelectorAll('.field__input--code')).toHaveLength(1);
    expect(field('activate-code').hasAttribute('maxlength')).toBe(false);
  });

  it('folds and formats as he types, so he can see the app read him', () => {
    render();
    const code = field('activate-code');

    type(code, 'xkd47hmp');

    expect(code.value).toBe('XKD4-7HMP');
  });

  it('folds a Cyrillic keyboard rather than silently dropping what it produces', () => {
    render();
    const code = field('activate-code');

    // Х and С are Cyrillic; they are pixel-identical to X and C. Dropped, he would be left with
    // six characters where he can see eight, and no possible hint on screen.
    type(code, 'ХKD4-7СMP');

    expect(code.value).toBe('XKD4-7CMP');
  });

  it('takes the code out of a pasted message, separators, prose and emoji included', () => {
    render();
    const code = field('activate-code');

    paste(code, 'Kod za pridruživanje: XKD4-7HMP 👍');

    // The prose folds into characters too, so the first eight win — which is why the field shows
    // what it will send rather than what was pasted.
    expect(code.value).toBe('K0DZ-APR1');
  });

  it('never submits on the eighth character', async () => {
    render();
    type(field('activate-username'), 'zoran.jovanovic');

    type(field('activate-code'), 'xkd47hmp');
    await fixture.whenStable();

    // A mis-typed paste would burn a single-use code and send him back to his boss for another.
    expect(activation.activate).not.toHaveBeenCalled();
  });

  it('sends the canonical code, and then goes to the record button', async () => {
    render();
    type(field('activate-username'), 'zoran.jovanovic');
    type(field('activate-code'), 'xkd4-7hmp');

    await submit();

    expect(activation.activate).toHaveBeenCalledWith('zoran.jovanovic', 'XKD47HMP');
    // The defect the founder met on a real phone: this screen used to raise a success panel and
    // stay put, he read a screen that had not moved as a failure, pressed the button again and
    // burned a second single-use code. A man who has just been let in goes through the door.
    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('finishes the journey the gate interrupted', async () => {
    // `?next=` arrives here from Welcome, which got it from the guard. This is the last hop: the
    // entry his boss sent him a link to is what he sees next, not a list he has to search.
    render(online, '/diary?entry=8f0d');
    type(field('activate-username'), 'zoran.jovanovic');
    type(field('activate-code'), 'xkd47hmp');

    await submit();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/diary?entry=8f0d');
  });

  it('will not be sent off this origin by a poisoned destination', async () => {
    // An open redirect on a join screen is worth something to an attacker: it is the ideal place
    // to collect a username and a single-use code.
    render(online, '//evil.com');
    type(field('activate-username'), 'zoran.jovanovic');
    type(field('activate-code'), 'xkd47hmp');

    await submit();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('stays where it is when the code is refused, however many times', async () => {
    activation.activate.mockResolvedValue({
      ok: false,
      failure: 'rejected',
      session: null,
      released: 0,
    });
    render();
    type(field('activate-username'), 'zoran.jovanovic');
    type(field('activate-code'), 'xkd47hmp');

    await submit();

    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('keeps what he typed when the server refuses it', async () => {
    activation.activate.mockResolvedValue({
      ok: false,
      failure: 'rejected',
      session: null,
      released: 0,
    });
    render();
    type(field('activate-username'), 'zoran.jovanovic');
    type(field('activate-code'), 'xkd47hmp');

    await submit();

    // Retyping seven correct characters because the eighth was wrong is how a man puts the phone
    // away. The field is never cleared, and there is no lockout — throttling is the server's job.
    expect(field('activate-code').value).toBe('XKD4-7HMP');
    expect(element.textContent).toContain('Korisničko ime i kod ne idu zajedno');
    expect(element.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
  });

  it('names the failure the server actually produced, not a guess', async () => {
    activation.activate.mockResolvedValue({
      ok: false,
      failure: 'notAvailable',
      session: null,
      released: 0,
    });
    render();
    type(field('activate-username'), 'zoran.jovanovic');
    type(field('activate-code'), 'xkd47hmp');

    await submit();

    // "Wrong code" over a server that never looked at his code would send him to his boss for a
    // replacement he does not need.
    expect(element.textContent).toContain('Ovaj server još ne prima pridruživanje kodom');
  });

  it('will not send an incomplete code, and says which part is missing', async () => {
    render();
    type(field('activate-code'), 'xkd4');

    await submit();

    expect(activation.activate).not.toHaveBeenCalled();
    expect(element.textContent).toContain('Upišite korisničko ime');
  });

  it('says a connection is needed before he types, not after eight characters', () => {
    render(offline);

    expect(element.textContent).toContain('Nema interneta');
    // …and the button is still live: `navigator.onLine` is a hint, and a locked door on this
    // screen is worse than an attempt that fails with the same sentence.
    expect(element.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
  });

  describe('the self-service path (decision 14)', () => {
    it('asks for a fresh code with the username alone', async () => {
      render();
      type(field('activate-username'), 'zoran.jovanovic');

      resend();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(activation.requestCode).toHaveBeenCalledWith('zoran.jovanovic');
      // Conditional by construction: the server answers the same whether or not the username
      // exists, so the screen must not claim an account was found.
      expect(element.textContent).toContain('Ako to korisničko ime postoji');
    });

    it('keeps the form on screen, so nothing he typed is thrown away', async () => {
      render();
      type(field('activate-username'), 'zoran.jovanovic');
      type(field('activate-code'), 'xkd47hmp');

      resend();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(field('activate-code').value).toBe('XKD4-7HMP');
    });

    it('does not answer a request for help with a complaint about the empty code field', async () => {
      render();
      type(field('activate-username'), 'zoran.jovanovic');

      resend();
      await fixture.whenStable();
      fixture.detectChanges();

      // He has just said he does not have a code. Marking the code field invalid at that moment
      // reads as an error he caused by asking for help.
      expect(element.textContent).not.toContain('Kod ima osam znakova');
      expect(element.querySelectorAll('.field__box--invalid')).toHaveLength(0);
    });

    it('does not send a request with no username', async () => {
      render();

      resend();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(activation.requestCode).not.toHaveBeenCalled();
      expect(element.textContent).toContain('Upišite korisničko ime');
    });
  });

  function resend(): void {
    const buttons = [...element.querySelectorAll('button')];
    const button = buttons.find((candidate) => candidate.textContent?.includes('Pošalji mi kod'));
    if (!button) {
      throw new Error('no "send me a code" button on screen');
    }
    button.click();
    fixture.detectChanges();
  }
});
