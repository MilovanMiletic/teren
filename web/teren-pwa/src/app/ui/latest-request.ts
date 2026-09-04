/**
 * **Which answer the screen is still waiting for** — one counter, so an older answer can never
 * overwrite a newer question.
 *
 * ## The defect this exists to make impossible
 *
 * Every read screen in this product is the same three lines: set `loading`, `await` the gateway,
 * write what came back. With two reads in flight that last line is a race, and the ordering that
 * loses is not the unlikely one:
 *
 * - **A filter typed one letter at a time.** `ILIKE '%a%'` over a large table is *slower* than
 *   `'%ab%'`, so the broader question asked first is exactly the one that answers last. Measured
 *   on `/platform/logs` (review, 2026-09-04): type `a`, pause, type `b`, and three seconds later
 *   the screen was showing the rows for `a` under a filter box reading `ab` — the answer to a
 *   question nobody was asking any more, on the screen an owner opens *because* he does not trust
 *   what he is being told.
 * - **A reload pressed twice.** The slower attempt fails and lands after the faster one
 *   succeeded, and *"Nije provereno na serveru"* is painted over data that was confirmed a moment
 *   ago. The screen ends up less truthful than if it had never been reloaded.
 * - **An append that outlives its list.** A "load more" whose `loading()` check ran *before* the
 *   await — which is the point of the check — resolves after a filter change and puts fifty rows
 *   of the old query, and the old cursor, on the end of the new one.
 *
 * ## Why one small class rather than a counter per screen
 *
 * Six screens need it, and the two rules that make it work are both easy to get wrong in a way no
 * test notices: **claim before the await, never after** (read afterwards, the token would be
 * whatever question is current by then — precisely the one this answer does not belong to, and the
 * guard would agree with itself), and **an appending read reads the current token rather than
 * claiming a new one** (claiming would make a "load more" cancel the very list it is extending).
 * One documented place is one place to get them right.
 *
 * Deliberately not a signal: nothing renders this, and a signal read inside an `await` chain would
 * additionally be a reactive dependency nobody wants. Deliberately not cancellation either — an
 * `AbortController` per screen would abandon a response the server has already paid for, and this
 * client's rule is that nothing in flight is thrown away, only ignored.
 */
export class LatestRequest {
  private token = 0;

  /**
   * Take ownership of the screen for a read that **replaces** what is on it.
   *
   * Call it before the first `await`, and pass what it returns to {@link holds} once the answer is
   * back. Every read that was already in flight is invalidated by this call, which is the whole
   * point: they describe a question that is no longer being asked.
   */
  claim(): number {
    this.token += 1;
    return this.token;
  }

  /**
   * The token of the question currently being asked, without asking a new one.
   *
   * For a read that **appends** to what is on screen — a "load more". Captured before the await
   * for the reason the class comment gives, and never `claim()`ed: an append is part of the
   * question already outstanding, not a new one, and claiming would cancel the list it extends.
   */
  current(): number {
    return this.token;
  }

  /** Whether the answer belonging to `token` is still the one the screen is waiting for. */
  holds(token: number): boolean {
    return token === this.token;
  }
}
