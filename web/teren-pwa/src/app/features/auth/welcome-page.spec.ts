import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import {
  DEVICE_REFUSAL_STORAGE_KEY,
  clearDeviceRefusal,
  readDeviceRefusal,
} from '../../core/session/device-refusal';
import { RETURN_URL_PARAM } from '../../core/session/return-url';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { WelcomePage } from './welcome-page';

describe('WelcomePage', () => {
  let fixture: ComponentFixture<WelcomePage>;
  let element: HTMLElement;
  let router: Router;

  /** Render the screen as the gate would have left it: with a destination in the address bar. */
  function render(next?: string): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        WelcomePage,
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
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap(next ? { [RETURN_URL_PARAM]: next } : {}),
            },
          },
        },
      ],
    });
    fixture = TestBed.createComponent(WelcomePage);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  }

  beforeEach(() => {
    localStorage.clear();
    render();
  });

  afterEach(() => localStorage.clear());

  function click(label: string): void {
    const button = [...element.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(label),
    );
    if (!button) {
      throw new Error(`no "${label}" button on screen`);
    }
    button.click();
    fixture.detectChanges();
  }

  it('offers exactly two ways in, and says where a code comes from', () => {
    expect(element.textContent).toContain('Prijavi se');
    expect(element.textContent).toContain('Pridruži se gradilištu kodom');
    // Without this line a foreman with no code has no idea who to ask, and the screen is a wall.
    expect(element.textContent).toContain('Kod za pridruživanje dobijate od vlasnika firme');
  });

  it('sends the owner to sign-in and the foreman to the code screen', () => {
    click('Prijavi se');
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: {} });

    click('Pridruži se gradilištu kodom');
    // Two routes, not one screen with a mode: the phone's back gesture then means "back to
    // Welcome" rather than "leave Teren".
    expect(router.navigate).toHaveBeenCalledWith(['/activate'], { queryParams: {} });
  });

  /**
   * The middle hop of the deep link, and the one nobody thinks to test.
   *
   * The gate puts the URL a man was trying to reach on `?next=`. He then taps a button here — and
   * if that tap drops the parameter, the whole mechanism is decoration: he activates his phone
   * and lands on Home, with the entry his boss sent him nowhere in sight.
   */
  it('carries a destination through to whichever door he picks', () => {
    render('/diary?entry=8f0d');

    click('Pridruži se gradilištu kodom');
    expect(router.navigate).toHaveBeenCalledWith(['/activate'], {
      queryParams: { [RETURN_URL_PARAM]: '/diary?entry=8f0d' },
    });

    click('Prijavi se');
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { [RETURN_URL_PARAM]: '/diary?entry=8f0d' },
    });
  });

  it('drops a destination that could leave this origin', () => {
    // Re-validated at every hop rather than trusted because it is already in the address bar:
    // this screen is reachable by typing its URL, so `?next=` here is whatever a link said.
    render('//evil.com');

    click('Pridruži se gradilištu kodom');
    expect(router.navigate).toHaveBeenCalledWith(['/activate'], { queryParams: {} });
  });

  /**
   * The second arrival this screen has to serve (2026-09-03).
   *
   * By founder decision a phone whose credential the server refuses signs itself out and lands
   * here, and this screen is also the ordinary first screen of a phone nobody has ever activated.
   * Both hold no session, so the only thing that tells them apart is the note the refusal leaves
   * (`core/session/device-refusal.ts`).
   */
  describe('after the server has refused this phone', () => {
    it('says nothing extra to a phone that was simply never activated', () => {
      expect(element.textContent).not.toContain('Server ne prihvata ovaj telefon');
    });

    it('explains itself when the refusal left a note', () => {
      localStorage.setItem(DEVICE_REFUSAL_STORAGE_KEY, '2026-09-03T14:22:00.000Z');
      render();

      const notice = element.querySelector('.welcome__refused')?.textContent ?? '';
      expect(notice).toContain('Server ne prihvata ovaj telefon');
      // The two things that are certainly true: nothing recorded was lost, and a code is the way
      // back. The remedy is the button directly underneath.
      expect(notice).toMatch(/nisu poslati/i);
      expect(notice).toMatch(/novi kod/i);
    });

    /**
     * **It names no cause, and that is a contract with the server rather than a copy preference.**
     *
     * The 401 behind this screen is deliberately reasonless: a revoked phone, a removed worker and
     * a suspended company answer identically (§7), because "revoked" versus "unknown" is an
     * account-enumeration oracle. A sentence guessing which one it was would be the app inventing
     * the oracle the endpoint refuses to be — and it would be wrong two times in three.
     */
    it('does not guess why', () => {
      localStorage.setItem(DEVICE_REFUSAL_STORAGE_KEY, '2026-09-03T14:22:00.000Z');
      render();

      const notice = element.querySelector('.welcome__refused')?.textContent ?? '';
      for (const cause of [/opozvan/i, /uklonjen/i, /isključen/i, /suspend/i, /firma/i]) {
        expect(notice, `the notice must not name a cause (${cause})`).not.toMatch(cause);
      }
    });

    /**
     * **The sentence survives a reload, and this spec asserted the opposite until the review.**
     *
     * The first cut read the note once and cleared it, on the `ArrivalHandoff.take()` model. The
     * scenario that kills it: signed out mid-shift, phone pocketed, iOS discards the tab, he
     * reopens the app, `requiresDevice` puts him back here — and he reads the plain first-run
     * screen with no record button and nothing saying why, which is the exact complaint this
     * increment exists to answer, one reload later. Tapping "Prijavi se" and coming back did the
     * same, and so did a deferred navigation that fired while the screen was off.
     *
     * The note describes a **condition** rather than delivering a message: *this phone holds no
     * credential because the server refused one*. It names no cause, so nothing in it can go
     * stale, and a phone that is never re-activated goes on reading a sentence that is still true.
     */
    it('keeps saying it, because it is still true', () => {
      localStorage.setItem(DEVICE_REFUSAL_STORAGE_KEY, '2026-09-03T14:22:00.000Z');

      // Every re-render is another arrival at this screen: a reload, a back gesture, a return from
      // `/login`, the app being reopened tomorrow morning.
      for (const arrival of ['first', 'after a reload', 'after coming back from /login']) {
        render();
        expect(
          element.querySelector('.welcome__refused'),
          `the explanation must still be here ${arrival}`,
        ).not.toBeNull();
        expect(readDeviceRefusal(), 'the screen must not consume the note').not.toBeNull();
      }
    });

    /**
     * …and it goes when, and only when, the condition ends.
     *
     * `ActivationService.activate` is the single caller of `clearDeviceRefusal` — the one event in
     * the product that makes the note false, because the phone now holds a credential a server
     * issued seconds ago. Asserted here through the real function rather than by deleting the row
     * by hand, so a rename or a dropped call site fails.
     */
    it('stops saying it once the phone has joined again', () => {
      localStorage.setItem(DEVICE_REFUSAL_STORAGE_KEY, '2026-09-03T14:22:00.000Z');
      render();
      expect(element.querySelector('.welcome__refused')).not.toBeNull();

      clearDeviceRefusal();
      render();

      expect(element.querySelector('.welcome__refused')).toBeNull();
      expect(readDeviceRefusal()).toBeNull();
    });
  });

  it('renders in Serbian by default and switches language without a reload', async () => {
    expect(element.textContent).toContain('Građevinski dnevnik koji se sam piše');

    const buttons = [...element.querySelectorAll('button')];
    buttons.find((candidate) => candidate.textContent?.trim() === 'English')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.textContent).toContain('The site diary that writes itself');
  });
});
