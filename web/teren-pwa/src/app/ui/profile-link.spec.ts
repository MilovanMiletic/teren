import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';

import { ProfilePage } from '../features/profile/profile-page';
import { routeUrlFor } from '../testing/route-table';
import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { ProfileLink } from './profile-link';

describe('ProfileLink', () => {
  let fixture: ComponentFixture<ProfileLink>;
  let element: HTMLElement;

  /**
   * The profile screen's URL, out of the **real** route table, resolved once before any test.
   *
   * Never spelled out here: `route-table.ts` exists because a renamed path is invisible to the
   * compiler, and a spec that restated `/profile` would agree with a control that had stopped
   * working. `beforeAll` because `routeUrlFor` runs a real dynamic `import()`, which is how a
   * suite gains a 5 s timeout unrelated to the behaviour under test.
   */
  let profileUrl: string;

  beforeAll(async () => {
    profileUrl = await routeUrlFor(ProfilePage);
  });

  function render(): void {
    TestBed.configureTestingModule({
      imports: [
        ProfileLink,
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

    fixture = TestBed.createComponent(ProfileLink);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('opens the profile screen the route table registers', () => {
    render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    element.querySelector<HTMLButtonElement>('.profile-link')?.click();

    expect(navigate).toHaveBeenCalledWith([profileUrl]);
  });

  /**
   * An icon with no name is a control only a sighted user has.
   *
   * Asserted in both languages, because the accessible name is the *only* text this control
   * carries — there is no visible label to notice a missing translation by, so a key that
   * resolved in Serbian and fell through in English would be silent on screen.
   */
  it('carries an accessible name in both languages, never a hardcoded one', async () => {
    render();
    const button = element.querySelector<HTMLButtonElement>('.profile-link');

    expect(button?.getAttribute('aria-label')).toBe('Moj nalog');

    TestBed.inject(TranslocoService).setActiveLang('en');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      element.querySelector<HTMLButtonElement>('.profile-link')?.getAttribute('aria-label'),
    ).toBe('My account');
  });
});
