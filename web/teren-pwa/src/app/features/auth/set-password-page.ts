import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { ActivationService, AuthFailure } from '../../core/auth/activation.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { AuthMark } from './auth-mark';

/** The one query parameter this screen reads. Both sides import it; neither spells it out. */
export const SET_PASSWORD_TOKEN_PARAM = 'token';

/**
 * Twelve characters, matching `PasswordPolicy.MinimumLength` on the server.
 *
 * Repeated here rather than fetched, because the screen has to be able to say "not long enough"
 * *before* it sends — and a client that could only learn the rule by being refused would make a
 * man submit a passphrase, wait, and be told to try again. The server remains the authority; this
 * is the same number said sooner. A test pins the pair.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * `/set-password` — where an invite link lands (F7).
 *
 * ## Why this screen has to exist
 *
 * The backend has minted `{appUrl}/set-password?token=…` since D2, and **nothing served that
 * path**: it fell through the wildcard to Home, whose gate sent an admin to `/welcome`, which
 * offers a foreman's join-by-code. An invited administrator therefore could not complete his own
 * onboarding — the only way anybody got a password was the founder calling `POST /auth/password`
 * by hand. The whole chain (staff adds an admin → link → he signs in → he adds his foremen)
 * stopped dead in the middle, and it looked built because every other piece of it was.
 *
 * ## Unguarded, deliberately
 *
 * Like `/activate`, and for a sharper reason: the man opening this link **has no credential at
 * all** — that is the entire point of the link. `requiresNoDevice` would be wrong too, because the
 * founder's own phone may hold a device session while he opens a link for somebody else.
 *
 * ## What it does not do
 *
 * **It does not sign him in.** Setting a password revokes every existing session for the account —
 * the reset path exists precisely for the case where somebody else may hold a credential — so
 * adopting one here would adopt a session the server has just withdrawn. He goes to `/login` and
 * types the passphrase he just chose, which is also the only proof he typed the one he meant.
 *
 * ## One field, not two
 *
 * No "confirm password" field. A confirmation catches a typo that the reveal toggle catches
 * better, and it doubles the typing on a phone keyboard for a man who is already being asked to
 * invent a passphrase.
 *
 * **But the typo has to be caught, because the link is single-use.** Mistype it here and the
 * password is set to something he does not know, the token is spent, and his only way back is
 * asking the founder for another link. So the reveal is not a convenience on this screen the way
 * it is on `/login` — it is the safeguard, which is why it starts **on**.
 */
@Component({
  selector: 'app-set-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthMark, Icon, LanguageSwitcher, TranslocoDirective],
  templateUrl: './set-password-page.html',
  styleUrls: ['./auth-layout.css', './auth-form.css', './set-password-page.css'],
})
export class SetPasswordPage {
  private readonly activation = inject(ActivationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly connectivity = inject(ConnectivityService);

  /** Read once, from the URL that opened this screen. */
  private readonly token = this.route.snapshot.queryParamMap.get(SET_PASSWORD_TOKEN_PARAM) ?? '';

  protected readonly password = signal('');
  /**
   * Revealed by default, and this is the deliberate opposite of the login screen.
   *
   * There he is retyping something he knows and a shoulder is the risk. Here he is *inventing* a
   * passphrase he will have to type again in thirty seconds, on a link that is **single-use** — a
   * typo he cannot see costs him the link, and getting another one means asking the founder.
   */
  protected readonly reveal = signal(true);
  protected readonly busy = signal(false);
  protected readonly touched = signal(false);
  protected readonly failure = signal<AuthFailure | null>(null);
  /** His address, once the server has confirmed it. The cue that it worked. */
  protected readonly done = signal<string | null>(null);

  /** No token in the URL at all: somebody typed the path, or a mail client mangled the link. */
  protected readonly noToken = computed(() => this.token.trim() === '');

  protected readonly tooShort = computed(
    () => this.password().length > 0 && this.password().length < MINIMUM_PASSWORD_LENGTH,
  );

  protected readonly canSubmit = computed(
    () =>
      !this.busy() &&
      !this.noToken() &&
      this.password().length >= MINIMUM_PASSWORD_LENGTH,
  );

  protected readonly failureKey = computed(() => {
    const failure = this.failure();
    return failure === null ? null : `auth.setPassword.error.${failure}`;
  });

  protected onPassword(value: string): void {
    this.password.set(value);
    this.touched.set(true);
    this.failure.set(null);
  }

  protected toggleReveal(): void {
    this.reveal.update((on) => !on);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.touched.set(true);

    if (!this.canSubmit()) {
      return;
    }

    this.busy.set(true);
    const result = await this.activation.setPassword(this.token, this.password());
    this.busy.set(false);

    if (!result.ok) {
      this.failure.set(result.failure);
      return;
    }

    // The passphrase does not outlive the request that used it.
    this.password.set('');
    this.done.set(result.email);
  }

  protected goToLogin(): void {
    void this.router.navigate(['/login']);
  }
}
