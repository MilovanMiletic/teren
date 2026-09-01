import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { AdminSessionService } from '../core/session/admin-session.service';
import { Icon } from './icon';

/**
 * The way to Teren's own surface — rendered **only for a signed-in super admin**, in the two
 * places this app keeps global chrome.
 *
 * ## Why it exists at all, which is the part worth writing down
 *
 * F7 shipped `/platform`, `/platform/companies` and `/platform/user/:userId`, all reachable, all
 * gated correctly, all rendering real data — and **nothing anywhere in the app pointed at any of
 * them.** The only navigation that ever reached `/platform` was the one `login-page.ts` performs
 * on a successful sign-in, so the surface existed for exactly as long as the founder stayed on it.
 * Reload, or tap Home, and it was gone until he typed the URL again.
 *
 * That is what "the pages aren't wired in" meant on 2026-09-01, and it is a whole class of defect
 * a route table cannot catch: `app.routes.spec.ts` proves every *navigation* resolves to a route,
 * which is the opposite direction. **A route with no navigation into it is invisible to every
 * guard in this repo.** `company-link.ts` is this component's twin and answers the same problem
 * for `/company`; the office got one at F6 and the platform did not.
 *
 * ## Where it hangs, and why there
 *
 * Beside `app-company-link` and `app-profile-link`: in the app header from 768 up, and at the foot
 * of Home's scroll below it. The three arguments are `company-link.ts`'s, unchanged — Home's
 * centre column is entries and reports only, the header does not exist below 768, and chrome
 * belongs in one place rather than two.
 *
 * ## Why it renders itself away
 *
 * `AdminSessionService.isSuperAdmin()` is read synchronously from `localStorage`, so the control
 * is either there on the first frame or never. **A company admin never sees it**, and neither does
 * a foreman: `/platform` answers both with a redirect, and a control that visibly does nothing is
 * worse than no control at all.
 *
 * **Not "company admin or better".** The roles are not a hierarchy — the same rule
 * `requiresSuperAdmin` is written to, and for the same reason: a super admin has no company by
 * construction and is refused by every evidence route on purpose.
 *
 * The ordinary case for it is the founder's own browser, which is a demo phone *and* the platform
 * console at the same time. A member of staff on an office machine has no device session, so he
 * never sees Home or the header at all; he arrives at `/platform` from the login screen and stays.
 */
@Component({
  selector: 'app-platform-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    @if (visible()) {
      <button
        type="button"
        class="platform-link"
        *transloco="let t"
        [attr.aria-label]="t('platform.title')"
        (click)="open()"
      >
        <app-icon name="building" [size]="20" />
      </button>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }

    /* The foot-of-Home form: the same 52 px white pill the language switcher, the office link and
       the profile control wear, so they read as one row rather than four adjacent controls. */
    .platform-link {
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
    :host(.on-header) .platform-link {
      width: var(--tap-min);
      height: var(--tap-min);
      background: var(--color-canvas);
      box-shadow: none;
    }

    @media (hover: hover) and (pointer: fine) {
      .platform-link:hover {
        color: var(--color-ink);
      }

      :host(.on-header) .platform-link:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class PlatformLink {
  private readonly router = inject(Router);
  private readonly admins = inject(AdminSessionService);

  /** A method, not a computed: the answer depends on the session's expiry, which is a clock. */
  protected visible(): boolean {
    return this.admins.isSuperAdmin();
  }

  protected open(): void {
    void this.router.navigate(['/platform']);
  }
}
