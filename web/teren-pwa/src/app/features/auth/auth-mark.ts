import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The layered-circle brand motif from `design/Welcome.dc.html`.
 *
 * Three overlapping discs in the accent tints with the record glyph in the deepest one — the only
 * decorative object in the product, and the one thing on these screens that says what the app is
 * before a word is read. Pulled out of the Welcome template because the activation screen needs
 * it too: `design/Code.dc.html` does not exist, so that screen is composed from parts that were
 * already approved rather than from shapes invented this afternoon.
 *
 * `scale` is a multiplier over the artboard's 150×120 box, so a desktop aside can carry a smaller
 * one without a second set of magic numbers. The tints are decorative by `tokens.md`'s own rule
 * (never text), and the whole thing is `aria-hidden`: it says nothing a screen reader needs, and
 * the wordmark beside it is real text.
 */
@Component({
  selector: 'app-auth-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="mark" aria-hidden="true" [style.--mark-scale]="scale()">
      <span class="mark__disc mark__disc--back"></span>
      <span class="mark__disc mark__disc--mid"></span>
      <span class="mark__disc mark__disc--front">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          focusable="false"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
          <path d="M12 18v4" />
        </svg>
      </span>
    </span>
  `,
  styles: `
    :host {
      display: block;
    }

    .mark {
      position: relative;
      display: block;
      width: calc(150px * var(--mark-scale, 1));
      height: calc(120px * var(--mark-scale, 1));
    }

    .mark__disc {
      position: absolute;
      border-radius: 50%;
    }

    .mark__disc--back {
      left: 0;
      top: calc(10px * var(--mark-scale, 1));
      width: calc(100px * var(--mark-scale, 1));
      height: calc(100px * var(--mark-scale, 1));
      background: var(--color-accent-tint-2);
    }

    .mark__disc--mid {
      right: 0;
      top: 0;
      width: calc(76px * var(--mark-scale, 1));
      height: calc(76px * var(--mark-scale, 1));
      background: var(--color-accent-tint-3);
    }

    .mark__disc--front {
      right: calc(26px * var(--mark-scale, 1));
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: calc(56px * var(--mark-scale, 1));
      height: calc(56px * var(--mark-scale, 1));
      background: var(--color-accent);
      color: var(--color-card);
    }

    .mark__disc--front svg {
      width: calc(26px * var(--mark-scale, 1));
      height: calc(26px * var(--mark-scale, 1));
    }
  `,
})
export class AuthMark {
  /** 1 is the artboard's own size. */
  readonly scale = input(1);
}
