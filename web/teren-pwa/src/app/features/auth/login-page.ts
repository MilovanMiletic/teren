import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { ActivationService, AuthFailure } from '../../core/auth/activation.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { RETURN_URL_PARAM, safeReturnUrl } from '../../core/session/return-url';
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
 * **A company admin is taken to his office** (`/company`, F6), or to wherever `?next=` said he was
 * going. That is the redirect this file's previous comment promised for "the day an admin session
 * is stored", and F6 is that day: `ActivationService.login` now writes an `AdminSession` under its
 * own key — never into `SessionService`, which describes a *device* bound to a worker and whose
 * token every `/api` call sends as this phone's bearer.
 *
 * **A super admin is not.** He signs in perfectly well and his surface is F7, so the screen says
 * so and stops. Sending him to `/company` would be sending him to a screen whose every request the
 * server answers 403 — a redirect into a wall, which is worse than a sentence.
 *
 * Neither case navigates to Home. A sign-in leaves `SessionService.activated()` false, so a
 * redirect there would be turned round by the gate and land the man back on Welcome — the app
 * bouncing him between two screens as its way of saying "it worked".
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
  private readonly route = inject(ActivatedRoute);
  private readonly activation = inject(ActivationService);
  protected readonly connectivity = inject(ConnectivityService);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly reveal = signal(false);
  protected readonly touched = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal<AuthFailure | null>(null);
  protected readonly signedInAs = signal<string | null>(null);
  /**
   * Signed in, with nowhere in this build to go — a super admin, whose surface is F7.
   *
   * A separate signal from {@link signedInAs} because the two sentences differ: one says the
   * credential was accepted, the other says this version of the app has no screen for his role.
   * A company admin never sees the second, because he is already on `/company` by then.
   */
  protected readonly awaitingSurface = signal(false);

  protected readonly emailGiven = computed(() => this.email().trim().length > 0);
  protected readonly passwordGiven = computed(() => this.password().length > 0);

  /**
   * Whether the form may complain about a missing field.
   *
   * **Not simply `touched()`, and the difference is a defect the founder photographed.** A
   * successful sign-in clears the password — it is not kept a moment longer than the request that
   * used it — and the empty field then satisfied `touched() && !passwordGiven()`, so the screen
   * showed "Prijava je uspela" and "Upišite lozinku" side by side with the field ringed red: one
   * successful login, and the form demanding a password it had deleted itself.
   *
   * {@link submit} also clears `touched` on success, which is the primary fix. This guard is the
   * one that survives the next edit: any later path that leaves `touched` set while a sign-in
   * stands — a second submit, a field cleared programmatically — still cannot make the screen
   * contradict itself.
   */
  protected readonly validating = computed(() => this.touched() && this.signedInAs() === null);

  protected readonly errorKey = computed<string | null>(() => {
    if (this.validating() && !this.emailGiven()) {
      return 'auth.login.emailRequired';
    }
    if (this.validating() && !this.passwordGiven()) {
      return 'auth.login.passwordRequired';
    }
    const failure = this.failure();
    return failure ? `auth.login.error.${failure}` : null;
  });

  /** Back to Welcome with `?next=` intact — see `ActivatePage.back` for why it is preserved. */
  protected back(): void {
    void this.router.navigate(['/welcome'], { queryParamsHandling: 'preserve' });
  }

  /**
   * The way out for a foreman who followed the wrong link — carrying his destination with him.
   *
   * He is the man `?next=` was written for: the gate sent him to Welcome holding the URL of an
   * entry, he tapped the wrong door, and the parameter has to survive both taps or he arrives
   * activated and none the wiser about where he was going.
   */
  protected join(): void {
    void this.router.navigate(['/activate'], { queryParams: this.forward() });
  }

  /** The return URL, re-validated at this hop. Same rule, same reason as `WelcomePage.forward`. */
  private forward(): Params {
    const next = safeReturnUrl(this.route.snapshot.queryParamMap.get(RETURN_URL_PARAM));
    return next ? { [RETURN_URL_PARAM]: next } : {};
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
    // …and the form stops being a form he has to complete. Clearing the password while leaving
    // this set is what put "Upišite lozinku" under "Prijava je uspela", with the field ringed red.
    this.touched.set(false);
    this.signedInAs.set(result.displayName ?? this.email().trim());

    if (result.role === 'company_admin') {
      // His office, or the deep link that sent him here. `safeReturnUrl` again at this hop: the
      // parameter arrives from outside far more often than it arrives from the gate, and this is
      // the read that actually navigates.
      const next = safeReturnUrl(this.route.snapshot.queryParamMap.get(RETURN_URL_PARAM));
      void (next
        ? this.router.navigateByUrl(next)
        : this.router.navigate(['/company']));
      return;
    }

    // A super admin. The credential is stored and good; `/platform` is F7, so the screen says
    // that rather than sending him somewhere that would only answer 403.
    this.awaitingSurface.set(true);
  }
}
