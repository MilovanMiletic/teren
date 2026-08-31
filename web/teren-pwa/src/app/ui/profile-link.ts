import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { Icon } from './icon';

/**
 * The way to his own account — one control, used in the two places this app keeps global chrome.
 *
 * **Why a component and not a button in the header.** The header does not exist below 768
 * (`app-header.ts`), and the foreman on a phone is the primary user. A header-only profile icon
 * would leave the only route to `/profile` on the screen class that cannot see it, which
 * `plans/profile-and-identity.md` decision 9 — *every screen is visible on every device* — does
 * not allow. So the same control is rendered twice: in the header from 768 up, and at the foot of
 * Home's scroll on a phone, beside the language switcher. That is not an invention; it is the
 * placement the language switcher already uses for exactly the same reason, and putting the two
 * beside each other means a phone has one place where "settings-ish" chrome lives rather than two.
 *
 * **Why an icon and not a row with his name on it.** The founder's F5 review (2026-08-31): the
 * centre column of Home is about entries and reports, and nothing else may compete with the record
 * button. The name it used to show is on the profile screen itself, one tap away.
 *
 * It is a real control, not a glyph: a 44 px target at its smallest (`design/tokens.md` §Touch
 * targets), an accessible name through Transloco, and the global `:focus-visible` ring.
 */
@Component({
  selector: 'app-profile-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    <button
      type="button"
      class="profile-link"
      *transloco="let t"
      [attr.aria-label]="t('common.profile')"
      (click)="open()"
    >
      <app-icon name="user" [size]="20" />
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }

    /*
     * The foot-of-Home form: a white pill on the warm canvas, the same surface treatment as the
     * language switcher standing next to it, and the same 52 px outer height so the pair reads as
     * one row rather than two controls that happen to be adjacent.
     */
    .profile-link {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 52px;
      height: 52px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: var(--color-card);
      box-shadow: var(--shadow-card);
      color: var(--color-ink-2);
      cursor: pointer;
    }

    /*
     * In the app header the bar is already white, so the control drops its own card treatment —
     * the switcher beside it does the same — and shrinks to the header's floor. 44 px, not the
     * back button's 40, because this one is reached with a thumb on a tablet as often as with a
     * mouse: design/tokens.md puts the floor for an icon button at 44.
     */
    :host(.on-header) .profile-link {
      width: var(--tap-min);
      height: var(--tap-min);
      background: var(--color-canvas);
      box-shadow: none;
    }

    @media (hover: hover) and (pointer: fine) {
      .profile-link:hover {
        color: var(--color-ink);
      }

      :host(.on-header) .profile-link:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class ProfileLink {
  private readonly router = inject(Router);

  protected open(): void {
    void this.router.navigate(['/profile']);
  }
}
