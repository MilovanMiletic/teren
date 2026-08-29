import { Injectable, inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';

/**
 * Picks the plural form of a counted noun.
 *
 * Serbian has three: 1 fotografija, 2–4 fotografije, 5+ fotografija — and the rule repeats on
 * every ten, so "21 fotografija" is singular again. Hand-rolling that is how a Serbian UI ends up
 * reading like a machine, so `Intl.PluralRules` does it. Zero gets its own phrasing ("bez
 * fotografija") rather than a counted one.
 *
 * Every dictionary defines all four suffixes, so no lookup can miss.
 */
@Injectable({ providedIn: 'root' })
export class PluralService {
  private readonly transloco = inject(TranslocoService);

  /** The full translation key for a photo count, e.g. `common.photos.few`. */
  photos(count: number): string {
    return `common.photos.${this.suffix(count)}`;
  }

  private suffix(count: number): 'zero' | 'one' | 'few' | 'other' {
    if (count === 0) {
      return 'zero';
    }
    const rule = new Intl.PluralRules(this.transloco.getActiveLang()).select(count);
    return rule === 'one' ? 'one' : rule === 'few' ? 'few' : 'other';
  }
}
