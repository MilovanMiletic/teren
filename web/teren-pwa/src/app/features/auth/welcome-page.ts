import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

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
 * **No guard on this route in F3.** It is reachable by typing the URL and by nothing else, so the
 * demo is untouched; F4 adds the `canMatch` gate that sends an un-activated phone here.
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

  protected signIn(): void {
    void this.router.navigate(['/login']);
  }

  protected join(): void {
    void this.router.navigate(['/activate']);
  }
}
