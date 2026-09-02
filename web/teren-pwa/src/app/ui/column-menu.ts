import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { Icon } from './icon';
import { Placement, placeMenu } from './menu-placement';
import { SortDirection } from './table-controls';

/**
 * What kind of thing a column holds, which is the only thing the two sort entries need to know.
 *
 * The words differ because the *meaning* differs: "ascending" over a column of dates tells an owner
 * nothing, and "oldest first" over a column of names is nonsense. Passing the kind rather than the
 * two labels keeps every call site to one attribute and keeps the wording in one dictionary entry
 * instead of one per table.
 */
export type ColumnKind = 'text' | 'date' | 'state' | 'number';

/**
 * The control every column header in the product carries: **sort it, or filter it, from one place.**
 *
 * ## Why it exists
 *
 * Three tables had three answers. `/company` and `/platform` had sortable headers built by hand,
 * each with its own copy of the same four helpers; `/platform/companies` had none, so its header
 * row fell back to the browser's own black bold `<th>` and read as a different product from the
 * screen one tap away (founder, 2026-09-02: *"column headers in the second screenshot are black
 * and in all others it's not like that"*). And none of the three could be **filtered** — which is
 * fine for one customer and two foremen, and is not fine for the twenty a super admin expects to
 * have or the crews a growing contractor will add.
 *
 * So: one component, in every header of every table, at every width.
 *
 * ## The shape, and why it is two controls rather than one
 *
 *   [ LABEL ⌄ ][ ⛭ ]
 *
 * The label is a button and it sorts — one tap, the way it always did; a menu that had to be opened
 * before a list could be re-ordered would make the common gesture twice the work. The funnel beside
 * it opens the menu, which holds **both directions named in words** and the column's filter box. The
 * funnel is drawn filled-in and accented while that column is filtered, because a list that is
 * quietly showing three of twelve rows is the single most dangerous state a filterable table has: an
 * owner who cannot see *why* a foreman is missing concludes the foreman is gone.
 *
 * ## Two variants, one behaviour
 *
 * | variant | where | why |
 * |---|---|---|
 * | `header` | inside a `<th>` from 768 up | fills the header cell, so the tap target is the whole column heading rather than a 12 px word |
 * | `pill` | in the control bar of the compact row lists | below 768 there is no table to hang a header off, and a phone still has to be able to find one man in a list of twelve |
 *
 * The pill variant keeps the `sort-pill` class names the phone lists already used, so the two
 * renderings stay one control with two looks rather than two controls.
 *
 * ## What it may not hold
 *
 * Text this screen would have printed anyway. **No activation code and no share text ever reach
 * it** (`plans/profile-and-identity.md` decision 13): the label, the filter and the menu are plain
 * strings passed in by the screen, and `company-page.spec.ts` scans this file to keep it that way.
 */
@Component({
  selector: 'app-column-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, TranslocoDirective],
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'shut(true)',
    // A menu placed from a rectangle is wrong the moment that rectangle moves, so it **follows**.
    // It used to close on a scroll instead, and that made the filter unusable exactly where it was
    // needed most: on a phone the box can open below the fold, and the scroll that would have
    // reached it took the menu away (review, 2026-09-02).
    '(window:scroll)': 'measure()',
    '(window:resize)': 'measure()',
    '[class.column--pill]': "variant() === 'pill'",
    '[class.column--sorted]': 'sort() !== null',
  },
  template: `
    <ng-container *transloco="let t">
      @if (sortable()) {
        <button
          type="button"
          class="sort"
          [class.sort-pill]="variant() === 'pill'"
          [class.sort-pill--on]="variant() === 'pill' && sort() !== null"
          [attr.aria-pressed]="variant() === 'pill' ? sort() !== null : null"
          (click)="toggled.emit()"
        >
          <span class="sort__label">{{ label() }}</span>
          @if (sort(); as direction) {
            <app-icon
              name="chevron-down"
              [size]="14"
              class="sort__arrow"
              [class.sort__arrow--asc]="direction === 'asc'"
            />
          }
        </button>
      } @else {
        <!--
          A heading rather than a button, because on this column nothing happens when it is
          pressed. The arrow still shows when a direction is passed in: the log stream is always
          newest first and saying so is worth a glyph, where a control that visibly did nothing
          would be the dead-button defect the header link already cost this repo a day over.
        -->
        <span class="sort sort--static">
          <span class="sort__label">{{ label() }}</span>
          @if (sort(); as direction) {
            <app-icon
              name="chevron-down"
              [size]="14"
              class="sort__arrow"
              [class.sort__arrow--asc]="direction === 'asc'"
            />
          }
        </span>
      }

      @if (filterable()) {
        <button
          #trigger
          type="button"
          class="more"
          [class.more--on]="filtered()"
          [attr.aria-label]="t('table.menu', { column: label() })"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="id"
          (click)="toggle()"
        >
          <app-icon name="filter" [size]="14" />
        </button>
      }

      @if (open()) {
        <!--
          A group, not a dialog: this is a disclosure hanging off a column head — nothing behind it
          is inert and focus is not trapped. It also leaves the app's one dialog role meaning one
          thing (ui/modal-sheet.ts), which every spec that reaches for "the dialog on screen"
          depends on. No backticks in this block: it is a template literal.
        -->
        <div
          #panel
          class="menu"
          animate.leave="menu--out"
          role="group"
          [id]="id"
          [attr.aria-label]="t('table.menu', { column: label() })"
          [style.top.px]="place().top"
          [style.left.px]="place().left"
          [style.width.px]="place().width"
        >
          <span class="t-label menu__title">{{ label() }}</span>

          @if (sortable()) {
            <button
              type="button"
              class="menu__item"
              [class.menu__item--on]="sort() === 'asc'"
              (click)="choose('asc')"
            >
              <span>{{ t('table.sort.' + kind() + '.asc') }}</span>
              @if (sort() === 'asc') {
                <app-icon name="check" [size]="16" class="menu__tick" />
              }
            </button>

            <button
              type="button"
              class="menu__item"
              [class.menu__item--on]="sort() === 'desc'"
              (click)="choose('desc')"
            >
              <span>{{ t('table.sort.' + kind() + '.desc') }}</span>
              @if (sort() === 'desc') {
                <app-icon name="check" [size]="16" class="menu__tick" />
              }
            </button>
          }

          <label class="menu__filter">
            <span class="t-label">{{ t('table.filter.label') }}</span>
            <!--
              A plain text box, deliberately not a search input: that type draws the
              browser's own clear glyph inside the field — square, blue, in the system font — beside
              a "clear this filter" control the product already draws in its own vocabulary.
            -->
            <input
              #box
              class="menu__input"
              type="text"
              autocomplete="off"
              [attr.aria-label]="t('table.filter.on', { column: label() })"
              [placeholder]="t('table.filter.placeholder')"
              [value]="filter()"
              (input)="onFilter($any($event.target).value)"
              (keydown.enter)="shut(true)"
            />
          </label>

          @if (filtered()) {
            <button type="button" class="menu__clear" (click)="clear()">
              {{ t('table.filter.clear') }}
            </button>
          }
        </div>
      }
    </ng-container>
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      align-items: center;
      /*
       * The header cell's own padding, handed down by the table rather than hard-coded here: a
       * custom property crosses the component boundary where a class name cannot, so the button
       * still fills the cell edge to edge and the expanded layout can widen it in one place.
       */
      padding: 0 var(--col-pad, 0);
    }

    /* ---- The label, which sorts ----------------------------------------------------------- */

    /*
     * **The funnel sits beside the word, not at the far end of the column** (founder, 2026-09-02:
     * "one standard option right beside all columns"). With the label growing to fill the header
     * cell, a 500 px name column put its control half a screen away from the heading it belongs
     * to, and the two read as unrelated. So the label is sized to its text and shrinks — with an
     * ellipsis rather than a second line — when the column is narrower than the word.
     */
    .sort {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      flex: 0 1 auto;
      min-width: 0;
      min-height: var(--tap-min);
      padding: 0;
      border: 0;
      background: none;
      color: var(--color-ink-2);
      font-family: var(--font-family);
      font-size: var(--text-label);
      font-weight: 600;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      text-align: left;
      cursor: pointer;
    }

    /*
     * One line, always. A column heading that wraps to two lines pushes the header row taller than
     * every other table in the app and reads as a mistake — which is precisely what "POSLEDNJI
     * KONTAKT" did at 1280 before this rule and a shorter word replaced it (founder, 2026-09-02).
     */
    .sort__label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Not a button, so no pointer and no hover: it is a heading that happens to carry an arrow. */
    .sort--static {
      cursor: default;
    }

    .sort__arrow {
      flex: none;
      color: var(--color-accent-deep);
      transition: transform var(--motion-fast) var(--ease-standard);
    }

    /*
     * Press feedback, on the two controls and **never on the host** (design/tokens.md §Motion).
     *
     * That exception is the whole reason this is written out per element instead of on the pill:
     * the menu is position: fixed, and a transform on any ancestor of a fixed element makes that
     * ancestor its containing block — so a scale on the host would drag the menu out of the
     * viewport coordinates {@link placeMenu} computed for it, once per frame, while it is open.
     * The two controls are siblings of the menu, so they are safe to move. (No backticks in this
     * block: it is a template literal.)
     */
    .sort:not(.sort--static),
    .more {
      transition:
        color var(--motion-fast) var(--ease-standard),
        background-color var(--motion-fast) var(--ease-standard),
        transform var(--motion-fast) var(--ease-standard);
    }

    /* 0.94 and not the 0.97 a pill uses: three per cent of a 28 px disc is under a pixel. */
    .sort:not(.sort--static):active,
    .more:active {
      transform: scale(0.94);
    }

    /* One glyph, both directions: the descending chevron turned over. */
    .sort__arrow--asc {
      transform: rotate(180deg);
    }

    /* ---- The funnel, which opens the menu -------------------------------------------------- */

    .more {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 28px;
      height: 28px;
      /*
       * space-2, not space-1, and the reason is the hit area below: its 8 px of overhang claims
       * exactly this clearance back, so the 44 px target begins where the label's own button ends.
       * At space-1 the two overlapped by four pixels, and a click on the last four pixels of a long
       * column name opened the menu instead of sorting. (No backticks here: template literal.)
       */
      margin-left: var(--space-2);
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      /* ink-2, the colour the label beside it uses: ink-3 on canvas is under 3:1 for a control. */
      color: var(--color-ink-2);
      cursor: pointer;
    }

    /*
     * **A 44 px tap target around a 28 px disc** (design/tokens.md: 44 px minimum for an icon
     * button). Drawn small and hit large, because this is the only way to a filter on a phone and
     * because a 44 px circle beside every column heading would be a row of buttons rather than a
     * table head.
     */
    .more::after {
      content: '';
      position: absolute;
      inset: -8px;
    }

    /*
     * A live filter is loud on purpose. A table quietly showing three of twelve rows is the one
     * state where a screen can make an owner believe a man has been removed from his company.
     */
    .more--on {
      background: var(--color-accent-tint-1);
      color: var(--color-accent-deep);
    }

    .more[aria-expanded='true'] {
      color: var(--color-ink);
    }

    /* ---- The menu -------------------------------------------------------------------------- */

    /*
     * **Fixed, and placed from the trigger's own rectangle** — see {@link ColumnMenu.place}.
     *
     * It was absolutely positioned, and that was wrong twice over: the table sits inside a
     * horizontal scroller (which makes the block axis a scroll container too) and the phone's pill
     * bar is another one. A two-row table therefore clipped the menu at the card's edge — and a
     * two-row table is exactly what the founder's screenshots show. Fixed positioning leaves every
     * one of those clipping boxes behind. (No backticks in this block: it is a template literal.)
     *
     * --z-overlay is the layer styles.css reserves for exactly this; below it the menu is painted
     * under the sticky application header.
     */
    .menu {
      position: fixed;
      z-index: var(--z-overlay);
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-3);
      /*
       * Capped and scrollable, because {@link placeMenu} may have had to pin it inside a short
       * window: a menu that cannot be reached is worse than one that scrolls.
       */
      max-height: calc(100vh - 2 * var(--space-4));
      overflow-y: auto;
      border-radius: var(--radius-card);
      background: var(--color-card);
      box-shadow: var(--shadow-card);
      text-align: left;
      cursor: default;
      /*
       * **The animation is on the menu itself**, which is the only element it may be on: it is the
       * fixed box, so a transform here is harmless, and a transform on any wrapper of it would
       * become its containing block and break the placement loop above.
       *
       * The transform in the keyframes and the top/left this element carries inline are two
       * different things and do not fight: the inline pair is the fixed position, the keyframe
       * moves it 8 px relative to that and ends at zero.
       */
      animation: teren-pop-in var(--motion-base) var(--ease-standard) backwards;
    }

    /*
     * Leaving. The pointer-events: none is the part that matters: a fading 240 px panel that still
     * takes clicks sits over the very rows the reader is going back to.
     */
    .menu--out {
      animation: teren-pop-out var(--motion-base) var(--ease-exit) forwards;
      pointer-events: none;
    }

    .menu__title {
      padding: 0 var(--space-2) var(--space-1);
      color: var(--color-ink-2);
    }

    .menu__item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      width: 100%;
      min-height: var(--tap-row);
      padding: 0 var(--space-2);
      border: 0;
      border-radius: calc(var(--radius-field) - 6px);
      background: none;
      color: var(--color-ink);
      font-family: var(--font-family);
      font-size: var(--text-body);
      text-align: left;
      cursor: pointer;
    }

    .menu__item--on {
      font-weight: 600;
    }

    .menu__tick {
      flex: none;
      color: var(--color-accent-deep);
    }

    .menu__filter {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      margin-top: var(--space-2);
      padding: var(--space-2) var(--space-2) 0;
      border-top: 1px solid var(--color-card-line);
      color: var(--color-ink-3);
    }

    /*
     * The product's field, restated rather than imported: ui/field.css is a page-level stylesheet
     * and a component's own styles cannot reach it. 16 px because anything smaller makes iOS zoom
     * the page the moment the box takes focus.
     */
    .menu__input {
      width: 100%;
      min-height: var(--tap-min);
      padding: 0 var(--space-3);
      border: 1px solid var(--color-field-line);
      border-radius: var(--radius-field);
      background: var(--color-card);
      color: var(--color-ink);
      font-family: var(--font-family);
      font-size: 16px;
    }

    .menu__clear {
      min-height: var(--tap-min);
      margin-top: var(--space-1);
      padding: 0 var(--space-2);
      border: 0;
      border-radius: calc(var(--radius-field) - 6px);
      background: none;
      color: var(--color-accent-deep);
      font-family: var(--font-family);
      font-size: var(--text-meta);
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }

    /* ---- The pill, for the phone ----------------------------------------------------------- */

    /*
     * Below 768 there is no table, so the same control travels as a pill in the list's own control
     * bar. The host carries the pill's shape and the two buttons sit inside it, which keeps one
     * tap on the word (sort) and one on the funnel (filter) exactly as the header has.
     */
    :host(.column--pill) {
      /* space-2 / space-1, not space-4 / space-2: three pills must share one row on a 360 phone
         (founder, 2026-09-02: "in one row please"). The office bar is the budget — Osoba sorted,
         Stanje, Aktivnost — and this is 12 px per pill of the 20 it was short. The funnel keeps its
         44 px hit area; it overhangs the pill by 4 px on the right. */
      padding: 0 var(--space-1) 0 var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--color-card);
      box-shadow: var(--shadow-card);
    }

    :host(.column--pill) .sort {
      /* text-label, the chips' size, not text-meta: the last of the 20 px the office bar was short
         of one row at 360. Not uppercase — these are words the finger sorts by, not captions. */
      font-size: var(--text-label);
      letter-spacing: 0;
      text-transform: none;
    }

    /*
     * The live column is reversed, which is how the phone lists have said "sorted by this" since
     * the office rework. The whole pill turns over rather than the word inside it, so the two
     * controls it holds stay one object.
     */
    :host(.column--pill.column--sorted) {
      background: var(--color-ink);
    }

    :host(.column--pill.column--sorted) .sort,
    :host(.column--pill.column--sorted) .more,
    :host(.column--pill.column--sorted) .sort__arrow {
      color: var(--color-card);
    }

    /*
     * **The filtered funnel inside a sorted pill, which is the ordinary case and was invisible.**
     * The pill reverses to ink, the funnel had gone white, and the tint underneath it stayed pale —
     * white on a pale tint, about 1.2:1, on the one control whose whole job is to be loud (review,
     * 2026-09-02). It reverses the other way instead.
     */
    :host(.column--pill.column--sorted) .more--on {
      background: var(--color-card);
      color: var(--color-accent-deep);
    }

    @media (hover: hover) and (pointer: fine) {
      /* Never the static heading: a colour that changes under the pointer promises a press. */
      .sort:not(.sort--static):hover,
      .more:hover {
        color: var(--color-ink);
      }

      .more--on:hover {
        color: var(--color-accent-deep-hover);
      }

      .menu__item:hover {
        background: var(--color-accent-tint-1);
      }
    }
  `,
})
export class ColumnMenu {
  /** The column's heading, already translated. Also names the menu and the filter box. */
  readonly label = input.required<string>();

  /** Which way this column is sorted, or null when the list is ordered by another one. */
  readonly sort = input<SortDirection | null>(null);

  /** What the two sort entries should say — see {@link ColumnKind}. */
  readonly kind = input<ColumnKind>('text');

  /** What is currently typed into this column's filter box. */
  readonly filter = input('');

  readonly variant = input<'header' | 'pill'>('header');

  /**
   * Whether this column can be re-ordered at all.
   *
   * True everywhere but the log stream (D5), which is keyset-paged over `(at DESC, id DESC)` on
   * the server: there is one order and the client cannot ask for another. A label that sorted
   * nothing would be the dead control this component's own header link once was — so with this
   * false the label is a heading, the menu holds only the filter, and a direction passed in still
   * draws its arrow to say what the fixed order is.
   */
  readonly sortable = input(true);

  /**
   * Whether this column can be filtered.
   *
   * False on a column the server offers no parameter for. With both this and {@link sortable}
   * false the control is a plain heading — which is the honest rendering of a column that answers
   * no questions, and better than a funnel that opens an empty menu.
   */
  readonly filterable = input(true);

  /** The label was pressed: pick this column up, or turn it round. */
  readonly toggled = output<void>();

  /** A direction was chosen by name in the menu. */
  readonly sorted = output<SortDirection>();

  /** The filter box changed. Emitted per keystroke — the list it narrows is already in hand. */
  readonly filterChanged = output<string>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');
  private readonly menu = viewChild<ElementRef<HTMLElement>>('panel');

  protected readonly open = signal(false);

  /**
   * Where the menu is painted, in viewport coordinates. The arithmetic — and the awkward cases it
   * exists for — live in {@link placeMenu}, which is a pure function with a spec of its own.
   */
  protected readonly place = signal<Placement>({ top: 0, left: 0, width: 240 });

  /** The animation frame the follow loop is waiting on, or null while the menu is shut. */
  private frame: number | null = null;

  /** Unique per instance, so `aria-controls` still resolves with six of these on one screen. */
  protected readonly id = `col-${Math.random().toString(36).slice(2, 9)}`;

  protected readonly filtered = computed(() => this.filter().trim() !== '');

  constructor() {
    // Opening a menu whose reason for existing is a text box, and then making him tap the box, is
    // one gesture too many on the device this product is built around.
    effect(() => {
      if (this.open()) {
        this.box()?.nativeElement.focus();
        // `untracked`, because `measure()` both reads and writes `place`: tracked, the effect would
        // take its own write as a reason to run again. It settles either way — the write is guarded
        // on a real change — but a self-triggering effect is not a thing to leave in the file.
        untracked(() => this.measure());
      }
    });

    // A component destroyed with its menu open would otherwise leave the loop running for ever.
    inject(DestroyRef).onDestroy(() => this.stopFollowing());
  }

  protected toggle(): void {
    this.open.update((was) => !was);
    // Placed before the first paint by the effect in the constructor, which also starts the loop
    // that keeps it placed; here we only have to stop that loop on the way out.
    if (!this.open()) {
      this.stopFollowing();
    }
  }

  /**
   * Re-read the trigger's rectangle and put the menu where it belongs.
   *
   * **And then keep doing it, once per frame, while the menu is open.** Measuring once at open was
   * wrong within one keystroke: typing a character makes the "showing 3 of 12" strip appear above
   * the table, which moves every column head down 61 px while the menu stayed where it was — over
   * the very row the founder was searching for (review, 2026-09-02). Anything that moves the
   * trigger does this: the strip appearing, the owner's row leaving the list, a scroll, a soft
   * keyboard, a rotation. A frame loop answers all of them for one `getBoundingClientRect` a frame,
   * and the signal is only written when the numbers actually change, so change detection does not
   * run sixty times a second.
   */
  protected measure(): void {
    const trigger = this.trigger()?.nativeElement;
    // Bound to window scroll and resize, so it runs for every column control on the screen: with
    // the menu shut there is nothing to place, and six of these measuring on every scroll frame
    // would be six rectangles nobody asked for.
    if (!this.open() || !trigger || typeof window === 'undefined') {
      return;
    }

    const next = placeMenu(
      trigger.getBoundingClientRect(),
      this.menu()?.nativeElement.offsetHeight || 260,
      { width: window.innerWidth, height: window.innerHeight },
    );

    const now = this.place();
    if (now.top !== next.top || now.left !== next.left || now.width !== next.width) {
      this.place.set(next);
    }

    this.follow();
  }

  /** Ask for the next frame, unless one is already booked or the menu has shut. */
  private follow(): void {
    if (!this.open() || this.frame !== null || typeof requestAnimationFrame !== 'function') {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.open()) {
        this.measure();
      }
    });
  }

  private stopFollowing(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  /**
   * Close it.
   *
   * @param restoreFocus put focus back on the funnel — true when the *keyboard* closed the menu
   *   (Escape, or Enter in the filter box), because focus inside a element about to be removed
   *   from the DOM otherwise lands on `<body>` and a keyboard user loses his place in the table.
   */
  protected shut(restoreFocus = false): void {
    if (!this.open()) {
      return;
    }
    this.open.set(false);
    this.stopFollowing();
    if (restoreFocus) {
      this.trigger()?.nativeElement.focus();
    }
  }

  protected choose(direction: SortDirection): void {
    this.sorted.emit(direction);
    // With the focus restored: Enter on a sort entry removes the focused node, and without this a
    // keyboard user is left on `<body>` having lost his place in the table.
    this.shut(true);
  }

  /**
   * The filter, per keystroke, and **the menu stays open**.
   *
   * Closing on the first character would hide the box he is typing into; closing on the last would
   * need this component to know when he had finished. It closes when he leaves it — a tap outside,
   * Escape, or Enter.
   */
  protected onFilter(value: string): void {
    this.filterChanged.emit(value);
  }

  protected clear(): void {
    this.filterChanged.emit('');
    this.shut(true);
  }

  protected onDocumentClick(event: Event): void {
    const target = event.target as Node | null;
    // The trigger's own click already ran `toggle()` and bubbled up to here; without the
    // containment test the two would cancel out and the menu would never open on a tap.
    if (target && !(this.host.nativeElement as HTMLElement).contains(target)) {
      this.shut();
    }
  }
}
