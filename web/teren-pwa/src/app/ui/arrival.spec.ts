import { Arrival, NOTHING_PAINTED, arrivals, isFresh } from './arrival';

/** The ids a list is holding, the way a component hands them over. */
function list(...ids: string[]): string[] {
  return ids;
}

describe('arrivals', () => {
  /**
   * The rule the whole file exists for.
   *
   * A twelve-row archive that bounces in every time the screen is opened is decoration, and it
   * destroys the meaning of the one gesture that was supposed to say *this row is new*.
   */
  it('animates nothing on the first list it is given', () => {
    const first = arrivals(NOTHING_PAINTED, list('a', 'b', 'c'));

    expect([...first.fresh]).toEqual([]);
    expect([...first.known].sort()).toEqual(['a', 'b', 'c']);
    expect(first.painted).toBe(true);
  });

  it('marks only what was not there before', () => {
    const painted = arrivals(NOTHING_PAINTED, list('a', 'b'));
    const grown = arrivals(painted, list('new', 'a', 'b'));

    expect([...grown.fresh]).toEqual(['new']);
    expect(isFresh(grown, 'new')).toBe(true);
    expect(isFresh(grown, 'a')).toBe(false);
  });

  /**
   * "Painted and empty" is not the same state as "never painted", and this is where the difference
   * is spent: an empty archive that gains its first entry **does** animate, because that entry
   * genuinely arrived while he was looking at the screen.
   */
  it('animates the first row of a list that was painted empty', () => {
    const empty = arrivals(NOTHING_PAINTED, list());
    const one = arrivals(empty, list('first'));

    expect(empty.painted).toBe(true);
    expect([...one.fresh]).toEqual(['first']);
  });

  /** Home re-asks the server every twenty seconds; an unchanged list must not repaint. */
  it('returns the same value when nothing has changed', () => {
    const painted = arrivals(NOTHING_PAINTED, list('a', 'b'));

    expect(arrivals(painted, list('a', 'b'))).toBe(painted);
    // Order is not a change: the archive re-sorts without anything arriving.
    expect(arrivals(painted, list('b', 'a'))).toBe(painted);
  });

  it('stops calling a row new once it has been drawn', () => {
    const painted = arrivals(NOTHING_PAINTED, list('a'));
    const grown = arrivals(painted, list('a', 'b'));
    const settled = arrivals(grown, list('a', 'b'));

    expect([...grown.fresh]).toEqual(['b']);
    expect(settled).toBe(grown);

    // …and the third list, which changes something else, does not resurrect it.
    const later = arrivals(settled, list('a', 'b', 'c'));
    expect([...later.fresh]).toEqual(['c']);
  });

  /** A shrinking list is a change, and none of what is left is new. */
  it('forgets rows that left, and calls nothing fresh for it', () => {
    const painted = arrivals(NOTHING_PAINTED, list('a', 'b', 'c'));
    const shrunk = arrivals(painted, list('a'));

    expect([...shrunk.fresh]).toEqual([]);
    expect([...shrunk.known]).toEqual(['a']);
    expect(shrunk).not.toBe(painted);
  });

  /**
   * A row that left and came back animates again — deliberately.
   *
   * From the reader's side it *is* appearing. The alternative is remembering every id the screen has
   * ever held, which on the archive of a site with four years of entries is a set that only grows.
   */
  it('animates a row that comes back', () => {
    const painted = arrivals(NOTHING_PAINTED, list('a', 'b'));
    const gone = arrivals(painted, list('a'));
    const back = arrivals(gone, list('a', 'b'));

    expect([...back.fresh]).toEqual(['b']);
  });

  it('never mutates the value it was handed', () => {
    const painted: Arrival = arrivals(NOTHING_PAINTED, list('a'));
    arrivals(painted, list('a', 'b'));

    expect([...painted.known]).toEqual(['a']);
    expect([...painted.fresh]).toEqual([]);
    // The shared constant most of all: one component's first list must not silence another's.
    expect(NOTHING_PAINTED.painted).toBe(false);
    expect(NOTHING_PAINTED.known.size).toBe(0);
  });
});
