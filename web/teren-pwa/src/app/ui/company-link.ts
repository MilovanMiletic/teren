import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { AdminSessionService } from '../core/session/admin-session.service';
import { Icon } from './icon';

/**
 * The way to the office — rendered **only for a signed-in company admin**, in the two places this
 * app keeps global chrome.
 *
 * ## Where it hangs, and why there
 *
 * Beside `app-profile-link`, in the app header from 768 up and at the foot of Home's scroll below
 * it. Three reasons, in order of weight:
 *
 * 1. **Home's centre column is only entries and reports** (founder, 2026-08-31). Admin chrome on
 *    the capture path is exactly what that instruction rules out, and the foot of the scroll is
 *    where the language switcher and the profile control already live for the same reason.
 * 2. **The header does not exist below 768**, so a header-only control would be invisible on the
 *    device class the plan's decision 9 says every screen must serve.
 * 3. It is the same shape of thing as the profile link — "where do I go that is not this screen" —
 *    and putting the two together means a phone has one place where chrome lives rather than two.
 *
 * ## Why it renders itself away
 *
 * `AdminSessionService.isCompanyAdmin()` is read synchronously from `localStorage`, so the control
 * is either there on the first frame or never. **A foreman never sees it**, which matters beyond
 * tidiness: the route it points at answers him with a redirect to Home, and a control that visibly
 * does nothing is worse than no control at all.
 *
 * The ordinary case for it is the founder's own phone — activated as a device *and* signed in as
 * an admin. An admin on an office tablet has no device session, so he never sees Home or the
 * header at all; he arrives at `/company` from the login screen and stays there.
 */
@Component({
  selector: 'app-company-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    @if (visible()) {
      <button
        type="button"
        class="company-link"
        *transloco="let t"
        [attr.aria-label]="t('company.title')"
        (click)="open()"
      >
        <app-icon name="phone-home" [size]="20" />
      </button>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }

    /* The foot-of-Home form: the same 52 px white pill the language switcher and the profile
       control wear, so the three read as one row rather than three adjacent controls. */
    .company-link {
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

    /* In the app header the bar is already white, so the control drops its card treatment and
       shrinks to the 44 px floor design/tokens.md sets for an icon button. */
    :host(.on-header) .company-link {
      width: var(--tap-min);
      height: var(--tap-min);
      background: var(--color-canvas);
      box-shadow: none;
    }

    @media (hover: hover) and (pointer: fine) {
      .company-link:hover {
        color: var(--color-ink);
      }

      :host(.on-header) .company-link:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class CompanyLink {
  private readonly router = inject(Router);
  private readonly admins = inject(AdminSessionService);

  /** A method, not a computed: the answer depends on the session's expiry, which is a clock. */
  protected visible(): boolean {
    return this.admins.isCompanyAdmin();
  }

  protected open(): void {
    void this.router.navigate(['/company']);
  }
}
