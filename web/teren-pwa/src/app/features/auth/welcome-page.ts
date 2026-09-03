import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { readDeviceRefusal } from '../../core/session/device-refusal';
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
 *
 * ## And since 2026-09-03 it is also where a phone that has just been refused lands
 *
 * By founder decision a phone whose credential the server refuses signs itself out
 * (`core/session/device-refusal.service.ts`), so this screen now has two arrivals that need
 * opposite copy: a phone nobody has ever activated, and a phone that was working five seconds
 * ago and has had the record button taken away from it. It cannot tell them apart by itself —
 * both hold no session — so the refusal leaves a note and {@link WelcomePage.refused} reads it.
 *
 * **The note is a condition, not a message, so this screen only reads it.** It says *this phone
 * holds no credential because the server refused one*, which stays true until an activation makes
 * it false — and `ActivationService.activate` is the one place that clears it. Nothing here
 * consumes it. The first cut did (a take-once read, on the `ArrivalHandoff` model) and the review
 * caught what that costs: the man is signed out mid-shift, pockets the phone, iOS discards the
 * tab, he reopens the app, `requiresDevice` puts him back here — and he reads the plain first-run
 * screen with no record button and no explanation, which is the exact complaint this increment
 * exists to answer, one reload later. Tapping "Prijavi se" and coming back did the same. A
 * handoff between two screens inside one navigation is a different thing from a durable state.
 *
 * **The sentence names no cause, deliberately.** The 401 behind it is reasonless by design: a
 * revoked phone, a removed worker and a suspended company are byte-identical from here, and §7
 * makes them so on purpose because "revoked" versus "unknown" is an account-enumeration oracle. So
 * the copy says the two things that are certainly true — nothing recorded has been lost, and a new
 * code is the way back — and invents nothing else. The title is the sentence Home already uses for
 * the same fact (`home.reactivate.title`), so a man who has seen one recognises the other.
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

  /**
   * Whether this phone was signed out by the server rather than simply never activated.
   *
   * **Read, never consumed** — see the file comment for the reload that argument was lost on. The
   * note describes a condition that is still true every time this screen is drawn, and it is
   * cleared exactly where it stops being true: a successful activation.
   *
   * Read at construction rather than in the template, because the answer cannot change while this
   * screen is on it — the only thing that clears the note navigates away from here. A signal
   * because the template is `OnPush`.
   */
  protected readonly refused = signal(readDeviceRefusal() !== null);

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
