import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import {
  displayActivationCode,
  foldActivationCode,
  isCompleteActivationCode,
} from '../../core/auth/activation-code';
import { ActivationService, AuthFailure } from '../../core/auth/activation.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { RETURN_URL_PARAM, safeReturnUrl } from '../../core/session/return-url';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { AuthMark } from './auth-mark';

/**
 * Joining a site: a username and a one-time code, typed once, on this phone
 * (`plans/profile-and-identity.md` §10.3).
 *
 * ## What a successful activation does (F4)
 *
 * **It leaves.** The screen used to raise a "this phone is ready" panel and stay where it was.
 * What the founder actually met on a real phone was worse than a screen that did not move: the
 * client and the shipped endpoint disagreed about the response shape (`core/auth/auth-types.ts`),
 * so a *successful* activation was read as unreadable and the screen said joining had failed and
 * that his code was not used up — both false. He pressed the button again and spent a second
 * single-use code, whose 401 looked like proof the first attempt had failed too. The contract is
 * fixed there; the missing destination is fixed here, because a panel with a button on it is
 * still a place a man can be left standing. He is taken through the door: to the URL the gate
 * interrupted (`?next=`, carried here by Welcome) or to the record button.
 *
 * What that panel carried is not lost. The install invitation, which is worth the most and was
 * the strongest argument for stopping here, is on Home and shows there instead; a queue that
 * started moving again shows in the sync state, which is first-class UI on every screen; and who
 * this phone belongs to is `/profile`'s subject (F5), not a one-off notice a man sees once.
 *
 * ## The design debt this screen carries
 *
 * **There is no `design/Code.dc.html`.** `Login.dc.html` is the *email* screen and its
 * join-by-code is a link, not a field. This screen is therefore composed from parts that were
 * already approved — Welcome's layered-circle motif, Login's back-chevron bar, Login's field card
 * with its inline error treatment — and an artboard pair (390 + 1280) is still owed.
 *
 * ## Why the ergonomics below are not preferences
 *
 * He types this once, with gloves, in the sun, from a message on the same phone.
 *
 * - **One `<input>`, not eight boxes.** Segmented boxes are a paste and accessibility disaster on
 *   Android, and paste is how most of these codes will arrive.
 * - **`autocomplete="one-time-code"`**, because the code comes by SMS or Viber and the keyboard
 *   can offer it.
 * - **Folded as he types** (`core/auth/activation-code.ts`), Crockford *and* Cyrillic. A Serbian
 *   keyboard produces `С`, `Т` and `О` — pixel-identical to `C`, `T` and `O` — and dropping them
 *   silently would leave him six characters where he can see eight, with no possible hint on
 *   screen. Folding in the field means he watches his `О` become `0` and knows the app read him.
 * - **No auto-submit on the eighth character.** A mis-typed paste would burn a single-use code
 *   and send him back to his boss for another.
 * - **The field is never cleared on failure.** Retyping seven correct characters because the
 *   eighth was wrong is the kind of thing that makes a man put the phone away.
 * - **No client-side lockout.** Throttling is the server's job (§7). A lockout on the one screen
 *   between a foreman and the record button is indefensible.
 * - **"You need a connection" is said before he types**, not after eight characters.
 */
@Component({
  selector: 'app-activate-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthMark, Icon, LanguageSwitcher, TranslocoDirective],
  templateUrl: './activate-page.html',
  styleUrls: ['./auth-layout.css', './auth-form.css', './activate-page.css'],
})
export class ActivatePage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly activation = inject(ActivationService);
  protected readonly connectivity = inject(ConnectivityService);

  private readonly usernameField = viewChild<ElementRef<HTMLInputElement>>('usernameInput');
  private readonly codeField = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  protected readonly username = signal('');
  /**
   * The code exactly as the field shows it — folded and formatted, e.g. `XKD4-7HMP`.
   *
   * The `<input>` is uncontrolled: its value is written by the handlers below rather than bound,
   * because folding as he types means rewriting what he just typed, and a `[value]` binding
   * fighting a caret is how a field starts eating characters. This signal mirrors the DOM for
   * validation and for what goes on the wire; the DOM stays the authority on the caret.
   */
  protected readonly code = signal('');

  /** Set on the first submit, so a validation message never greets an empty form. */
  protected readonly touched = signal(false);
  /**
   * Set by *either* action, because both need a username — and only that.
   *
   * Kept apart from {@link touched} deliberately. Asking for a fresh code is not an attempt to
   * join: a man who taps "send me a code" has not claimed to have one, and marking the code field
   * invalid at that moment would answer a request for help with an error he did not cause.
   */
  protected readonly usernameTouched = signal(false);
  protected readonly busy = signal(false);
  protected readonly sendingCode = signal(false);
  protected readonly failure = signal<AuthFailure | null>(null);
  protected readonly codeSent = signal(false);

  protected readonly folded = computed(() => foldActivationCode(this.code()));
  protected readonly codeComplete = computed(() => isCompleteActivationCode(this.folded()));
  protected readonly usernameGiven = computed(() => this.username().trim().length > 0);

  /** The message under the field: a validation nudge first, then whatever the server said. */
  protected readonly errorKey = computed<string | null>(() => {
    if (this.usernameTouched() && !this.usernameGiven()) {
      return 'auth.code.usernameRequired';
    }
    if (this.touched() && !this.codeComplete()) {
      return 'auth.code.codeIncomplete';
    }
    const failure = this.failure();
    return failure ? `auth.code.error.${failure}` : null;
  });

  /**
   * Back to Welcome, carrying the return URL with it.
   *
   * `queryParamsHandling: 'preserve'` rather than a rebuilt parameter list: the only thing in this
   * screen's query string is `?next=`, and dropping it here would strand a deep link on the one
   * gesture a man makes when he has picked the wrong door — he taps back, taps "Prijavi se", and
   * the entry he was sent here to open is forgotten.
   */
  protected back(): void {
    void this.router.navigate(['/welcome'], { queryParamsHandling: 'preserve' });
  }

  protected onUsername(value: string): void {
    this.username.set(value);
    this.failure.set(null);
    // A code was sent for the name that *was* in the field; the sentence stops being true the
    // moment he edits it.
    this.codeSent.set(false);
  }

  /**
   * Fold and reformat what he typed — but only when the caret is at the end.
   *
   * Rewriting the value moves the caret to the end, which is exactly right while he is typing or
   * appending and exactly wrong while he is correcting the third character. So the transform is
   * applied only in the case where it costs nothing, and mid-string editing is left alone; the
   * value is folded again before it goes anywhere, so nothing depends on the field having been
   * tidied.
   */
  protected onCodeInput(element: HTMLInputElement): void {
    this.failure.set(null);

    const atEnd =
      element.selectionStart === element.value.length &&
      element.selectionEnd === element.value.length;

    if (!atEnd) {
      this.code.set(element.value);
      return;
    }

    const display = displayActivationCode(element.value);
    if (display !== element.value) {
      element.value = display;
    }
    this.code.set(display);
  }

  /**
   * A paste replaces the field, whatever was in it.
   *
   * This is how most codes arrive — long-pressed out of a chat message, often with prose around
   * them ("Kod: XKD4-7HMP"). Folding strips the separators, the zero-width characters a chat app
   * leaves behind and any emoji; the first eight surviving characters are the code. Replacing
   * rather than inserting is the behaviour of every one-time-code field, and it is the only one
   * that makes sense for a value that is exactly eight characters long.
   */
  protected onCodePaste(event: ClipboardEvent, element: HTMLInputElement): void {
    const pasted = event.clipboardData?.getData('text') ?? '';
    // Without this the platform would also insert the raw text and undo the fold.
    event.preventDefault();
    this.failure.set(null);

    const display = displayActivationCode(pasted);
    element.value = display;
    this.code.set(display);
  }

  /**
   * A real `<form>`, so the keyboard's "go" key works and a password manager sees a form.
   *
   * The native submit is stopped here rather than by using a non-form layout: without a form
   * element, Enter on an Android keyboard does nothing at all on a single-field screen, and this
   * screen has to work for a man who never lifts his thumb to look for a button.
   */
  protected onSubmit(event: Event): void {
    event.preventDefault();
    void this.submit();
  }

  /**
   * Join.
   *
   * Deliberately reachable only from the button and the field's Enter key — never from the eighth
   * character arriving.
   */
  protected async submit(): Promise<void> {
    if (this.busy() || this.sendingCode()) {
      return;
    }

    this.touched.set(true);
    this.usernameTouched.set(true);
    this.failure.set(null);

    if (!this.usernameGiven()) {
      this.usernameField()?.nativeElement.focus();
      return;
    }
    if (!this.codeComplete()) {
      this.codeField()?.nativeElement.focus();
      return;
    }

    this.busy.set(true);
    // The canonical, folded code — never the string the field is showing.
    const result = await this.activation.activate(this.username(), this.folded());
    this.busy.set(false);

    if (!result.ok) {
      // The field keeps what he typed. He fixes one character, not eight.
      this.failure.set(result.failure);
      return;
    }

    // **Go somewhere.** Until F4 this screen set a success flag and stopped. A man who has just
    // been let in belongs on the other side of the door — at whatever he was trying to reach when
    // the gate stopped him, and otherwise at the record button. See the class comment for the
    // wire-shape defect that was underneath the founder's report of this.
    //
    // `navigateByUrl`, because `next` is a whole URL and may carry the archive's `?entry=<id>`;
    // `safeReturnUrl` is applied here and not trusted from the address bar, because this screen is
    // reachable by typing its own URL.
    void this.router.navigateByUrl(this.returnUrl());
  }

  /** Where a successful activation lands. Always somewhere; the record button when in doubt. */
  private returnUrl(): string {
    return safeReturnUrl(this.route.snapshot.queryParamMap.get(RETURN_URL_PARAM)) ?? '/';
  }

  /**
   * Decision 14: a fresh code, to the address on file, without phoning anyone.
   *
   * The answer is uniform whether or not the username exists — a login surface must not be an
   * account-enumeration oracle — so the sentence on screen is conditional by construction: *if*
   * that username exists, a code is on its way.
   */
  protected async requestCode(): Promise<void> {
    if (this.busy() || this.sendingCode()) {
      return;
    }

    this.usernameTouched.set(true);
    this.failure.set(null);

    if (!this.usernameGiven()) {
      this.usernameField()?.nativeElement.focus();
      return;
    }

    this.sendingCode.set(true);
    const result = await this.activation.requestCode(this.username());
    this.sendingCode.set(false);

    if (result.ok) {
      this.codeSent.set(true);
      return;
    }
    this.failure.set(result.failure);
  }
}
