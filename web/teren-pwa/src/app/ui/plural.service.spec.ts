import { TestBed } from '@angular/core/testing';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';

import { PluralService } from './plural.service';

describe('PluralService', () => {
  let service: PluralService;
  let transloco: TranslocoService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [
        TranslocoTestingModule.forRoot({
          langs: { sr: {}, en: {} },
          translocoConfig: { availableLangs: ['sr', 'en'], defaultLang: 'sr' },
        }),
      ],
    });
    service = TestBed.inject(PluralService);
    transloco = TestBed.inject(TranslocoService);
  });

  it('follows the Serbian three-form rule, including the repeat on every ten', () => {
    transloco.setActiveLang('sr');
    // bez fotografija / 1 fotografija / 3 fotografije / 5 fotografija / 21 fotografija
    expect(service.photos(0)).toBe('common.photos.zero');
    expect(service.photos(1)).toBe('common.photos.one');
    expect(service.photos(3)).toBe('common.photos.few');
    expect(service.photos(5)).toBe('common.photos.other');
    expect(service.photos(21)).toBe('common.photos.one');
    expect(service.photos(22)).toBe('common.photos.few');
  });

  it('uses the English two-form rule when the language is switched', () => {
    transloco.setActiveLang('en');
    expect(service.photos(0)).toBe('common.photos.zero');
    expect(service.photos(1)).toBe('common.photos.one');
    expect(service.photos(3)).toBe('common.photos.other');
    expect(service.photos(21)).toBe('common.photos.other');
  });
});
