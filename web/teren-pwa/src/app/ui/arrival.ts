import { Injectable } from '@angular/core';

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
 * @param seed ids to treat as fresh **on the first paint only** — the one case a diff cannot see.
 *   Home is destroyed and rebuilt by the router, so the entry a foreman has just recorded is in
 *   the very first list this fold receives and would be adopted silently. The screen names it
 *   instead (`ArrivalHandoff`). Anything in the seed that is not in the list is ignored, so a
 *   stale hand-off cannot leave a phantom id in `fresh` for ever.
 *
 * Returns `previous` unchanged when nothing has changed at all — which is the ordinary case, since
 * Home re-reads the server's statuses every twenty seconds and the list itself usually has not
 * moved. A component holding this in a signal therefore does not repaint on every poll.
 */
export function arrivals(
  previous: Arrival,
  ids: Iterable<string>,
  seed: Iterable<string> = [],
): Arrival {
  const known = new Set(ids);

  if (!previous.painted) {
    // The first list is adopted whole: opening a screen is not twelve entries arriving. Whatever
    // the caller could *name* as having just arrived is the exception — see the `seed` parameter.
    const seeded = new Set<string>();
    for (const id of seed) {
      if (known.has(id)) {
        seeded.add(id);
      }
    }
    return { known, fresh: seeded, painted: true };
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

/**
 * The same list, with nothing new about it any more.
 *
 * For a list that stops being drawn and is then drawn again from scratch — the archive below 1024,
 * where opening a record removes the list entirely (`@if (showList())`) and coming back rebuilds
 * every row. Without this the ids still sitting in `fresh` animate a **second** time, on rows the
 * reader has already seen, which is the noise this whole mechanism exists to avoid.
 *
 * Returns the same value when there is nothing to clear, so a component may call it on every
 * change without repainting.
 */
export function settle(previous: Arrival): Arrival {
  if (previous.fresh.size === 0) {
    return previous;
  }
  return { known: previous.known, fresh: new Set<string>(), painted: previous.painted };
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

/**
 * The one fact a diff cannot discover: **which entry was just recorded.**
 *
 * Home is destroyed and rebuilt by the router — there is no reuse strategy in this app — so the
 * screen a foreman returns to after a capture has no memory of the list it showed a minute ago. Its
 * fold starts at {@link NOTHING_PAINTED}, the first list it receives already contains the new entry,
 * and by the rule that the first paint animates nothing, the row he came back to see is adopted in
 * silence. That was measured after the motion pass first shipped: one row on screen, zero animating,
 * at 390 and at 1280.
 *
 * So the capture flow **names** it on the way out and Home takes the name on the way in.
 *
 * ## Why a service and not router state
 *
 * Router state is history state: it survives a reload and a back navigation, so the same row would
 * rise again every time the foreman came back to Home through the browser’s own buttons, hours
 * later, as though something had just happened. A one-shot in memory says exactly what is true —
 * *this happened in this session, once* — and a reload correctly forgets it.
 *
 * It holds an **id and nothing else**: no evidence, no text, nothing a log or a screenshot could
 * leak. And it is deliberately not in `EntryStore`; that service owns what survives the phone being
 * switched off, and this is the opposite of that.
 */
@Injectable({ providedIn: 'root' })
export class ArrivalHandoff {
  private id: string | null = null;

  /** Called by the screen that is navigating away: the entry it just finished. */
  announce(entryId: string): void {
    this.id = entryId;
  }

  /**
   * Called once by the screen that has just been created. **Reading clears it**, which is the whole
   * point: a row rises the first time Home is painted after a capture and never again, however many
   * times that Home is rebuilt afterwards.
   */
  take(): string[] {
    const id = this.id;
    this.id = null;
    return id === null ? [] : [id];
  }
}
