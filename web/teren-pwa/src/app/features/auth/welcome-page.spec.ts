import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { WelcomePage } from './welcome-page';

describe('WelcomePage', () => {
  let fixture: ComponentFixture<WelcomePage>;
  let element: HTMLElement;
  let router: Router;

  beforeEach(() => {
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
      providers: [provideRouter([])],
    });
    fixture = TestBed.createComponent(WelcomePage);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

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
    expect(router.navigate).toHaveBeenCalledWith(['/login']);

    click('Pridruži se gradilištu kodom');
    // Two routes, not one screen with a mode: the phone's back gesture then means "back to
    // Welcome" rather than "leave Teren".
    expect(router.navigate).toHaveBeenCalledWith(['/activate']);
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
