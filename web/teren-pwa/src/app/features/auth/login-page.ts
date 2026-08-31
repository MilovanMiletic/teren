import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { ActivationService, AuthFailure } from '../../core/auth/activation.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { AuthMark } from './auth-mark';

/**
 * Signing in with an email address and a password (`design/Login.dc.html`).
 *
 * ## Who this screen is for, and who it is not for
 *
 * The two admin roles — the owner of the company, and Teren's own staff — and nobody else. **A
 * worker must never see a password field**: he has none, by database constraint
 * (`ck_app_user_worker_has_no_password`, §4), because a second door into the diary is exactly
 * what the device model exists to avoid. That is why this screen carries the join-by-code path in
 * plain sight: a foreman who lands here by following the wrong link needs a way out that is not a
 * password reset.
 *
 * ## What happens after a successful sign-in, stated plainly
 *
 * Nothing is stored, and the screen says so. `Session` describes a *device* bound to a worker;
 * writing an admin session token into that slot would make every `/api` call claim a device this
 * phone does not have. The admin surfaces arrive at F5–F7 and bring that decision with them —
 * see `ActivationService.login`.
 *
 * ## The omission a reviewer should expect to notice
 *
 * The artboard carries "Zaboravljena lozinka?". It is **not** on this screen, because
 * `/auth/password-reset` does not exist yet and needs an SMTP relay that has not been chosen
 * (§9, §13.1). A link that visibly does nothing is worse than an absence on the one screen whose
 * whole job is to be trusted with a credential; it comes back with D7.
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthMark, Icon, LanguageSwitcher, TranslocoDirective],
  templateUrl: './login-page.html',
  styleUrls: ['./auth-layout.css', './auth-form.css', './login-page.css'],
})
export class LoginPage {
  private readonly router = inject(Router);
  private readonly activation = inject(ActivationService);
  protected readonly connectivity = inject(ConnectivityService);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly reveal = signal(false);
  protected readonly touched = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal<AuthFailure | null>(null);
  protected readonly signedInAs = signal<string | null>(null);

  protected readonly emailGiven = computed(() => this.email().trim().length > 0);
  protected readonly passwordGiven = computed(() => this.password().length > 0);

  protected readonly errorKey = computed<string | null>(() => {
    if (this.touched() && !this.emailGiven()) {
      return 'auth.login.emailRequired';
    }
    if (this.touched() && !this.passwordGiven()) {
      return 'auth.login.passwordRequired';
    }
    const failure = this.failure();
    return failure ? `auth.login.error.${failure}` : null;
  });

  protected back(): void {
    void this.router.navigate(['/welcome']);
  }

  protected join(): void {
    void this.router.navigate(['/activate']);
  }

  protected onEmail(value: string): void {
    this.email.set(value);
    this.failure.set(null);
  }

  protected onPassword(value: string): void {
    this.password.set(value);
    this.failure.set(null);
  }

  /**
   * Show the password.
   *
   * Not a nicety on a phone: a long password typed on a glass keyboard is wrong about a third of
   * the time, and the alternative to revealing it is retyping it blind. It defaults to hidden and
   * is never remembered between visits.
   */
  protected toggleReveal(): void {
    this.reveal.update((shown) => !shown);
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    void this.submit();
  }

  protected async submit(): Promise<void> {
    if (this.busy()) {
      return;
    }

    this.touched.set(true);
    this.failure.set(null);
    this.signedInAs.set(null);

    if (!this.emailGiven() || !this.passwordGiven()) {
      return;
    }

    this.busy.set(true);
    const result = await this.activation.login(this.email(), this.password());
    this.busy.set(false);

    if (!result.ok) {
      this.failure.set(result.failure);
      return;
    }

    // The password is not kept a moment longer than the request that used it.
    this.password.set('');
    this.reveal.set(false);
    this.signedInAs.set(result.displayName ?? this.email().trim());
  }
}
