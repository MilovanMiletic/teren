/**
 * Which rows in a list are **new since the last time it was drawn** — a pure function, so the one
 * case that matters can be tested rather than discovered on a phone.
 *
 * ## What it is for
 *
 * The founder's ask included *"when some new entry was added"*. Two lists in the product gain rows
 * while somebody is looking at them: Home's recent entries (he records, and the row appears) and
 * the archive (a Dexie live query, or a server list arriving behind the phone's own). A row that
 * simply exists on the next frame is a row he has to notice; a row that fades and rises into place
 * over `motion-base` is one he cannot miss.
 *
 * ## The rule that makes it useful instead of noisy
 *
 * **Nothing animates on the first paint of a list.** Twelve rows bouncing in every time he opens
 * the archive is decoration, and worse, it trains him to ignore the one gesture that was supposed
 * to mean *this is new*. So {@link NOTHING_PAINTED} is a distinct state from "painted, and it was
 * empty": the first list a component ever sees is adopted whole and silently, and only what arrives
 * **after** that is fresh.
 *
 * ## Why a value and not a DOM trick
 *
 * The alternative — animate every row on insert and let `@for`'s tracking sort it out — cannot tell
 * "this row is new" from "this row was re-created because the list was re-sorted or the language
 * changed". It is also invisible to a spec. This is a plain immutable value: a component keeps it in
 * a signal, hands each list to {@link arrivals}, and asks {@link isFresh} per row while rendering.
 */

/** What a list looked like last time, and what is new about it now. */
export interface Arrival {
  /** Every id the list held when it was last handed in. */
  readonly known: ReadonlySet<string>;

  /** The ids that were not in `known` — the ones worth animating. Always empty before the first. */
  readonly fresh: ReadonlySet<string>;

  /**
   * Whether a list has been handed in at all.
   *
   * The whole reason this interface is not just two sets. Without it, the first list a component
   * receives is indistinguishable from a list that grew from empty — and *those two must animate
   * differently*: the first is a screen being opened, the second is an entry being recorded.
   */
  readonly painted: boolean;
}

/** Before the first list. `fresh` is empty, so the first paint animates nothing. */
export const NOTHING_PAINTED: Arrival = {
  known: new Set<string>(),
  fresh: new Set<string>(),
  painted: false,
};

/**
 * Fold the next list into what was already on screen.
 *
 * @param previous what {@link arrivals} returned last time, or {@link NOTHING_PAINTED}.
 * @param ids the ids the list holds now, in any order.
 *
 * Returns `previous` unchanged when nothing has changed at all — which is the ordinary case, since
 * Home re-reads the server's statuses every twenty seconds and the list itself usually has not
 * moved. A component holding this in a signal therefore does not repaint on every poll.
 */
export function arrivals(previous: Arrival, ids: Iterable<string>): Arrival {
  const known = new Set(ids);

  if (!previous.painted) {
    // The first list is adopted whole: opening a screen is not twelve entries arriving.
    return { known, fresh: new Set<string>(), painted: true };
  }

  const fresh = new Set<string>();
  for (const id of known) {
    if (!previous.known.has(id)) {
      fresh.add(id);
    }
  }

  // A row that left and came back is new again, deliberately: from the reader's side it *is*
  // appearing, and the alternative is remembering every id the screen has ever seen.
  if (fresh.size === 0 && sameSet(previous.known, known)) {
    return previous;
  }

  return { known, fresh, painted: true };
}

/** Whether this row should be drawn arriving. */
export function isFresh(arrival: Arrival, id: string): boolean {
  return arrival.fresh.has(id);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}
