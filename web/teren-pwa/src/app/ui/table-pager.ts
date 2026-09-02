import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { Icon } from './icon';
import { ViewportService } from './viewport.service';

/**
 * How many numbered pages the control draws before it starts sliding.
 *
 * Five, because five 44 px targets plus two arrows is 308 px of control and the narrowest place
 * this is ever drawn numbered is the 640 column at 768. It slides rather than gaining ellipses: a
 * reader of a twelve-page list wants "the pages near the one I am on", and `1 … 7 8 9 … 12` spends
 * two slots saying that two numbers were left out.
 */
const SLOTS = 5;

/**
 * The run of page numbers to draw, centred on the page being shown.
 *
 * A pure function, and it has a spec of its own for the same reason `ui/menu-placement.ts` does:
 * jsdom lays nothing out, so the only way to test the arithmetic of a control is to keep the
 * arithmetic out of the control. The three cases that actually happen — near the start, in the
 * middle, near the end — are all clamps of one window, and getting the last one wrong shows up as a
 * pager that stops offering the final page.
 */
export function pageWindow(page: number, pageCount: number, slots = SLOTS): number[] {
  const count = Math.max(0, Math.trunc(pageCount));
  if (count <= 0) {
    return [];
  }
  const width = Math.min(slots, count);
  const centred = Math.trunc(page) - Math.floor(width / 2);
  const start = Math.min(Math.max(1, centred), count - width + 1);
  return Array.from({ length: width }, (_, index) => start + index);
}

/**
 * The control at the foot of every table in the product: **ten rows a page, and a way through
 * them** (founder, 2026-09-02: *"we need to have 10 rows per table with pagination added"*).
 *
 * ## One control, four tables, two sets of clothes
 *
 * The same argument {@link ColumnMenu} was built on. `/company`, `/platform` and
 * `/platform/companies` each draw a real `<table>` from 768 up and a list of tappable rows below
 * it, and `/platform/logs` draws a keyset stream — four screens that would otherwise grow four
 * pagers, of which three would be right and the fourth would be the one nobody looked at.
 *
 * | width | shape | why |
 * |---|---|---|
 * | ≥768 | `‹ 1 2 3 4 5 ›` | there is room for the numbers, and jumping four pages in one tap is what a mouse is for |
 * | <768 | `‹ 2 / 5 ›` | five numbered targets at 44 px do not fit beside two arrows on a 390 px screen, and the two arrows are the gesture a thumb actually makes |
 *
 * ## It never invents a last page
 *
 * `pageCount` is **0 when the total is unknown**, which is the honest state of `/platform/logs`
 * while a keyset cursor is outstanding: the server has said there is more behind this, and has not
 * said how much. In that state the numbers are not drawn at all and the next arrow is enabled from
 * {@link hasNext} — "page 3" is a fact, "page 3 of 7" is not, and the whole reason that screen
 * refuses to print "showing 3 of 12" is that a founder opens it precisely because he does not trust
 * what he is being told.
 *
 * ## The page it is handed is already clamped
 *
 * It draws what it is given and emits a number in `[1, pageCount]`; the clamp lives in
 * `ui/table-controls.ts`, on every read, where the rows are. A pager that clamped for itself would
 * be a second opinion about which page is being shown, and two opinions is how a table ends up
 * drawing page 1 under the heading "page 4".
 */
@Component({
  selector: 'app-table-pager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (shown()) {
        <nav class="pager" [attr.aria-label]="t('table.pager.label')">
          <div class="pager__row">
            <button
              type="button"
              class="pager__step"
              [disabled]="atStart()"
              [attr.aria-label]="t('table.pager.previous')"
              (click)="step(-1)"
            >
              <app-icon name="chevron-left" [size]="18" />
            </button>

            <!--
              **Always present, never wrapped in a control-flow block.** ng-content inside an
              @if is a projection whose instantiation nobody should have to reason about; an empty
              slot collapses itself in CSS instead (:empty). It is what the log screen puts its
              "Učitaj još" into, so that one row reads ‹ | Učitaj još | › rather than stacking a
              pager under a button under a table (founder, 2026-09-02: "table overlaps down").
            -->
            <span class="pager__slot"><ng-content /></span>

            @if (numbered()) {
              <span class="pager__pages">
                @for (number of window(); track number) {
                  <button
                    type="button"
                    class="pager__page"
                    [class.pager__page--on]="number === page()"
                    [attr.aria-current]="number === page() ? 'page' : null"
                    [attr.aria-label]="t('table.pager.page', { page: number })"
                    (click)="goTo.emit(number)"
                  >
                    {{ number }}
                  </button>
                }
              </span>
            } @else if (!steps()) {
              <!--
                The same fact in one line of text, for a phone and for a stream whose end nobody
                knows. aria-current cannot live on a span that is not a link, so the position is
                announced by the sentence itself rather than by a role it does not have.
              -->
              <span class="t-meta t-num pager__position" role="status">{{ position(t) }}</span>
            }

            <button
              type="button"
              class="pager__step"
              [disabled]="atEnd()"
              [attr.aria-label]="t('table.pager.next')"
              (click)="step(1)"
            >
              <app-icon name="chevron-right" [size]="18" />
            </button>
          </div>

          @if (steps()) {
            <!--
              Under the row, not in it: the middle of a steps pager belongs to the projected
              control. **It stays** all the same — a reader three pages into a stream with no number
              anywhere cannot tell where he is, and this screen prints no total to infer it from.
            -->
            <span class="t-meta t-num pager__where" role="status">{{ position(t) }}</span>
          }
        </nav>
      }
    </ng-container>
  `,
  styles: `
    /*
     * space-2 between the controls, not space-1, and it is load-bearing rather than taste: each
     * target below claims 4 px of overhang on every side, so an 8 px gap makes two neighbouring
     * 44 px targets meet exactly. At 4 px they would overlap by four pixels, and a press in the gap
     * would land on whichever came later in the DOM — the same defect the column menu's own
     * margin-left comment records.
     */
    .pager {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-3) 18px;
      border-top: 1px solid var(--color-card-line);
    }

    .pager__row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      width: 100%;
    }

    /*
     * The projected control, when there is one. It takes the width the two arrows leave, so the
     * log screen's "Učitaj još" spans the card exactly as it did when it had a row to itself —
     * only now the arrows are on that row instead of on a second one below it.
     *
     * An unprojected slot collapses rather than eating a gap: :empty is true of the numbered
     * variant, where nothing is passed in.
     */
    .pager__slot {
      flex: 1 1 auto;
      min-width: 0;
    }

    .pager__slot:empty {
      display: none;
    }

    /* The position under a steps row. Muted, small, and never a fraction it cannot know. */
    .pager__where {
      color: var(--color-ink-2);
    }

    /*
     * **Drawn 36 px, hit 44** — the trick ui/column-menu.ts uses on its funnel, and for the same
     * reason: five 44 px discs in a row read as a toolbar rather than as one control, and the
     * token minimum (design/tokens.md: 44 px for an icon button) is about the thumb rather than
     * about the ink. 36 + 4 + 4 is 44 in both axes; the overhang is exactly half the gap above, so
     * two neighbouring targets meet and never overlap.
     * (No backticks in this block: it is a template literal.)
     */
    .pager__step,
    .pager__page {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 36px;
      height: 36px;
      padding: 0 var(--space-1);
      border: 0;
      border-radius: var(--radius-pill);
      background: none;
      color: var(--color-ink-2);
      font-family: var(--font-family);
      font-size: var(--text-meta);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      /*
       * The same press feedback every other control in the product gives (styles.css §Press
       * feedback), and 0.94 rather than 0.97 for the same reason the column funnel uses it: three
       * per cent of a 36 px disc is one pixel. The rows swap under the pager the moment the click
       * is handled — the scale is drawn alongside that, never before it.
       */
      transition:
        background-color var(--motion-fast) var(--ease-standard),
        color var(--motion-fast) var(--ease-standard),
        transform var(--motion-fast) var(--ease-standard);
    }

    .pager__step:not(:disabled):active,
    .pager__page:active {
      transform: scale(0.94);
    }

    .pager__step::after,
    .pager__page::after {
      content: '';
      position: absolute;
      inset: -4px;
    }

    .pager__step:disabled {
      color: var(--color-ink-3);
      opacity: 0.45;
      cursor: default;
    }

    .pager__pages {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    /*
     * The page he is on is filled, not merely bolder. A pager is read at a glance from the corner
     * of the eye, and a weight difference is not a glance.
     */
    .pager__page--on {
      background: var(--color-ink);
      color: var(--color-card);
    }

    .pager__position {
      min-width: 72px;
      padding: 0 var(--space-2);
      color: var(--color-ink-2);
      text-align: center;
    }

    @media (hover: hover) and (pointer: fine) {
      .pager__step:not(:disabled):hover,
      .pager__page:not(.pager__page--on):hover {
        background: var(--color-accent-tint-1);
        color: var(--color-accent-deep);
      }
    }
  `,
})
export class TablePager {
  /** The page being shown, one-based and **already clamped** by whoever owns the rows. */
  readonly page = input.required<number>();

  /** How many pages there are, or **0 when the total is not knowable** — see the class comment. */
  readonly pageCount = input(0);

  /**
   * Whether there is a page after this one, where {@link pageCount} cannot say.
   *
   * Null means "ask the page count", which is the ordinary case. `/platform/logs` passes a real
   * boolean, because on that screen the answer comes from the server's cursor rather than from
   * arithmetic.
   */
  readonly hasNext = input<boolean | null>(null);

  /**
   * Which shape the control takes.
   *
   * `numbered` — the default, and what the three client-side tables use: `‹ 1 2 3 4 5 ›`, or the
   * position in words below 768.
   *
   * `steps` — two arrows flanking whatever is projected into the middle, with the position on a
   * muted line beneath. `/platform/logs` is the one screen that has something to put there: its
   * "Učitaj još" fetches the next fifty from the server while the arrows walk ten at a time
   * through what is loaded, and stacking those as two rows under the table is what the founder saw
   * as "table overlaps down" (2026-09-02). One row, one owner of the arrows: the disabled logic,
   * the accessible names and the 44 px targets are the same code in both shapes.
   */
  readonly variant = input<'numbered' | 'steps'>('numbered');

  /** A page was chosen. Always within `[1, pageCount]`, or `page ± 1` where the count is unknown. */
  readonly goTo = output<number>();

  private readonly viewport = inject(ViewportService);

  /** Whether the total is knowable at all. */
  protected readonly known = computed(() => this.pageCount() > 0);

  protected readonly atStart = computed(() => this.page() <= 1);

  protected readonly atEnd = computed(() =>
    this.known() ? this.page() >= this.pageCount() : this.hasNext() !== true,
  );

  /**
   * Whether the control is drawn at all.
   *
   * **One page of a known total draws nothing** — a pager over three rows is furniture. But a page
   * number above one, or a server holding more behind what is loaded, both mean there is somewhere
   * to go, and a control that vanished in either state would strand the reader where it left him.
   */
  protected readonly shown = computed(() =>
    this.known() ? this.pageCount() > 1 : this.page() > 1 || this.hasNext() === true,
  );

  protected readonly steps = computed(() => this.variant() === 'steps');

  /**
   * Numbers only where they fit, only where they can be counted, and never in a `steps` row —
   * there the middle belongs to the projected control and the position moves beneath it.
   */
  protected readonly numbered = computed(
    () => !this.steps() && this.viewport.atLeastMedium() && this.known(),
  );

  protected readonly window = computed(() => pageWindow(this.page(), this.pageCount()));

  /**
   * The position as a sentence.
   *
   * Two sentences, and which one is used is the whole honesty of this control: with a total it
   * reads "2 / 5"; without one it reads "Strana 2" and stops there rather than guessing at the
   * denominator.
   */
  protected position(t: (key: string, params?: Record<string, unknown>) => string): string {
    return this.known()
      ? t('table.pager.position', { page: this.page(), pageCount: this.pageCount() })
      : t('table.pager.page', { page: this.page() });
  }

  protected step(by: number): void {
    const next = this.page() + by;
    if (next < 1 || (this.known() && next > this.pageCount())) {
      return;
    }
    this.goTo.emit(next);
  }
}
