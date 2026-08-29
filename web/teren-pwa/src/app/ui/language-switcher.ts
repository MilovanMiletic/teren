import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';

import { AVAILABLE_LANGUAGES, Language, activeLanguage, persistLanguage } from '../i18n';
import { Icon } from './icon';

/**
 * The SR / EN switcher — one component, used in the app header from 768 up and at the foot of
 * Home on a phone. It is a demo and development convenience (ARCHITECTURE.md §5), so it sits
 * where it is always findable but never on the capture path.
 *
 * The choice persists under `teren.language`. Dates keep the locale fixed at bootstrap, so text
 * switches at once and date formatting follows on the next load.
 */
@Component({
  selector: 'app-language-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    <div class="langs" *transloco="let t">
      <app-icon name="globe" [size]="16" class="langs__icon" />
      <span class="visually-hidden">{{ t('common.language') }}</span>
      @for (lang of languages; track lang) {
        <button
          type="button"
          class="langs__button"
          [class.langs__button--active]="lang === language()"
          [attr.aria-pressed]="lang === language()"
          (click)="switchLanguage(lang)"
        >
          {{ t('common.languageName.' + lang) }}
        </button>
      }
    </div>
  `,
  styles: `
    .langs {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-1);
      border-radius: var(--radius-pill);
      background: var(--color-card);
      box-shadow: var(--shadow-card);
      color: var(--color-ink-2);
    }

    .langs__icon {
      margin-left: 10px;
    }

    .langs__button {
      min-height: var(--tap-min);
      padding: 0 var(--space-4);
      border: 0;
      border-radius: var(--radius-pill);
      background: transparent;
      color: var(--color-ink-2);
      font-size: var(--text-meta);
      font-weight: 600;
      cursor: pointer;
    }

    .langs__button--active {
      background: var(--color-canvas);
      color: var(--color-ink);
    }

    /*
     * In the app header the switcher sits on a white bar, so it drops its own card treatment and
     * shrinks to a control — still 40 px tall, which is the desktop floor.
     */
    :host(.on-header) .langs {
      background: var(--color-canvas);
      box-shadow: none;
    }

    :host(.on-header) .langs__button {
      min-height: 40px;
      padding: 0 var(--space-3);
    }

    :host(.on-header) .langs__button--active {
      background: var(--color-card);
      color: var(--color-ink);
    }

    @media (hover: hover) and (pointer: fine) {
      .langs__button:hover:not(.langs__button--active) {
        color: var(--color-ink);
      }
    }
  `,
})
export class LanguageSwitcher {
  private readonly transloco = inject(TranslocoService);

  protected readonly languages = AVAILABLE_LANGUAGES;
  protected readonly language = signal<Language>(activeLanguage());

  protected switchLanguage(language: Language): void {
    this.transloco.setActiveLang(language);
    persistLanguage(language);
    this.language.set(language);
  }
}
