import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { CompanyLink } from './company-link';
import { Icon } from './icon';
import { LanguageSwitcher } from './language-switcher';
import { ProfileLink } from './profile-link';

/**
 * The application header, from the medium breakpoint up.
 *
 * A phone gets the artboard's per-screen bar; a tablet and a desktop get one persistent piece of
 * chrome across every screen — wordmark, which site you are on, the date, and the language
 * switcher — because that is what an application looks like on a wide screen and a floating
 * phone column is not.
 *
 * Hidden below 768: the compact layout the founder approved is untouched by this component.
 * That is why the profile control it carries is rendered a second time at the foot of Home's
 * scroll — see `profile-link.ts`. A control that lives only here is a control a foreman on a phone
 * does not have.
 */
@Component({
  selector: 'app-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CompanyLink, DatePipe, Icon, LanguageSwitcher, ProfileLink, TranslocoDirective],
  host: { '(document:visibilitychange)': 'refresh()' },
  template: `
    <header class="header" *transloco="let t">
      <div class="header__inner column">
        <span class="header__brand">{{ t('app.name') }}</span>

        @if (showBack()) {
          <button
            type="button"
            class="btn-icon header__back"
            [attr.aria-label]="t('common.back')"
            (click)="back.emit()"
          >
            <app-icon name="chevron-left" [size]="20" />
          </button>
        }

        @if (project(); as name) {
          @if (pickable()) {
            <button
              type="button"
              class="header__project header__project--pickable"
              aria-haspopup="dialog"
              [attr.aria-label]="t('home.project.change')"
              (click)="choose.emit()"
            >
              <span class="header__project-name">{{ name }}</span>
              <app-icon name="chevron-down" [size]="18" />
            </button>
          } @else {
            <span class="header__project">
              <span class="header__project-name">{{ name }}</span>
            </span>
          }
        }

        <span class="header__spacer"></span>
        <span class="t-meta t-num header__date">{{ now() | date: 'EEEE, d. M. y.' }}</span>
        <app-language-switcher class="on-header" />
        <!--
          The office, for the one person who has one. It renders itself away for everybody else
          (company-link.ts), so this is not a control a foreman ever meets.
        -->
        <app-company-link class="on-header" />
        @if (showProfile()) {
          <app-profile-link class="on-header" />
        }
      </div>
    </header>
  `,
  styles: `
    :host {
      display: none;
    }

    @media (min-width: 768px) {
      :host {
        display: block;
        /*
         * Static, not sticky: the header reserves its full height in normal flow and content
         * begins below it. A sticky header would pass over the content on scroll, which is the
         * overlap this layout is not allowed to have. Relative positioning plus the header layer
         * keeps it above any content that paints near it.
         */
        position: relative;
        z-index: var(--z-header);
      }
    }

    .header {
      background: var(--color-card);
      box-shadow: var(--shadow-card);
    }

    .header__inner {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--header-height);
      padding-top: var(--space-2);
      padding-bottom: var(--space-2);
    }

    .header__brand {
      flex: none;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .header__back {
      width: 40px;
      height: 40px;
      background: var(--color-canvas);
      box-shadow: none;
    }

    .header__project {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--color-ink);
      text-align: left;
    }

    .header__project--pickable {
      min-height: 40px;
      padding: 0 var(--space-3);
      border-radius: var(--radius-pill);
      background: var(--color-canvas);
      color: var(--color-ink-2);
      cursor: pointer;
    }

    .header__project-name {
      font-size: var(--text-body);
      font-weight: 600;
      color: var(--color-ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .header__spacer {
      flex: 1 1 auto;
    }

    .header__date {
      flex: none;
    }

    /* The date is the first thing to go when the bar gets tight. */
    @media (max-width: 899px) {
      .header__date {
        display: none;
      }
    }

    @media (hover: hover) and (pointer: fine) {
      .header__project--pickable:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class AppHeader {
  /** The site to show: the address on Home, the project name on a subscreen. */
  readonly project = input<string | null>(null);
  /** Whether the site is the project picker (Home) or just context (everywhere else). */
  readonly pickable = input(false);
  readonly showBack = input(false);
  /**
   * Whether to offer the way to his own account.
   *
   * True everywhere but on the profile screen itself: a control that navigates to the screen you
   * are already standing on is noise, and on a 44 px target it is noise a thumb can hit.
   */
  readonly showProfile = input(true);

  readonly back = output<void>();
  readonly choose = output<void>();

  protected readonly now = signal(new Date());

  /** A tablet left on a windowsill overnight must not still show yesterday. */
  protected refresh(): void {
    this.now.set(new Date());
  }
}
