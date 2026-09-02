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

  /** How the list is ordered right now. */
  readonly sort: Signal<ColumnSort<K>> = this.order.asReadonly();

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
  }

  /** Order by a column in a named direction — what the column menu's two entries call. */
  setSort(key: K, direction: SortDirection): void {
    this.order.set({ key, direction });
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
  }

  clearFilters(): void {
    this.needles.set(new Map());
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
