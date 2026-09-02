import {
  TABLE_PAGE_SIZE,
  TableControls,
  clampPage,
  foldForFilter,
  matchesFilter,
  pageCountOf,
  slicePage,
} from './table-controls';

type Key = 'name' | 'state' | 'contact';

const DEFAULTS: Record<Key, 'asc' | 'desc'> = { name: 'asc', state: 'asc', contact: 'desc' };

function controls(): TableControls<Key> {
  return new TableControls<Key>({ key: 'name', direction: 'asc' }, DEFAULTS);
}

describe('foldForFilter', () => {
  /**
   * The whole reason this function exists. An owner hunting for Jovanović types `jovanovic`; on a
   * phone keyboard every accented letter is a long-press, and a filter that answers nothing until
   * they are right is a filter nobody uses twice.
   */
  it('folds the Serbian diacritics away, both cases', () => {
    expect(foldForFilter('Jovanović')).toBe('jovanovic');
    expect(foldForFilter('ČĆŠŽ')).toBe('ccsz');
  });

  /**
   * **`đ` has no Unicode decomposition** — it is a letter in its own right, not a `d` with a mark —
   * so `NFD` alone leaves it standing and `Đorđe` becomes unfindable by anyone typing on a keyboard
   * that has no `đ` key. It is folded explicitly, and this is the test that says so.
   */
  it('folds đ, which no amount of normalising would have done', () => {
    expect(foldForFilter('Đorđe')).toBe('dorde');
  });
});

describe('matchesFilter', () => {
  it('matches anywhere in the cell, not only at the start', () => {
    expect(matchesFilter('Vodoinstal Petrović d.o.o.', 'petrovic')).toBe(true);
    expect(matchesFilter('Vodoinstal Petrović d.o.o.', 'elektro')).toBe(false);
  });

  /** An empty box is not a filter that matches nothing; it is the absence of a filter. */
  it('an empty or blank needle keeps every row', () => {
    expect(matchesFilter('anything', '')).toBe(true);
    expect(matchesFilter('anything', '   ')).toBe(true);
  });
});

describe('TableControls', () => {
  it('picks a column up in its useful direction and turns it round on a second tap', () => {
    const table = controls();

    // A date column wants the most recent first, so the *first* tap is already descending.
    table.sortBy('contact');
    expect(table.sort()).toEqual({ key: 'contact', direction: 'desc' });

    table.sortBy('contact');
    expect(table.sort()).toEqual({ key: 'contact', direction: 'asc' });

    // Another column starts again in its own useful direction rather than keeping this one's.
    table.sortBy('name');
    expect(table.sort()).toEqual({ key: 'name', direction: 'asc' });
  });

  it('says which column is sorted, and reads it out to a screen reader', () => {
    const table = controls();

    expect(table.directionFor('name')).toBe('asc');
    expect(table.directionFor('state')).toBeNull();
    expect(table.ariaSort('name')).toBe('ascending');
    expect(table.ariaSort('state')).toBe('none');

    table.setSort('state', 'desc');
    expect(table.ariaSort('state')).toBe('descending');
    expect(table.ariaSort('name')).toBe('none');
  });

  /**
   * Two live filters narrow each other. Anything else — matching a row that answers *either* —
   * would make a second filter box widen the list, which is the opposite of what typing into one
   * looks like it should do.
   */
  it('ands the live filters together', () => {
    const table = controls();
    table.setFilter('name', 'zoran');
    // "aktivan", not "telefon": the chip for a man *without* a phone reads "Nema telefon", so the
    // shorter needle would have matched both and this test would have proved nothing.
    table.setFilter('state', 'aktivan');

    const zoranWithPhone = { name: 'Zoran Jovanović', state: 'Telefon aktivan', contact: '—' };
    const zoranWithout = { name: 'Zoran Jovanović', state: 'Nema telefon', contact: '—' };

    expect(table.passes((key) => zoranWithPhone[key])).toBe(true);
    expect(table.passes((key) => zoranWithout[key])).toBe(false);
  });

  /**
   * A box emptied is a filter gone, not a filter for the empty string — otherwise `filtering()`
   * would stay true after the last character was deleted and the screen would keep printing
   * "showing 12 of 12" over a list nobody was filtering.
   */
  it('forgets a filter whose box was emptied', () => {
    const table = controls();
    table.setFilter('name', 'zoran');
    expect(table.filtering()).toBe(true);
    expect(table.filterFor('name')).toBe('zoran');

    table.setFilter('name', '  ');
    expect(table.filtering()).toBe(false);
    expect(table.filterFor('name')).toBe('');
  });

  it('clears every column at once', () => {
    const table = controls();
    table.setFilter('name', 'zoran');
    table.setFilter('contact', '2026');

    table.clearFilters();

    expect(table.filtering()).toBe(false);
    expect(table.passes(() => 'anything at all')).toBe(true);
  });
});

/** A list of `size` distinguishable rows: `1`, `2`, … so a slice can be named exactly. */
function rows(size: number): number[] {
  return Array.from({ length: size }, (_, index) => index + 1);
}

describe('paging arithmetic', () => {
  /**
   * **Never zero.** Every clamp divides the world into "the page he asked for" and "the last page
   * there is"; a last page of zero would make page 1 invalid, and a table filtered down to nothing
   * could not be paged back out of.
   */
  it('an empty list is page 1 of 1', () => {
    expect(pageCountOf(0)).toBe(1);
    expect(clampPage(1, 0)).toBe(1);
    expect(slicePage(rows(0), 1)).toEqual([]);
  });

  it('counts pages by the product’s own page size', () => {
    expect(TABLE_PAGE_SIZE).toBe(10);
    expect(pageCountOf(10)).toBe(1);
    expect(pageCountOf(11)).toBe(2);
    expect(pageCountOf(24)).toBe(3);
  });

  it('cuts the list where the page boundaries are', () => {
    expect(slicePage(rows(24), 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(slicePage(rows(24), 3)).toEqual([21, 22, 23, 24]);
  });

  /**
   * **The clamp, which is the whole reason the arithmetic is a function and not four screens.**
   *
   * Standing on page 4 of a list that has just become eight rows long is an empty table — and an
   * empty table on `/company` reads as *my foremen are gone*, which is the exact conclusion the
   * loud filter strip exists to prevent. A reload that returns fewer rows is the path nobody
   * writes an event handler for, so the clamp lives on the read.
   */
  it('never hands back an empty page for a list that has rows in it', () => {
    expect(clampPage(4, 8)).toBe(1);
    expect(clampPage(9, 24)).toBe(3);
    expect(slicePage(rows(8), 4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(slicePage(rows(24), 99)).toEqual([21, 22, 23, 24]);
  });

  it('takes a nonsense page for the first one rather than throwing', () => {
    expect(clampPage(0, 24)).toBe(1);
    expect(clampPage(-3, 24)).toBe(1);
    expect(clampPage(Number.NaN, 24)).toBe(1);
  });
});

describe('TableControls paging', () => {
  it('starts on the first page and slices ten rows at a time', () => {
    const table = controls();

    expect(table.pageOn(24)).toBe(1);
    expect(table.pageCount(24)).toBe(3);
    expect(table.slice(rows(24))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    table.goTo(3);
    expect(table.pageOn(24)).toBe(3);
    expect(table.slice(rows(24))).toEqual([21, 22, 23, 24]);
  });

  /**
   * **The page resets when the visible set changes.**
   *
   * A filter typed, a filter cleared or a sort flipped makes the list a different list, and the
   * page he was on described the old one. The clamp would rescue him from an empty table either
   * way — but it would land him on the *last* page of the new answer, and the first is the one a
   * man who has just asked a question wants to see.
   */
  it('rewinds to the first page whenever the list becomes a different list', () => {
    const table = controls();

    for (const change of [
      () => table.setFilter('name', 'zoran'),
      () => table.setFilter('name', ''),
      () => table.sortBy('contact'),
      () => table.setSort('name', 'desc'),
      () => table.clearFilters(),
    ]) {
      table.goTo(3);
      expect(table.pageOn(24)).toBe(3);

      change();

      expect(table.pageOn(24)).toBe(1);
    }
  });

  /**
   * The other half of the same guard, and the half no event handler can cover: the rows went away
   * while the page number stayed. A reload that returns eight rows to a reader standing on page 3
   * must show him eight rows, not an empty table.
   */
  it('clamps on the read when the list shrinks underneath the reader', () => {
    const table = controls();
    table.goTo(3);

    expect(table.pageOn(8)).toBe(1);
    expect(table.slice(rows(8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  /**
   * **The documented consequence of storing intent rather than outcome**, pinned so a future
   * reader meets it as a decision instead of as a surprise: a list that shrinks and grows back
   * returns him to the page he chose, with no press. See the comment on `wantedPage`.
   */
  it('remembers the page he asked for across a list that shrinks and grows back', () => {
    const table = controls();
    table.goTo(3);

    // The list fails back to eight rows: he sees the eight, not an empty table.
    expect(table.pageOn(8)).toBe(1);

    // …and when the next read answers in full, his own choice is still what he gets.
    expect(table.pageOn(24)).toBe(3);
  });

  it('takes a page below the first as the first', () => {
    const table = controls();
    table.goTo(0);
    expect(table.pageOn(24)).toBe(1);
  });
});
