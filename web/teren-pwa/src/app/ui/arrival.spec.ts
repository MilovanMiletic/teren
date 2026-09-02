import { Arrival, ArrivalHandoff, NOTHING_PAINTED, arrivals, isFresh, settle } from './arrival';

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

describe('arrivals with a seed', () => {
  /**
   * The case a diff cannot see, and the one the feature exists for.
   *
   * Home is destroyed and rebuilt by the router, so the entry a foreman has just recorded is in the
   * **first** list the fold receives — and a first paint animates nothing. The capture flow names
   * it instead. Without this the whole mechanism fired in no real case at all.
   */
  it('animates a named row on the very first list', () => {
    const first = arrivals(NOTHING_PAINTED, list('new', 'old-1', 'old-2'), ['new']);

    expect([...first.fresh]).toEqual(['new']);
    expect(first.painted).toBe(true);
    expect(isFresh(first, 'old-1')).toBe(false);
  });

  /** A stale hand-off must not leave a phantom id sitting in `fresh` for ever. */
  it('ignores a seed that is not in the list', () => {
    const first = arrivals(NOTHING_PAINTED, list('a'), ['gone']);

    expect([...first.fresh]).toEqual([]);
  });

  /**
   * It seeds the **first** paint and nothing after it: a later fold is an ordinary diff.
   *
   * The seeded row stays marked while it is still on screen — an unchanged list returns the same
   * value, and that value is what the row is currently animating from. What must not happen is a
   * *second* row being invented out of the seed once the list moves on.
   */
  it('seeds the first paint only', () => {
    const first = arrivals(NOTHING_PAINTED, list('new'), ['new']);
    const again = arrivals(first, list('new'), ['new']);

    expect(again, 'an unchanged list is the same value').toBe(first);

    // The list moves on: the seed is spent, and only the genuinely new row is fresh.
    const grown = arrivals(again, list('newer', 'new'), ['new']);
    expect([...grown.fresh]).toEqual(['newer']);
  });
});

describe('settle', () => {
  /**
   * For a list that stops being drawn and is drawn again from scratch — the archive below 1024,
   * where opening a record removes the list and coming back rebuilds every row. Ids still in
   * `fresh` would animate a second time, on rows already seen.
   */
  it('clears what is new without forgetting what is known', () => {
    const painted = arrivals(NOTHING_PAINTED, list('a'));
    const grown = arrivals(painted, list('a', 'b'));
    const settled = settle(grown);

    expect([...settled.fresh]).toEqual([]);
    expect([...settled.known].sort()).toEqual(['a', 'b']);
    expect(settled.painted).toBe(true);
    // …and a later arrival is still detected against what it remembers.
    expect([...arrivals(settled, list('a', 'b', 'c')).fresh]).toEqual(['c']);
  });

  it('is the same value when there is nothing to clear', () => {
    const painted = arrivals(NOTHING_PAINTED, list('a'));

    expect(settle(painted)).toBe(painted);
    expect(settle(NOTHING_PAINTED)).toBe(NOTHING_PAINTED);
  });
});

describe('ArrivalHandoff', () => {
  /**
   * **Reading clears it**, and that is the whole design. A row rises the first time Home is painted
   * after a capture and never again, however many times the router rebuilds that Home afterwards.
   */
  it('hands over one id, once', () => {
    const handoff = new ArrivalHandoff();

    expect(handoff.take()).toEqual([]);

    handoff.announce('entry-1');
    expect(handoff.take()).toEqual(['entry-1']);
    expect(handoff.take()).toEqual([]);
  });

  it('keeps only the last thing announced', () => {
    const handoff = new ArrivalHandoff();
    handoff.announce('first');
    handoff.announce('second');

    expect(handoff.take()).toEqual(['second']);
  });
});
