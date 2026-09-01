import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { AdminSessionService } from '../core/session/admin-session.service';
import { SessionService } from '../core/session/session.service';
import { Icon } from './icon';

/**
 * The office session, as **one** control: the way out when there is a sign-in, the way in when
 * there is not, and nothing at all for the man who has neither.
 *
 * ## Why one control and not two
 *
 * The founder's F7 note was *"the login button should be on the header"*, said while looking at a
 * sign-*out* card at the foot of `/company`'s right rail. Sign-in and sign-out are the same
 * affordance seen from the two sides of one state, so they are one component with one place in
 * the chrome. Two controls would mean two places to look and a screen that has to decide which of
 * them is live; this way the state decides, and the rail keeps nothing that duplicates it.
 *
 * ## The three states, and why the third one is silence
 *
 * | state | what renders | why |
 * |---|---|---|
 * | an admin session | **Sign out** | the credential this control is about |
 * | no session at all | **Sign in** | he is looking at a screen his session expired out from under |
 * | a device session only | *nothing* | see below |
 *
 * **A foreman is never offered a sign-in.** He does not have one: `plans/profile-and-identity.md`
 * decision 4 gives passwords to admins only, and a foreman joins once with a code and never signs
 * in again. Whether he should nevertheless see one before M2 is an open founder question
 * (CLAUDE.md §Founder-veto queue), and this component does not pre-empt it: it renders itself
 * away, exactly as `company-link.ts` does for the same population.
 *
 * **The second reason this row used to give is now false, and its removal is the point.** It said
 * a "Prijavi se" here would be a dead control, because `requiresNoDevice` bounced an activated
 * phone straight back out of `/login`. It did — and since the founder's own browser is a demo
 * phone as well as the platform console, that bounce was the thing that made the whole admin
 * surface unreachable on the one machine this product is administered from (2026-09-01).
 * `/login` is now guarded on the *admin* session (`requiresNoAdminSession`), so a control here
 * would work. It stays absent on the founder's open question alone, which is a decision rather
 * than a mechanism — and the way back to the platform is `platform-link.ts`, which is visible
 * precisely to the man who has somewhere to go.
 *
 * The middle row is not theoretical. `AdminSessionService.signedIn()` applies the session's own
 * expiry against the clock, and the route gate only runs at navigation — so an admin who leaves
 * `/company` open past his expiry watches this control turn from a way out into the way back in,
 * on the screen that is at that moment telling him it could not read his company.
 *
 * ## Where it hangs
 *
 * In the app header from 768 up (`app-header.ts`), and in `/company`'s own compact bar below it.
 * The header is `display: none` under 768 and an admin can reach `/company` on a phone
 * (decision 9: every screen is visible on every device), so a header-only sign-out would strand
 * him. The compact bar is where that screen already keeps its wordmark and its language switcher,
 * which is the same argument `profile-link.ts` and `company-link.ts` make for the foot of Home.
 *
 * Home's compact footer deliberately does **not** carry it: the office session is managed in the
 * office, and the way there is already one tap away in that footer.
 */
@Component({
  selector: 'app-session-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    @if (state(); as mode) {
      <button
        type="button"
        class="session"
        *transloco="let t"
        [attr.aria-label]="
          mode === 'out' ? t('common.signOutAs', { name: displayName() }) : t('common.signIn')
        "
        (click)="act(mode)"
      >
        <app-icon [name]="mode === 'out' ? 'log-out' : 'log-in'" [size]="18" />
        <span class="session__label">{{
          mode === 'out' ? t('common.signOut') : t('common.signIn')
        }}</span>
      </button>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }

    /*
     * The compact-bar form: the same 52 px white circle the language switcher, the office link
     * and the profile link already wear, so a phone's chrome reads as one row of controls rather
     * than as a row plus a button. The word is dropped here, not for tidiness but for width —
     * "TEREN", the SR/EN switcher and a labelled pill do not fit inside 390 px, and the bar
     * overflowed the screen the first time this shipped with one.
     */
    .session {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      width: 52px;
      height: 52px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-pill);
      background: var(--color-card);
      box-shadow: var(--shadow-card);
      color: var(--color-ink-2);
      font-size: var(--text-body);
      font-weight: 600;
      cursor: pointer;
    }

    .session__label {
      display: none;
    }

    /* In the app header the bar is already white, so the control drops its card treatment — the
       switcher and the two icon links beside it do the same — and shrinks to the 44 px floor. */
    :host(.on-header) .session {
      width: var(--tap-min);
      height: var(--tap-min);
      background: var(--color-canvas);
      box-shadow: none;
    }

    /*
     * From 900 the header has room for the word, and this is the one control on it that earns
     * one: an icon of a door is not self-evidently *sign out*, and it is the control the founder
     * asked to be able to see. 900 is where the header already stops hiding the date, so the bar
     * gains and loses its two wordy elements together instead of at two different widths.
     */
    @media (min-width: 900px) {
      :host(.on-header) .session {
        width: auto;
        padding: 0 var(--space-4);
      }

      :host(.on-header) .session__label {
        display: inline;
      }
    }

    @media (hover: hover) and (pointer: fine) {
      .session:hover {
        color: var(--color-ink);
      }

      :host(.on-header) .session:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class SessionLink {
  private readonly router = inject(Router);
  private readonly admins = inject(AdminSessionService);
  private readonly devices = inject(SessionService);

  /**
   * `'out'` to offer the way out, `'in'` to offer the way in, `null` to render nothing.
   *
   * A method, not a computed: {@link AdminSessionService.signedIn} reads the clock, and a computed
   * would cache an answer that was true when the credential was adopted and stay true for thirty
   * days of wall-clock time.
   */
  protected state(): 'in' | 'out' | null {
    if (this.admins.signedIn()) {
      return 'out';
    }
    return this.devices.activated() ? null : 'in';
  }

  /** Who is signed in, for the accessible name. Empty is impossible while `'out'` is the state. */
  protected displayName(): string {
    return this.admins.session()?.displayName ?? '';
  }

  /**
   * Sign out, or go and sign in.
   *
   * Both end at `/login` on purpose. Signing out removes one `localStorage` row and no evidence
   * (`AdminSessionService.signOut`), and the screen he lands on is the form itself — including on
   * a browser that also holds a device session, which is the founder's. Until 2026-09-01 that case
   * was forwarded to Home, which meant signing out of the platform was a one-way door.
   */
  protected act(state: 'in' | 'out'): void {
    if (state === 'out') {
      this.admins.signOut();
    }
    void this.router.navigate(['/login']);
  }
}
