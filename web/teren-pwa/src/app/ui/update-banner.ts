import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { AppUpdateService } from '../core/update/app-update.service';
import { Icon } from './icon';

/**
 * "A new version is ready" — the one thing an installed PWA has to be able to say for itself.
 *
 * ## Why it is at the foot of the window and not the top
 *
 * The same rule `install-invitation.ts` is built around, and for a harder reason. This card
 * arrives whenever the service worker finishes a download — which is to say at a moment nobody
 * chose — and anything that appears above the content moves the record button while a thumb is
 * already travelling towards it. Fixed to the bottom, an arrival shifts nothing at all.
 *
 * ## Why it is never on screen during a recording
 *
 * `AppUpdateService.offered()` answers that, not this component: the decision is about the state
 * of the machine, and the card only draws what the decision came to. See that service for why the
 * recorder is the one thing consulted and the store is not.
 *
 * It renders nothing when there is no update, when he has said "not now", and — for the whole
 * life of a browser that never gets a deploy — always.
 */
@Component({
  selector: 'app-update-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    @if (updates.offered()) {
      <div class="update" *transloco="let t" role="status">
        <div class="card notice notice--accent update__card">
          <app-icon name="refresh" [size]="20" class="notice__icon" />
          <div class="notice__text">
            <span class="notice__title">{{ t('app.update.title') }}</span>
            <span class="t-meta">{{ t('app.update.body') }}</span>
          </div>
          <div class="update__actions">
            <button type="button" class="btn btn--tertiary btn--row" (click)="later()">
              {{ t('app.update.later') }}
            </button>
            <button type="button" class="btn btn--solid btn--row" (click)="reload()">
              {{ t('app.update.action') }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    /*
     * Pinned to the foot of the window, inside the same 640 column every screen uses, so on a
     * desktop it sits under the content rather than stretching across 1920 px of it.
     * (No backticks in this block: it is a template literal.)
     */
    .update {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: var(--z-overlay);
      width: 100%;
      max-width: var(--layout-compact);
      margin: 0 auto;
      padding: var(--page-gutter);
      padding-bottom: max(var(--page-gutter), env(safe-area-inset-bottom));
    }

    .update__card {
      flex-wrap: wrap;
      box-shadow: var(--shadow-card);
    }

    .update__actions {
      display: flex;
      gap: var(--space-2);
      margin-left: auto;
    }

    /*
     * From 1024 it moves to the bottom **right**, and that is a measurement rather than a taste.
     * Home's expanded layout is two panes and the left one — the record pane — claims the whole
     * window height, so a card centred in a 640 column at 1280 sat directly on top of the record
     * button. Covering that control is the one thing no arriving element in this app may do
     * (install-invitation.ts settles the same question for the same reason). In the corner it
     * lands over the foot of the status pane, which is a list.
     */
    @media (min-width: 1024px) {
      .update {
        left: auto;
        max-width: 26rem;
        margin: 0;
      }
    }

    @media (max-width: 519px) {
      /* Below the artboard width the two buttons take their own line rather than squeezing the
         sentence into a column two words wide. */
      .update__actions {
        width: 100%;
        margin-left: 0;
      }

      .update__actions .btn {
        flex: 1 1 0;
      }
    }
  `,
})
export class UpdateBanner {
  protected readonly updates = inject(AppUpdateService);

  protected reload(): void {
    void this.updates.apply();
  }

  protected later(): void {
    this.updates.decline();
  }
}
