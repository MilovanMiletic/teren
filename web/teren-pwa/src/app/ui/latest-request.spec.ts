import { LatestRequest } from './latest-request';

/**
 * `LatestRequest` — the counter that keeps an older answer from overwriting a newer question.
 *
 * Small enough that the specs are the contract: what the class must never do is agree with a
 * stale token, and what it must never do *either* is disagree with the only one outstanding.
 */
describe('LatestRequest', () => {
  it('holds the token of the only question asked', () => {
    const reads = new LatestRequest();

    const first = reads.claim();

    expect(reads.holds(first)).toBe(true);
  });

  it('drops every token a later claim replaced', () => {
    const reads = new LatestRequest();

    const first = reads.claim();
    const second = reads.claim();

    expect(reads.holds(first), 'a stale answer would have been painted').toBe(false);
    expect(reads.holds(second)).toBe(true);
  });

  /**
   * The rule that is easy to get wrong invisibly: a token read *after* the await is the current
   * one by construction, so the guard agrees with itself and proves nothing. This pins the shape
   * that makes the difference — `current()` before, `holds()` after.
   */
  it('lets an appending read use the question already outstanding, without cancelling it', () => {
    const reads = new LatestRequest();
    const question = reads.claim();

    // A "load more" belonging to that same question.
    const append = reads.current();

    expect(append).toBe(question);
    // …and it did not invalidate the list it is extending.
    expect(reads.holds(question)).toBe(true);
    expect(reads.holds(append)).toBe(true);
  });

  it('invalidates an outstanding append the moment the list is replaced', () => {
    const reads = new LatestRequest();
    reads.claim();
    const append = reads.current();

    // A filter change: a different question, and the batch in flight belongs to the old one.
    reads.claim();

    expect(reads.holds(append), 'fifty rows of the old query would have been appended').toBe(false);
  });

  /**
   * Nothing has been claimed yet, so no answer can belong to this screen. Worth pinning because
   * `0` is what a `number` field starts at, and a guard that treated it as current would let a
   * read that never claimed write whatever it liked.
   */
  it('starts owing nothing to anybody', () => {
    const reads = new LatestRequest();

    expect(reads.holds(0)).toBe(true);
    expect(reads.holds(1)).toBe(false);
    reads.claim();
    expect(reads.holds(0)).toBe(false);
  });
});
