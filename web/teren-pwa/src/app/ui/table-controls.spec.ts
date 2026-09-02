import { TableControls, foldForFilter, matchesFilter } from './table-controls';

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
