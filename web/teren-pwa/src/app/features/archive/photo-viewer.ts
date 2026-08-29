import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { Icon } from '../../ui/icon';

/**
 * One photograph, full size.
 *
 * A thumbnail proves a photograph exists; only the full frame proves what is in it, and "what is
 * in it" is the entire evidentiary value of a photograph of pipework about to be covered by a
 * wall. So the archive's thumbnails open into this rather than into a lightbox library — the
 * whole behaviour is an overlay, two arrows and an escape key.
 *
 * The URLs are minted and revoked by the detail screen's `ObjectUrlCache`; this component only
 * reads them, and deliberately owns no blob of its own so there is nothing here to leak.
 */
@Component({
  selector: 'app-photo-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <div
      class="viewer"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="label()"
      *transloco="let t"
      (click)="close.emit()"
    >
      <div class="viewer__bar" (click)="$event.stopPropagation()">
        <span class="viewer__count t-num">{{
          t('archive.photos.position', { index: current() + 1, total: urls().length })
        }}</span>
        <button
          type="button"
          class="viewer__button"
          [attr.aria-label]="t('common.close')"
          (click)="close.emit()"
        >
          <app-icon name="x" [size]="22" />
        </button>
      </div>

      <div
        class="viewer__stage"
        (click)="$event.stopPropagation()"
        (touchstart)="onTouchStart($event)"
        (touchend)="onTouchEnd($event)"
      >
        @if (urls().length > 1) {
          <button
            type="button"
            class="viewer__button viewer__nav"
            [attr.aria-label]="t('archive.photos.previous')"
            (click)="step(-1)"
          >
            <app-icon name="chevron-left" [size]="24" />
          </button>
        }

        <img class="viewer__image" [src]="urls()[current()]" [alt]="label()" />

        @if (urls().length > 1) {
          <button
            type="button"
            class="viewer__button viewer__nav"
            [attr.aria-label]="t('archive.photos.next')"
            (click)="step(1)"
          >
            <app-icon name="chevron-right" [size]="24" />
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    .viewer {
      position: fixed;
      inset: 0;
      z-index: var(--z-overlay);
      display: flex;
      flex-direction: column;
      /* Ink rather than pure black: the one dark surface in the product is #1A1A1A. */
      background: rgba(26, 26, 26, 0.94);
      padding: env(safe-area-inset-top) var(--space-3) env(safe-area-inset-bottom);
    }

    .viewer__bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-1);
      color: var(--color-card);
    }

    .viewer__count {
      font-size: var(--text-meta);
      font-weight: 600;
      color: var(--color-ink-on-dark-2);
    }

    .viewer__button {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--tap-min);
      height: var(--tap-min);
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.12);
      color: var(--color-card);
      cursor: pointer;
    }

    .viewer__stage {
      flex: 1 1 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      min-height: 0;
      padding-bottom: var(--space-4);
    }

    .viewer__image {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: var(--radius-field);
    }

    /*
     * On a phone the arrows must not eat the frame — but they must not disappear either. A
     * counter reading "1 / 3" with no way to reach 2 is a dead control on the foreman’s own
     * device class. So below 768 they float over the edges of the image instead of sitting
     * beside it: full-width photograph, 44 px targets, and the swipe below as the native
     * gesture for anyone who reaches for it first.
     */
    @media (max-width: 767px) {
      .viewer__stage {
        position: relative;
      }

      .viewer__nav {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        background: rgba(26, 26, 26, 0.55);
      }

      .viewer__nav:first-of-type {
        left: 0;
      }

      .viewer__nav:last-of-type {
        right: 0;
      }
    }

    @media (hover: hover) and (pointer: fine) {
      .viewer__button:hover {
        background: rgba(255, 255, 255, 0.24);
      }
    }
  `,
})
export class PhotoViewer {
  /** Object URLs, in the order the strip shows them. */
  readonly urls = input.required<string[]>();
  readonly startIndex = input(0);
  /** Accessible name for the frame; the caller supplies the localised text. */
  readonly label = input('');

  readonly close = output<void>();

  private readonly offset = signal(0);

  protected readonly current = computed(() => {
    const total = this.urls().length;
    if (total === 0) {
      return 0;
    }
    // Wraps in both directions, so the last photo's "next" is the first rather than a dead
    // button — with two or three photographs a stop at each end is just friction.
    return (((this.startIndex() + this.offset()) % total) + total) % total;
  });

  protected step(delta: number): void {
    this.offset.update((value) => value + delta);
  }

  /**
   * Horizontal swipe, the gesture a phone user reaches for before hunting a button.
   *
   * Deliberately crude: one start point, one end point, a threshold. No pointer-capture, no
   * inertia, no library — the whole behaviour is "which way did the thumb go", and the arrows
   * are still there for anyone who does not swipe. The vertical check keeps a scroll gesture
   * from paging the photograph out from under the person doing it.
   */
  private touchStart: { x: number; y: number } | null = null;

  protected onTouchStart(event: TouchEvent): void {
    const touch = event.changedTouches[0];
    this.touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  protected onTouchEnd(event: TouchEvent): void {
    const start = this.touchStart;
    const touch = event.changedTouches[0];
    this.touchStart = null;
    if (!start || !touch) {
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // 40 px, and more horizontal than vertical: a tap must never page, and neither must a scroll.
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) {
      return;
    }
    this.step(dx < 0 ? 1 : -1);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      this.step(-1);
    } else if (event.key === 'ArrowRight') {
      this.step(1);
    }
  }
}
