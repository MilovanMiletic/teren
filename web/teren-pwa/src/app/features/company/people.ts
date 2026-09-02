import { Worker } from '../../core/company/company.service';
import { SortDirection } from '../../ui/table-controls';

/**
 * How a foreman stands today, as one value — the thing the people list sorts by.
 *
 * Not a label: every one of these is already said on the row as a chip, and inventing a second
 * vocabulary for the same fact is how two parts of one screen end up disagreeing. This exists so
 * that "sort by state" means something an owner would recognise, which is **the order he reads the
 * list in to answer "who cannot record today"**:
 *
 * - `stuck` — no phone and no code waiting. He cannot record, and nothing is on its way to him.
 *   The only one of the four that needs the admin to do something, so it sorts first.
 * - `waiting` — no phone, but a live code exists. The ball is in the foreman's court.
 * - `active` — at least one phone the server still accepts. The ordinary case.
 * - `removed` — taken out of service. Last whatever else is true of him: a disabled man's phone
 *   count is not a state anybody is chasing.
 */
export type WorkerState = 'stuck' | 'waiting' | 'active' | 'removed';

/** Sort order, lowest first. `removed` is deliberately last rather than merged into `stuck`. */
const STATE_RANK: Record<WorkerState, number> = {
  stuck: 0,
  waiting: 1,
  active: 2,
  removed: 3,
};

export function workerState(worker: Worker): WorkerState {
  if (worker.disabled) {
    return 'removed';
  }
  if (worker.activeDeviceCount > 0) {
    return 'active';
  }
  return worker.hasLiveCode ? 'waiting' : 'stuck';
}

/**
 * A status chip on a person's row: the key of the word, and how loudly to say it.
 *
 * Built here rather than in the template because both renderings of the list — the table from 768
 * up and the row list below it — must show the same chips in the same order, and two copies of the
 * same `@if` ladder is how they drift apart.
 *
 * **`hasLiveCode` is the only thing the list is allowed to know about a code.** It is a boolean on
 * the list row and it stays one: the chip says *that* a code is waiting, never what it is. See the
 * class comment on `CompanyPage` for why that is a security property and not a layout choice.
 */
export interface StatusChip {
  readonly key: string;
  readonly tone: 'ok' | 'warn' | 'err' | 'neutral';
}

export function workerChips(worker: Worker): StatusChip[] {
  const chips: StatusChip[] = [];

  // First, because it changes what every other chip means: a removed man's live phone is not
  // something anybody is relying on.
  if (worker.disabled) {
    chips.push({ key: 'company.worker.disabled', tone: 'err' });
  }

  chips.push(
    worker.activeDeviceCount > 0
      ? { key: 'company.worker.hasPhone', tone: 'ok' }
      : { key: 'company.worker.noPhone', tone: 'neutral' },
  );

  if (worker.hasLiveCode) {
    // The cue that decides the admin's next move on the man's own page: read the code he already
    // has, rather than issue one over it.
    chips.push({ key: 'company.worker.hasCode', tone: 'warn' });
  }

  return chips;
}

/** The three facts on a row worth ordering by. */
export type PeopleSortKey = 'name' | 'state' | 'contact';

/** One definition for every list in the product — see `ui/table-controls.ts`. */
export type { SortDirection };

export interface PeopleSort {
  readonly key: PeopleSortKey;
  readonly direction: SortDirection;
}

/**
 * Which way round a column starts when it is first picked.
 *
 * A name wants A→Ž; a state wants "who needs me" first, which is already `asc`; a date wants the
 * most recent contact at the top, which is `desc`. Picking the useful direction on the first tap
 * is the difference between one tap and two on every column.
 */
export const DEFAULT_DIRECTION: Record<PeopleSortKey, SortDirection> = {
  name: 'asc',
  state: 'asc',
  contact: 'desc',
};

/**
 * The company's foremen, in the order the list shows them. **Never mutates the input.**
 *
 * Two rules that are not obvious and are both deliberate:
 *
 * - **Ties always break on the name**, so the order is total and a re-sort of the same data cannot
 *   shuffle rows. Twelve men with a phone each would otherwise arrive in whatever order the server
 *   happened to send, and a list that reorders itself between reloads is a list nobody trusts.
 * - **A man who has never called home sorts last in both directions.** `lastSeenAt: null` is not
 *   "the oldest contact" — it is *no* contact, and putting him at the top of "oldest first" would
 *   read as a phone that has gone quiet rather than one that never existed.
 */
export function sortWorkers(workers: readonly Worker[], sort: PeopleSort): Worker[] {
  return [...workers].sort((left, right) => {
    const primary = compare(left, right, sort);
    return primary !== 0 ? primary : byName(left, right);
  });
}

/**
 * One column's comparison, direction already applied.
 *
 * The direction has to be applied **inside** this function rather than by multiplying its result,
 * because "never sorts last in both directions" cannot be expressed as a number that survives a
 * sign flip. Returning 0 for a null-versus-date pair instead — the obvious shortcut — makes the
 * comparator intransitive (null ties with every date, and the dates order among themselves), and
 * `Array.prototype.sort` given an inconsistent comparator produces an arbitrary order rather than
 * an error. That is a bug that looks like a flaky screen.
 */
function compare(left: Worker, right: Worker, sort: PeopleSort): number {
  const factor = sort.direction === 'asc' ? 1 : -1;

  switch (sort.key) {
    case 'name':
      return byName(left, right) * factor;
    case 'state':
      return (STATE_RANK[workerState(left)] - STATE_RANK[workerState(right)]) * factor;
    case 'contact': {
      if (left.lastSeenAt === null && right.lastSeenAt === null) {
        return 0;
      }
      // Undirected on purpose: a man who has never called home is not the oldest contact, he is
      // no contact, and pinning him below the dates in both directions is the honest answer.
      if (left.lastSeenAt === null) {
        return 1;
      }
      if (right.lastSeenAt === null) {
        return -1;
      }
      return (Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt)) * factor;
    }
  }
}

/**
 * Serbian Latin collation, explicitly.
 *
 * `Č`, `Ć`, `Š`, `Ž` and `Đ` are letters of their own and sort after the letters they are built
 * on; the default (English) collation folds them onto `c`, `s`, `z` and `d`, which puts Čolić
 * between Cvetković and Ćirić — wrong in a way a Serbian owner notices immediately.
 */
function byName(left: Worker, right: Worker): number {
  return left.displayName.localeCompare(right.displayName, 'sr-Latn');
}
