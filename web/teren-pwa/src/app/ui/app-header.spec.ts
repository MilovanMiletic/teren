import { ChangeDetectionStrategy, Component, Type, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { ProfilePage } from '../features/profile/profile-page';
import { routeUrlFor } from '../testing/route-table';
import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { AppHeader } from './app-header';

/**
 * The header exactly as six of the seven screens write it: no `showProfile` binding at all.
 *
 * Binding the input even to `true` would test the host's opinion instead of the component's
 * default — and the default is the whole mechanism by which the icon reaches every screen but
 * one. A first attempt at this spec did bind it, and flipping the default to `false` left the
 * suite green.
 */
@Component({
  selector: 'app-header-default-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader],
  template: `<app-header />`,
})
class DefaultHost {}

/** The profile screen's spelling: the one place the control is deliberately switched off. */
@Component({
  selector: 'app-header-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader],
  template: `<app-header [showProfile]="showProfile()" />`,
})
class HeaderHost {
  readonly showProfile = signal(false);
}

describe('AppHeader', () => {
  let element: HTMLElement;

  /** Resolved from the shipped route table, never spelled out — see `testing/route-table.ts`. */
  let profileUrl: string;

  beforeAll(async () => {
    profileUrl = await routeUrlFor(ProfilePage);
  });

  function render(host: Type<unknown>): void {
    TestBed.configureTestingModule({
      imports: [
        host,
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

    const fixture = TestBed.createComponent(host);
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  /**
   * The founder's F5 change (2026-08-31): the way to his own account is a header icon beside the
   * language switcher, and Home's centre column goes back to being about entries and reports.
   */
  it('offers the way to his own account, beside the language switcher', () => {
    render(DefaultHost);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const inner = element.querySelector('.header__inner');
    const controls = Array.from(inner?.children ?? []).map((child) => child.tagName.toLowerCase());
    // Beside, and after: the switcher is the control the founder named it against.
    expect(controls.slice(-2)).toEqual(['app-language-switcher', 'app-profile-link']);

    element.querySelector<HTMLButtonElement>('.profile-link')?.click();
    expect(navigate).toHaveBeenCalledWith([profileUrl]);
  });

  /**
   * A control that navigates to the screen you are already standing on is noise.
   *
   * The profile screen switches it off, and it is the only screen that does; every other screen
   * takes the default. Asserted here rather than only on the profile screen so that the default
   * itself is pinned — a flipped default would silently take the icon off all seven screens.
   */
  it('leaves it out where it would lead nowhere', () => {
    render(HeaderHost);

    expect(element.querySelector('app-profile-link')).toBeNull();
    // And the switcher beside it is untouched — this input hides one control, not the chrome.
    expect(element.querySelector('app-language-switcher')).not.toBeNull();
  });
});
