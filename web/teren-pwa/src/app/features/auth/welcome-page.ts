import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { RETURN_URL_PARAM, safeReturnUrl } from '../../core/session/return-url';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { AuthMark } from './auth-mark';

/**
 * The first screen a phone that is not yet part of a company can be shown
 * (`design/Welcome.dc.html`).
 *
 * Two paths and nothing else: sign in with an email address, or join a site with a code. Which
 * one a person needs is decided by who he is — a foreman has a code and never a password, an
 * owner has a password and never a code — so the screen names both plainly rather than guessing.
 *
 * **Order and hierarchy are the artboard's**, not this component's opinion. Sign-in is the
 * primary pill and joining is the white one, because that is what the founder approved. It is
 * worth a founder's second look now that the roles are real: the men who will meet this screen
 * most often are the ones holding a code.
 *
 * **Since F4 this is where the gate sends an un-activated phone**, and it is a waypoint rather
 * than a destination: the URL the man was trying to reach arrives on `?next=` and has to survive
 * the tap that takes him onwards, or a link to one entry becomes a landing on Home two screens
 * later. Both buttons carry it through; `safeReturnUrl` decides whether it may be carried at all.
 */
@Component({
  selector: 'app-welcome-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthMark, Icon, LanguageSwitcher, TranslocoDirective],
  templateUrl: './welcome-page.html',
  styleUrls: ['./auth-layout.css', './welcome-page.css'],
})
export class WelcomePage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected signIn(): void {
    void this.router.navigate(['/login'], { queryParams: this.forward() });
  }

  protected join(): void {
    void this.router.navigate(['/activate'], { queryParams: this.forward() });
  }

  /**
   * The return URL, re-validated before it is passed on.
   *
   * Validating again rather than trusting what is already in the address bar: this screen is
   * reachable by typing its URL, so `?next=` here is whatever a link said it was, and the value
   * is about to be written into another link. Cleaning it at every hop keeps the rule in one
   * place instead of relying on every producer having applied it.
   */
  private forward(): Params {
    const next = safeReturnUrl(this.route.snapshot.queryParamMap.get(RETURN_URL_PARAM));
    return next ? { [RETURN_URL_PARAM]: next } : {};
  }
}
