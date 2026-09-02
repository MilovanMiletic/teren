import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { Icon } from './icon';

/**
 * An explanation behind an info button: the small print a screen needs to carry but should not
 * spend a card on.
 *
 * ## Why it opens three ways
 *
 * The founder asked for "hover over the info icon", and hover is the right gesture on a mouse. It
 * is also the one gesture **this product's primary device does not have**: a company admin reaches
 * both office screens on a phone (decision 9), and an affordance that only answers a mouse is a
 * screen lying to the man standing on site. So it opens on all three:
 *
 * | input | why |
 * |---|---|
 * | hover, **fine pointers only** | what he asked for. Gated on `(hover: hover) and (pointer: fine)` because a touch browser fires a synthetic `mouseenter` after a tap, and a bubble that then sticks reads as a stuck screen |
 * | click / tap | the phone, and the mouse user who would rather click |
 * | keyboard focus, **`:focus-visible` only** | Tab reaches it and it opens. Restricted to `:focus-visible` because a mouse click focuses the button too: an unconditional `focusin` would open on `mousedown` and the `click` that followed would toggle it straight back shut |
 *
 * Hover and intent are separate states — see {@link InfoPopover.hovered} — because with one flag a
 * mouse user's click closed the bubble his own hover had just opened.
 *
 * Escape closes it, a tap anywhere outside closes it, and the button carries `aria-expanded` and
 * `aria-controls` — a disclosure, not a tooltip. `title` attributes are deliberately not used: they
 * do not exist on touch and cannot be read by a keyboard.
 *
 * ## What it may hold
 *
 * Text, and text this screen would have printed anyway. **No activation code and no share text ever
 * reach it** (decision 13) — the heading and body are plain strings passed in by the screen, so
 * there is no code path from a credential to this component. `company-page.spec.ts` scans this file
 * to keep it that way.
 */
@Component({
  selector: 'app-info-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    '(document:keydown.escape)': 'shut()',
    '(document:click)': 'onDocumentClick($event)',
    '(mouseenter)': 'onHover(true)',
    '(mouseleave)': 'onHover(false)',
    '(focusin)': 'onFocusIn($event)',
  },
  template: `
    <button
      type="button"
      class="info"
      [attr.aria-label]="label() || heading()"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="id"
      (click)="toggle()"
    >
      <app-icon name="info" [size]="20" />
    </button>

    @if (open()) {
      <!--
        The animate.leave binding keeps the bubble in the DOM for one motion-base while pop--out
        fades it, then Angular removes it. Where the browser reports no animation — and jsdom is
        one — it goes at once, so nothing about the disclosure's behaviour depends on the fade.
        (No backticks in this block: it is a template literal.)
      -->
      <div class="pop" animate.leave="pop--out" [id]="id">
        <span class="pop__title">{{ heading() }}</span>
        <p class="t-meta pop__body">{{ body() }}</p>
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: inline-flex;
      flex: none;
    }

    /* The same 44 px white circle as every other chrome control (btn-icon in styles.css). */
    .info {
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--tap-min);
      height: var(--tap-min);
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: var(--color-card);
      box-shadow: var(--shadow-card);
      color: var(--color-ink);
      cursor: pointer;
      /* The same press feedback as every other 44 px chrome circle (styles.css). */
      transition:
        background-color var(--motion-fast) var(--ease-standard),
        transform var(--motion-fast) var(--ease-standard);
    }

    .info:active {
      transform: scale(0.97);
    }

    /*
     * Anchored to the button and pulled to its right edge, so it opens **into** the page rather
     * than off it: this control sits at the top right of both office screens, and a bubble that
     * grew rightwards would be clipped at every width.
     *
     * --z-overlay because it must pass over the content band, and it is the only layer above the
     * header this component may claim (styles.css defines the three that exist).
     */
    .pop {
      position: absolute;
      top: calc(var(--tap-min) + var(--space-2));
      right: 0;
      z-index: var(--z-overlay);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      width: max-content;
      /* Narrow enough to read, and never wider than a phone's gutter-to-gutter. */
      max-width: min(19rem, calc(100vw - 2 * var(--page-gutter)));
      padding: var(--space-4) 18px;
      border-radius: var(--radius-card);
      background: var(--color-card);
      box-shadow:
        0 2px 6px rgba(26, 26, 26, 0.06),
        0 10px 28px rgba(26, 26, 26, 0.09);
      text-align: left;
      /* The app's one "something opened" gesture: 8 px up and a fade (styles.css §Arriving). */
      animation: teren-pop-in var(--motion-base) var(--ease-standard) both;
    }

    /*
     * Leaving. The pointer-events: none matters more here than the fade does: without it the
     * bubble is still a click target for one motion-base after it was dismissed, sitting over the
     * row underneath it.
     */
    .pop--out {
      animation: teren-pop-out var(--motion-base) var(--ease-exit) both;
      pointer-events: none;
    }

    .pop__title {
      font-size: var(--text-h2);
      font-weight: 700;
    }

    .pop__body {
      margin: 0;
    }

    /*
     * **Compact: the bubble spans the gutters instead of hanging off the button.**
     *
     * Anchored to the button's right edge it reached past the left edge of a 375 px screen and its
     * first two words were clipped by the body's own overflow guard — visible in the tap screenshot
     * from the session, invisible to a scrollWidth check. "position: fixed" with both inline edges
     * pinned and "top: auto" keeps the vertical placement the static flow already gives it (under
     * the button) while taking the width from the viewport.
     */
    @media (max-width: 767px) {
      .pop {
        position: fixed;
        top: auto;
        left: var(--page-gutter);
        right: var(--page-gutter);
        width: auto;
        max-width: none;
        margin-top: calc(var(--tap-min) + var(--space-2));
      }
    }

    @media (hover: hover) and (pointer: fine) {
      .info:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class InfoPopover {
  /** The explanation's heading, already translated. Doubles as the button's accessible name. */
  readonly heading = input.required<string>();
  readonly body = input.required<string>();
  /** An accessible name for the button when the heading is not the right thing to announce. */
  readonly label = input('');

  /**
   * Open because the pointer is over it, and open because somebody asked for it — **two states,
   * not one**, and the reason is a bug this component shipped with for an hour.
   *
   * With a single flag, a mouse user's click *closed* the bubble his own hover had just opened:
   * `mouseenter` set it true, and the `click` that followed toggled it straight back to false. The
   * screenshot at 1280 showed a tinted button and no bubble at all. So hover and intent are kept
   * apart, and the bubble is open when either is true: moving the mouse away closes an unpinned
   * bubble, and a click or a keyboard focus pins it open until Escape, an outside tap, or another
   * click.
   */
  private readonly hovered = signal(false);
  private readonly pinned = signal(false);

  protected readonly open = computed(() => this.hovered() || this.pinned());

  /** Unique per instance, so `aria-controls` still resolves when two of these share a screen. */
  protected readonly id = `info-${Math.random().toString(36).slice(2, 9)}`;

  private readonly host = inject(ElementRef<HTMLElement>);

  /**
   * Whether this device has a real pointer.
   *
   * Read once rather than per event, and guarded: a service worker context and jsdom have no
   * `matchMedia`, and an info bubble is not worth a boot failure. Answering "no pointer" is the
   * safe default — the click and focus paths still work.
   */
  private readonly finePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  protected toggle(): void {
    this.pinned.update((was) => !was);
  }

  protected shut(): void {
    this.pinned.set(false);
    this.hovered.set(false);
  }

  protected onHover(entering: boolean): void {
    // Fine pointers only: a touch browser fires a synthetic `mouseenter` after a tap, and a bubble
    // that then sticks until the next tap reads as a stuck screen.
    if (this.finePointer) {
      this.hovered.set(entering);
    }
  }

  protected onFocusIn(event: FocusEvent): void {
    // `:focus-visible` only — see the class comment for why an unconditional open fights the click.
    const target = event.target as Element | null;
    if (target?.matches?.(':focus-visible')) {
      this.pinned.set(true);
    }
  }

  protected onDocumentClick(event: Event): void {
    const target = event.target as Node | null;
    // The button's own click already ran `toggle()` and bubbled to here; without this the two
    // would cancel each other out and the bubble would never open on a tap.
    if (target && !(this.host.nativeElement as HTMLElement).contains(target)) {
      this.shut();
    }
  }
}
