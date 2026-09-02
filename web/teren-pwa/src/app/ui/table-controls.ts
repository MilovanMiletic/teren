import { Signal, computed, signal } from '@angular/core';

/** Which way round a column is ordered. One definition for every list in the product. */
export type SortDirection = 'asc' | 'desc';

/** The column a list is ordered by, and which way round. */
export interface ColumnSort<K extends string> {
  readonly key: K;
  readonly direction: SortDirection;
}

/**
 * The text a filter is matched against, folded so a Serbian name can be typed on any keyboard.
 *
 * Lower-cased, and then the diacritics dropped: an owner hunting for *Jovanović* types
 * `jovanovic`, and a founder hunting for *Vodoinstal Petrović d.o.o.* types `petrovic`. A filter
 * that answers nothing until the accents are right is a filter nobody uses twice — and on a phone
 * keyboard the accented letters are a long-press each.
 *
 * `NFD` splits a composed letter into its base and its mark, and the mark is then deleted. That
 * handles `č ć š ž` and their capitals. **`đ` has no decomposition** — it is a letter in its own
 * right in Unicode, not a `d` with a stroke — so it is folded explicitly; without that line
 * `djordje` finds nothing and `Đorđe` is the second most common name this product will ever hold.
 */
export function foldForFilter(value: string): string {
  return value
    .toLocaleLowerCase('sr-Latn')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

/** Whether a cell's text answers a filter. Empty needle matches everything, by definition. */
export function matchesFilter(text: string, needle: string): boolean {
  const wanted = foldForFilter(needle.trim());
  return wanted === '' || foldForFilter(text).includes(wanted);
}

/**
 * How many rows one page of a table holds — **one number for every table in the product**
 * (founder, 2026-09-02: *"we need to have 10 rows per table with pagination added"*).
 *
 * Declared here rather than on each screen for the same reason the sort and the filters are: four
 * copies of a page size is four places to disagree, and the one screen that fell behind would be
 * the one nobody looked at. `/platform/logs` imports this constant too, even though its filters run
 * on the server and it holds no {@link TableControls} — the number is the product's, not this
 * class's.
 */
export const TABLE_PAGE_SIZE = 10;

/**
 * How many pages `total` rows make. **Never zero.**
 *
 * An empty list is page 1 of 1, not page 1 of 0: every clamp below divides the world into "the
 * page he asked for" and "the last page there is", and a last page of zero would make the first
 * page invalid — so a table that had just been filtered down to nothing could not be paged back
 * out of.
 */
export function pageCountOf(total: number, size = TABLE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/**
 * The page actually being shown, for a list of `total` rows.
 *
 * **The clamp is applied on every read, not on the events somebody remembered.** Standing on page 4
 * of a list that has just become eight rows long is an empty table, and an empty table on
 * `/company` reads as *my foremen are gone* — which is the exact conclusion the loud filter strip
 * exists to prevent. A filter typed, a filter cleared, a sort flipped and a reload that returns
 * fewer rows are four different code paths and there will be a fifth; clamping where the number is
 * *used* covers all of them, including the one nobody has written yet.
 */
export function clampPage(page: number, total: number, size = TABLE_PAGE_SIZE): number {
  const wanted = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(1, wanted), pageCountOf(total, size));
}

/** The rows of one page. The clamp above, applied to the rows it was computed from. */
export function slicePage<T>(rows: readonly T[], page: number, size = TABLE_PAGE_SIZE): T[] {
  const start = (clampPage(page, rows.length, size) - 1) * size;
  return rows.slice(start, start + size);
}

/**
 * The sort and the per-column filters of one list, in one object.
 *
 * ## Why this is shared rather than three copies
 *
 * Every table in the product had grown its own `sort` signal, its own `sortBy` toggle, its own
 * `ariaSort` and its own pair of `sortedBy`/`ascending` helpers — and `/platform/companies` had
 * none of them at all, which is exactly why its header row rendered as plain black text while the
 * two directories beside it rendered muted uppercase (founder, 2026-09-02). The look was a symptom;
 * the duplication was the cause. One control object, one {@link ColumnMenu} component and one
 * stylesheet mean a fourth table inherits the behaviour rather than re-implementing three quarters
 * of it.
 *
 * ## Deliberately not in the URL
 *
 * A sort and a filter are ways of *looking* at a list, not places in the app. Nobody sends anybody
 * a link to "my foremen sorted by last contact", and the back gesture must mean "leave the office"
 * rather than "undo my last three column taps". Keeping them off the router also keeps them off the
 * route guards: a query parameter per keystroke would re-run `requiresCompanyAdmin` and re-read the
 * whole list from the server to paint the same rows in a different order.
 *
 * ## Filtering happens on the client, and that is a decision with a limit
 *
 * The lists these controls serve are a company's foremen and Teren's own accounts — tens of rows,
 * already fetched whole by one request. Filtering what is in hand is instant, works with no
 * network, and cannot disagree with the row count printed above it. It stops being the right answer
 * at the point where the server stops sending the whole list; when that day comes the filter moves
 * into the query and this class keeps its shape.
 */
export class TableControls<K extends string> {
  private readonly order = signal<ColumnSort<K>>({ key: '' as K, direction: 'asc' });
  private readonly needles = signal<ReadonlyMap<K, string>>(new Map());

  /**
   * The page the reader last asked for. **Deliberately private and deliberately unclamped.**
   *
   * Nothing may render this number: a table showing ten rows under the heading "page 4" is the
   * defect the clamp exists to prevent, wearing the clamp's own clothes. Every read goes through
   * {@link pageOn} or {@link slice}, both of which know how many rows there actually are.
   *
   * ## The consequence, stated rather than discovered
   *
   * Storing what he asked for rather than what he got means **the intent survives a list that
   * shrinks and grows back**: stand on page 3, let a reload answer with eight rows — he sees those
   * eight, clamped — then let the next reload answer with thirty, and the view returns to page 3
   * with no press. That is the behaviour, it was chosen, and it is the better of the two: a company
   * of forty whose list briefly failed should not silently reset a reader to the top, and every
   * event that genuinely makes the list a *different* list already calls {@link rewind}. The cost
   * is that one un-pressed jump, and it only ever restores a page he had actually chosen.
   */
  private readonly wantedPage = signal(1);

  /** How the list is ordered right now. */
  readonly sort: Signal<ColumnSort<K>> = this.order.asReadonly();

  /** How many rows one page holds. The product's number, not this list's — see {@link TABLE_PAGE_SIZE}. */
  readonly pageSize = TABLE_PAGE_SIZE;

  /** Whether any column is filtered — what the "clear all" control and the row count hang off. */
  readonly filtering = computed(() => [...this.needles().values()].some((v) => v.trim() !== ''));

  /**
   * @param initial the column the list starts on, in the direction its data already arrives in, so
   *   the first paint does not visibly reshuffle itself.
   * @param defaults the useful direction per column — a name wants A→Ž, a date wants the most
   *   recent first — so that a first tap on a column never costs a second one.
   */
  constructor(
    initial: ColumnSort<K>,
    private readonly defaults: Record<K, SortDirection>,
  ) {
    this.order.set(initial);
  }

  /** Pick a column up in its useful direction; tap it again to turn it round. */
  sortBy(key: K): void {
    const current = this.order();
    this.order.set(
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: this.defaults[key] },
    );
    this.rewind();
  }

  /** Order by a column in a named direction — what the column menu's two entries call. */
  setSort(key: K, direction: SortDirection): void {
    this.order.set({ key, direction });
    this.rewind();
  }

  /** The direction a column is sorted in, or null when the list is ordered by another one. */
  directionFor(key: K): SortDirection | null {
    const current = this.order();
    return current.key === key ? current.direction : null;
  }

  /** `aria-sort` for a header cell, so a screen reader reads the order the eye can see. */
  ariaSort(key: K): 'ascending' | 'descending' | 'none' {
    const direction = this.directionFor(key);
    return direction === null ? 'none' : direction === 'asc' ? 'ascending' : 'descending';
  }

  /** What is typed into a column's filter box, as the box needs it back. */
  filterFor(key: K): string {
    return this.needles().get(key) ?? '';
  }

  setFilter(key: K, value: string): void {
    const next = new Map(this.needles());
    if (value.trim() === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    this.needles.set(next);
    this.rewind();
  }

  clearFilters(): void {
    this.needles.set(new Map());
    this.rewind();
  }

  // ---- paging ---------------------------------------------------------------------------------

  /** How many pages `total` rows make, at this table's page size. Never zero. */
  pageCount(total: number): number {
    return pageCountOf(total, this.pageSize);
  }

  /**
   * The page being shown, for a list of `total` rows — clamped, always.
   *
   * This is the only number a screen may print, and the only one a pager may be handed.
   */
  pageOn(total: number): number {
    return clampPage(this.wantedPage(), total, this.pageSize);
  }

  /** The rows of the page being shown. The clamp again, this time against the rows themselves. */
  slice<T>(rows: readonly T[]): T[] {
    return slicePage(rows, this.wantedPage(), this.pageSize);
  }

  /**
   * Go to a page.
   *
   * Clamped at the bottom here and at the top on every read, which is the division of labour the
   * class comment argues for: this object never holds the rows, so it cannot know where the top is
   * at the moment a button is pressed — but it always knows where the top is at the moment a page
   * is drawn.
   */
  goTo(page: number): void {
    this.wantedPage.set(Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1);
  }

  /**
   * Back to the first page, because the visible set has just changed underneath the reader.
   *
   * A filter typed, a filter cleared or a sort flipped makes the list a different list, and the
   * page number he was on described the old one. Keeping it would leave an owner on page 4 of a
   * three-page answer — an empty table, on the screen where an empty table reads as *my foremen
   * are gone*. The clamp would rescue him on the next read; this makes the rescue unnecessary,
   * which is the difference between landing on the last page of the new answer and landing on the
   * first, and the first is the one he asked a question to see.
   */
  private rewind(): void {
    this.wantedPage.set(1);
  }

  /**
   * Whether a row survives every live filter.
   *
   * The row is described by **the text its own cells show**, which is what makes one filter box
   * work for a name, a date and a row of status chips without any of them declaring a type: what an
   * owner types is what he is reading. Several live filters are `and`-ed — each one narrows what
   * the last one left, which is the only reading of two filter boxes anybody expects.
   */
  passes(textFor: (key: K) => string): boolean {
    for (const [key, needle] of this.needles()) {
      if (!matchesFilter(textFor(key), needle)) {
        return false;
      }
    }
    return true;
  }
}
