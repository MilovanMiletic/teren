import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

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

  beforeEach(() => render());

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
