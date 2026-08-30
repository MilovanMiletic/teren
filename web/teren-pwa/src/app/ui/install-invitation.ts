import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { InstallService } from '../core/install/install.service';
import { Icon } from './icon';

/**
 * The one place the app admits it can be installed.
 *
 * Until this existed, nothing ever told a foreman there was anything to install — so he never got
 * offline, never got a home-screen icon, and Phase 1's test (PROJECT.md §8: three weeks without
 * being reminded) was being run against a bookmark.
 *
 * Placement is deliberate and is the constraint the design is built around. It renders at the
 * **foot** of Home, after the recent entries, and never above them. An invitation that appears
 * asynchronously — which this one must, because Chromium fires its event whenever it likes — and
 * that sits anywhere above the record button would move that button under a thumb already on its
 * way down. Nothing on this screen is allowed to do that to the one control the screen exists
 * for. Below the last row, an arrival shifts nothing.
 *
 * It renders nothing at all inside an installed app, on a browser with no offer, or for anyone
 * who has already said no — see `InstallService`.
 */
@Component({
  selector: 'app-install-invitation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (invitation(); as kind) {
        <!-- The heading names the card; an aria-label repeating it would only be read twice. -->
        <section class="card notice notice--accent install">
          <app-icon name="phone-home" [size]="20" class="notice__icon" />
          <div class="notice__text">
            <h2 class="notice__title install__title">{{ t('app.install.title') }}</h2>
            <p class="t-meta install__body">{{ t('app.install.body') }}</p>

            @if (kind === 'ios') {
              <!--
                iOS never fires an install event and never offers anything, so the gesture is
                named instead. The glyph matters as much as the words: he is looking for a button
                in Safari's toolbar, not reading a manual.
              -->
              <p class="install__steps" aria-hidden="true">
                <span class="install__step">
                  <app-icon name="share" [size]="16" />
                  <span>{{ t('app.install.ios.share') }}</span>
                </span>
                <app-icon name="chevron-right" [size]="14" class="install__arrow" />
                <span class="install__step">
                  <app-icon name="plus" [size]="16" />
                  <span>{{ t('app.install.ios.add') }}</span>
                </span>
              </p>
              <!-- The same instruction as one sentence, for anyone the chips do not reach. -->
              <span class="visually-hidden">{{ t('app.install.ios.hint') }}</span>
            }

            <div class="install__actions">
              @if (kind === 'prompt') {
                <button
                  type="button"
                  class="btn btn--primary btn--row install__accept"
                  (click)="accept()"
                >
                  {{ t('app.install.action') }}
                </button>
              }
              <button
                type="button"
                class="btn btn--tertiary btn--row install__dismiss"
                (click)="dismiss()"
              >
                {{ t('app.install.dismiss') }}
              </button>
            </div>
          </div>
        </section>
      }
    </ng-container>
  `,
  styles: `
    /*
     * display:contents, not display:block. Home's content column is a flex stack with a gap, so
     * a host that still had a box when the invitation is hidden — which is the normal case —
     * would open a dead 12 px hole under the last row on every phone that already has the app.
     */
    :host {
      display: contents;
    }

    .install__title {
      margin: 0;
    }

    .install__body {
      margin: 0;
    }

    /* The two Safari steps, in the order he performs them. */
    .install__steps {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin: var(--space-3) 0 0;
    }

    .install__step {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-pill);
      background: var(--color-card);
      color: var(--color-ink);
      font-size: var(--text-meta);
      font-weight: 600;
    }

    .install__arrow {
      color: var(--color-ink-2);
    }

    .install__actions {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      margin-top: var(--space-4);
    }

    /*
     * Compact: full-width stacked buttons, thumb-sized. From medium up there is room for the
     * pair to sit on one line, so they stop pretending to be a phone's action stack and shrink
     * to their labels.
     */
    @media (min-width: 768px) {
      .install__actions {
        flex-direction: row;
        align-items: center;
      }

      .install__actions .btn {
        width: auto;
        padding: 0 var(--space-6);
      }
    }

    /*
     * Expanded: this sits at the foot of Home's secondary pane, where it is one card among
     * several rather than the end of a scroll. A little more room inside it, matching the other
     * cards on that pane.
     */
    @media (min-width: 1024px) {
      .install {
        padding: var(--space-5);
      }
    }
  `,
})
export class InstallInvitation {
  private readonly install = inject(InstallService);

  protected readonly invitation = this.install.invitation;

  protected accept(): void {
    void this.install.install();
  }

  protected dismiss(): void {
    this.install.dismiss();
  }
}
