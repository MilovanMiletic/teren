import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { AppUpdateService } from '../core/update/app-update.service';
import { UpdateBanner } from './update-banner';

/** The service, reduced to the two things the card draws from and the two it calls. */
class FakeUpdates {
  readonly offered = signal(false);
  applied = 0;
  declined = 0;

  async apply(): Promise<void> {
    this.applied += 1;
  }

  decline(): void {
    this.declined += 1;
  }
}

describe('UpdateBanner', () => {
  let updates: FakeUpdates;
  let fixture: ComponentFixture<UpdateBanner>;
  let element: HTMLElement;

  beforeEach(() => {
    updates = new FakeUpdates();
    TestBed.configureTestingModule({
      imports: [
        UpdateBanner,
        // The shipped dictionaries. A card with its own copy of the strings would pass while the
        // Serbian a foreman reads was missing.
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
      providers: [{ provide: AppUpdateService, useValue: updates as unknown as AppUpdateService }],
    });
    fixture = TestBed.createComponent(UpdateBanner);
    element = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  it('is not on screen at all until there is something to offer', () => {
    expect(element.textContent?.trim()).toBe('');
  });

  it('says in Serbian that a new version is waiting, and that nothing is lost', () => {
    updates.offered.set(true);
    fixture.detectChanges();

    // Not a translation key on a foreman's screen, and not English either.
    expect(element.textContent).toContain('Nova verzija je spremna');
    expect(element.textContent).toContain('Ništa se ne gubi');
    expect(element.textContent).not.toContain('app.update');
  });

  it('reloads only when the reload button is pressed', () => {
    updates.offered.set(true);
    fixture.detectChanges();

    const [later, reload] = [...element.querySelectorAll<HTMLButtonElement>('button')];
    expect(later.textContent).toContain('Ne sada');
    expect(reload.textContent).toContain('Osveži');

    later.click();
    expect(updates.declined).toBe(1);
    expect(updates.applied).toBe(0);

    reload.click();
    expect(updates.applied).toBe(1);
  });
});
