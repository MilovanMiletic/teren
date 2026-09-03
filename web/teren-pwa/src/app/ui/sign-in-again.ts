import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { AdminSessionService } from '../core/session/admin-session.service';
import { Icon } from './icon';

/**
 * The way back to `/login` from the card that says the session is gone.
 *
 * ## The hole it fills
 *
 * `CompanyService`/`PlatformService` sign an admin out on a 401 — one `localStorage` row, no
 * evidence touched — and the screen he is standing on then draws its "the server could not be
 * read" card with `company.reason.signedOut` under it: *"Prijavite se ponovo."* That sentence was
 * an instruction with nothing to press.
 *
 * On an office tablet it does not matter much: `session-link.ts` in the chrome has already turned
 * from **Sign out** into **Sign in**, because that browser holds no device session. **The ordinary
 * case is the other one** — the owner-foreman's own phone, activated as a device *and* signed in
 * as an admin, which `company-link.ts` names as exactly the population this surface is built for.
 * There `session-link` renders nothing at all by design (a foreman has no password, plan decision
 * 4), so after the 401 the only control that could have carried him to `/login` is deliberately
 * absent — and one reload later `requiresCompanyAdmin` puts him on Home with no admin chrome on
 * screen whatsoever.
 *
 * So the control goes where the user already is: in the sentence that just told him to sign in.
 *
 * ## Why it decides for itself
 *
 * Seven screens draw that card. Passing each of them a boolean would be seven chances to pass the
 * wrong one, and the condition is not really "which reason is on screen" — it is *"is there an
 * admin credential right now"*, which is one question with one answer. `signedIn()` is a method
 * and not a computed for the reason `session-link.ts` gives: it reads the session's expiry against
 * the clock, and a computed would cache "yes" for thirty days of wall time.
 *
 * A 403 leaves the session intact, so nothing renders — signing in again cannot fix a role, and
 * offering it would send an owner round a loop instead of to the person who can change his rights.
 *
 * **The chrome rule is untouched.** `session-link` still renders nothing for a device session;
 * this is not chrome, it is part of one failure card, and it disappears with the card.
 */
@Component({
  selector: 'app-sign-in-again',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    @if (offered()) {
      <button
        type="button"
        class="btn btn--tertiary btn--row sign-in"
        *transloco="let t"
        (click)="signIn()"
      >
        <app-icon name="log-in" [size]="18" />
        <span>{{ t('common.signIn') }}</span>
      </button>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    /*
     * A third flex item in the notice card, beside the icon and the text.
     *
     * The width: auto is the load-bearing line and it is not obvious: the base .btn class sets
     * width: 100%, because almost every button in this app is a full-width block on a phone.
     * Left at that, this one measured 1116 px inside a 1148 px card at 1280, and at 390 it ran
     * wider than the card and was silently clipped by the card's own overflow: hidden — a
     * control the man was told to press, cut off at the edge. Measured, not reasoned about.
     * (No backticks in this block: it is a template literal.)
     */
    .sign-in {
      flex: none;
      width: auto;
      align-self: center;
    }
  `,
})
export class SignInAgain {
  private readonly router = inject(Router);
  private readonly admins = inject(AdminSessionService);

  /** Whether there is no admin credential to lose — the one condition a sign-in helps. */
  protected offered(): boolean {
    return !this.admins.signedIn();
  }

  protected signIn(): void {
    void this.router.navigate(['/login']);
  }
}

