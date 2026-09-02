import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { Icon } from './icon';

/**
 * A modal that holds one thing: a form, or a block of facts.
 *
 * The office screens used to carry both in a right-hand rail. At 1920 that rail held everything
 * useful while the table beside it held air, and at 768 the "new foreman" form dominated a screen
 * that was supposed to be about the company's people — so the founder moved both behind icon
 * buttons in the head row (2026-09-01). This is where they landed.
 *
 * ## Shared, deliberately
 *
 * Both screens need it, and a focus trap written twice is a focus trap that rots in one of the two
 * copies. Everything about *being a dialog* lives here; the screens project their content and keep
 * their own state.
 *
 * ## What being a dialog actually costs
 *
 * All of this, and every line of it is load-bearing for somebody:
 *
 * - `role="dialog"` + `aria-modal="true"`, labelled by its own heading.
 * - **Focus moves in on open and returns to the button that opened it on close.** The return is the
 *   half that is usually missed: without it a keyboard user closing this lands at the top of the
 *   document and has to walk the whole page back.
 * - **Focus is trapped** while it is open, so Tab cannot wander into the table behind it.
 * - Escape closes; a click on the backdrop closes; the page behind does not scroll.
 *
 * ## Why it is a full-height sheet on a phone
 *
 * A small centred box is right at ≥768 and wrong at 375: the panel would be a postage stamp, its
 * text fields would sit under the on-screen keyboard, and the two buttons at its foot would be the
 * first thing the keyboard covers. Below 768 it therefore owns the screen, top to bottom, and the
 * form starts at the top where the keyboard cannot reach it.
 *
 * ## Decision 13
 *
 * It renders projected content and holds no state of its own, so it cannot fetch or carry a
 * credential. The screens are responsible for what they put inside — and their specs scan for it.
 *
 * ## The one thing every call site has to write
 *
 * `animate.leave="modal--leaving"`, on the `<app-modal-sheet>` element. It cannot be moved in here:
 * this component is rendered by an `@if` in the screen that owns it, so the node Angular removes is
 * the host element, in the *parent's* template — and Angular 22.1 compiles an `animate.leave`
 * **host binding** to nothing (measured against the shipped bundle: no `animateLeave` instruction,
 * the class never applied, the dialog gone on the same frame). Without the attribute the dialog
 * still closes correctly and simply does not fade, so nothing is broken by forgetting it and
 * nothing would go red either — which is why `motion.spec.ts` scans every call site for it.
 */
@Component({
  selector: 'app-modal-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <div class="modal" (click)="close.emit()" *transloco="let t">
      <div
        #panel
        class="modal__panel"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="heading()"
        tabindex="-1"
        (click)="$event.stopPropagation()"
      >
        <div class="modal__head">
          <h2 class="t-h1 modal__title">{{ heading() }}</h2>
          <button
            type="button"
            class="btn-icon modal__close"
            [attr.aria-label]="t('common.close')"
            (click)="close.emit()"
          >
            <app-icon name="x" [size]="20" />
          </button>
        </div>

        <ng-content />
      </div>
    </div>
  `,
  styles: `
    .modal {
      position: fixed;
      inset: 0;
      z-index: var(--z-overlay);
      display: flex;
      background: rgba(26, 26, 26, 0.35);
      /*
       * The scrim arrives on its own, a shade faster than the panel, so the screen behind darkens
       * before the sheet lands on it rather than with it (design/tokens.md §Motion).
       */
      animation: teren-fade-in var(--motion-fast) var(--ease-standard) backwards;
    }

    /*
     * Leaving: the whole overlay, scrim and panel together, accelerating away.
     *
     * **The class is set by the five screens that open this, not by this component**, and that is
     * not a stylistic choice — see the class comment. What Angular removes is the app-modal-sheet
     * element in the *parent's* control flow, and Angular 22.1 compiles an animate.leave HOST
     * binding to nothing at all: the property was there, the stylesheet was there, and the dialog
     * still vanished on the same frame. Found by driving a browser; no unit test in this suite can
     * see it, because jsdom animates nothing and removes the node immediately either way. So the
     * binding lives on the element in each screen, where it is supported, and a spec scans for it.
     *
     * The animation must also be on the host itself rather than on the overlay inside it, for the
     * same underlying reason: Angular decides whether to wait by reading the animations on the
     * element it just classed. Opacity on the host reaches the fixed overlay in its subtree without
     * becoming that overlay's containing block, which a transform here would.
     * (No backticks in this block: it is a template literal.)
     */
    :host(.modal--leaving) {
      animation: teren-pop-out var(--motion-base) var(--ease-exit) forwards;
      pointer-events: none;
    }

    /*
     * Compact: the sheet owns the screen. A centred box at 375 puts a text field under the
     * keyboard and its actions under that again.
     */
    .modal__panel {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      width: 100%;
      min-height: 100dvh;
      padding: calc(var(--space-5) + env(safe-area-inset-top)) var(--page-gutter)
        calc(var(--space-8) + env(safe-area-inset-bottom));
      background: var(--color-card);
      overflow-y: auto;
      /*
       * **Compact: it comes up from the bottom edge**, because that is the edge it is anchored to
       * — the sheet owns the whole screen, so a panel that faded in place would have no direction
       * at all and a panel that dropped from the top would fight the thumb that opened it.
       */
      animation: teren-sheet-up var(--motion-base) var(--ease-standard) backwards;
    }

    .modal__panel:focus-visible {
      /* The panel takes focus on open; a ring around the whole sheet is noise, not information. */
      outline: none;
    }

    .modal__head {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .modal__title {
      flex-grow: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .modal__close {
      background: var(--color-canvas);
      box-shadow: none;
    }

    /* Medium and up: the small centred dialog, on the shape Home's project sheet already uses. */
    @media (min-width: 768px) {
      .modal {
        align-items: center;
        justify-content: center;
        padding: var(--page-gutter);
      }

      .modal__panel {
        width: 100%;
        max-width: 520px;
        min-height: 0;
        max-height: 85dvh;
        padding: var(--space-5);
        border-radius: var(--radius-card-hero);
        box-shadow: var(--shadow-card);
        /*
         * A centred box is not anchored to an edge, so it takes the app's ordinary "something
         * opened" gesture — 8 px up and a fade — instead of the sheet's slide.
         */
        animation: teren-pop-in var(--motion-base) var(--ease-standard) backwards;
      }
    }
  `,
})
export class ModalSheet {
  /** The dialog's own heading, already translated. It is also its accessible name. */
  readonly heading = input.required<string>();

  readonly close = output<void>();

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  /**
   * Where focus was when this opened.
   *
   * Captured in the constructor, which runs while the button that opened the dialog is still the
   * active element — the parent renders this inside an `@if` on the click it just handled.
   */
  private readonly opener = typeof document === 'undefined' ? null : document.activeElement;

  constructor() {
    const body = typeof document === 'undefined' ? null : document.body;
    const previousOverflow = body?.style.overflow ?? '';
    if (body) {
      // The page behind a modal must not scroll under it. Restored to whatever was there before,
      // never to a hardcoded value: `styles.css` sets `overflow-x: hidden` on the body and this
      // must not quietly become the thing that owns it.
      body.style.overflow = 'hidden';
    }

    afterNextRender(() => this.focusIn());

    inject(DestroyRef).onDestroy(() => {
      if (body) {
        body.style.overflow = previousOverflow;
      }
      const opener = this.opener;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    });
  }

  /**
   * The first thing worth typing in — else the first control, else the panel itself.
   *
   * A field before the close button, deliberately: the add-foreman dialog exists to be typed into,
   * and landing a keyboard user on "close" makes him Tab past the exit to reach the work. The panel
   * is the fallback for a dialog that is only facts to read (`PODACI`), which is also why it
   * carries `tabindex="-1"`.
   */
  private focusIn(): void {
    const controls = this.focusable();
    const field = controls.find((element) =>
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName),
    );
    (field ?? controls[0] ?? this.panel().nativeElement).focus();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.close.emit();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }

    // The trap. Without it Tab walks out of the dialog and into the table behind it, where a
    // keyboard user is then operating a screen he cannot see is covered.
    const focusable = this.focusable();
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (active === first || active === this.panel().nativeElement)) {
      event.preventDefault();
      last.focus();
    }
  }

  /**
   * Everything inside the panel a Tab can reach.
   *
   * No visibility filter on purpose: `offsetParent` is always null under jsdom, so a filter written
   * for hidden elements would make the whole trap untestable — and nothing inside either of these
   * dialogs is hidden. `:not([disabled])` is what matters here, because the submit button is
   * disabled until a name is typed and the trap must not park focus on it.
   */
  private focusable(): HTMLElement[] {
    return [
      ...this.panel().nativeElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ];
  }
}
