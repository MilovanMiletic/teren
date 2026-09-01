import { Worker } from '../../core/company/company.service';
import { DEFAULT_DIRECTION, PeopleSort, sortWorkers, workerChips, workerState } from './people';

function worker(overrides: Partial<Worker> & { displayName: string }): Worker {
  return {
    id: overrides.displayName,
    username: overrides.displayName.toLowerCase(),
    email: null,
    language: 'sr',
    disabled: false,
    activeDeviceCount: 0,
    lastSeenAt: null,
    hasLiveCode: false,
    ...overrides,
  };
}

function names(workers: Worker[]): string[] {
  return workers.map((one) => one.displayName);
}

describe('workerState', () => {
  /**
   * The order an owner reads the list in to answer "who cannot record today". It is the only reason
   * "sort by state" means anything, so the ranking is asserted rather than assumed.
   */
  it('tells a man nobody is chasing from a man waiting on his own thumb', () => {
    expect(workerState(worker({ displayName: 'A' }))).toBe('stuck');
    expect(workerState(worker({ displayName: 'B', hasLiveCode: true }))).toBe('waiting');
    expect(workerState(worker({ displayName: 'C', activeDeviceCount: 1 }))).toBe('active');
  });

  /** Removed outranks everything: a disabled man's live phone is not something anybody relies on. */
  it('puts a removed man last whatever else is true of him', () => {
    expect(
      workerState(
        worker({ displayName: 'D', disabled: true, activeDeviceCount: 2, hasLiveCode: true }),
      ),
    ).toBe('removed');
  });
});

describe('workerChips', () => {
  it('says a code is waiting without ever saying what it is', () => {
    const chips = workerChips(worker({ displayName: 'A', hasLiveCode: true }));

    // The whole of decision 13 on the list, in one assertion: the chip is a *key*, and there is no
    // field on it that could carry a code even if somebody wanted one there.
    expect(chips.map((chip) => chip.key)).toContain('company.worker.hasCode');
    expect(JSON.stringify(chips)).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });

  it('always says something about his phone, in the right tone', () => {
    expect(workerChips(worker({ displayName: 'A', activeDeviceCount: 1 }))).toContainEqual({
      key: 'company.worker.hasPhone',
      tone: 'ok',
    });
    expect(workerChips(worker({ displayName: 'A' }))).toContainEqual({
      key: 'company.worker.noPhone',
      tone: 'neutral',
    });
  });

  it('leads with removed, because it changes what every other chip means', () => {
    const chips = workerChips(worker({ displayName: 'A', disabled: true, activeDeviceCount: 1 }));

    expect(chips[0]).toEqual({ key: 'company.worker.disabled', tone: 'err' });
  });
});

describe('sortWorkers', () => {
  const zoran = worker({
    displayName: 'Zoran',
    activeDeviceCount: 1,
    lastSeenAt: '2026-08-30T10:00:00Z',
  });
  const ana = worker({ displayName: 'Ana', hasLiveCode: true });
  const cvetko = worker({
    displayName: 'Cvetković',
    activeDeviceCount: 1,
    lastSeenAt: '2026-08-31T10:00:00Z',
  });
  const colic = worker({ displayName: 'Čolić' });
  const all = [zoran, ana, cvetko, colic];

  it('never mutates what it was given', () => {
    const original = [...all];

    sortWorkers(all, { key: 'state', direction: 'desc' });

    expect(all).toEqual(original);
  });

  /**
   * `Č` is a letter of its own in Serbian and sorts after `C`. The default (English) collation
   * folds it onto `c`, which puts Čolić between Cvetković and Ćirić — wrong in a way a Serbian
   * owner notices immediately.
   */
  it('sorts names the way Serbian sorts them', () => {
    expect(names(sortWorkers(all, { key: 'name', direction: 'asc' }))).toEqual([
      'Ana',
      'Cvetković',
      'Čolić',
      'Zoran',
    ]);
    expect(names(sortWorkers(all, { key: 'name', direction: 'desc' }))).toEqual([
      'Zoran',
      'Čolić',
      'Cvetković',
      'Ana',
    ]);
  });

  it('sorts by state, ties broken by name so the order is total', () => {
    // Čolić has neither phone nor code, Ana is waiting on her own code, the other two are active.
    expect(names(sortWorkers(all, { key: 'state', direction: 'asc' }))).toEqual([
      'Čolić',
      'Ana',
      'Cvetković',
      'Zoran',
    ]);
  });

  /**
   * The rule that makes this comparator worth a spec of its own: **`lastSeenAt: null` is not the
   * oldest contact, it is no contact.** A man who has never called home at the top of "oldest
   * first" would read as a phone that has gone quiet rather than one that never existed.
   */
  it('pins the men who have never called home below the dates, in both directions', () => {
    const newestFirst = names(sortWorkers(all, { key: 'contact', direction: 'desc' }));
    const oldestFirst = names(sortWorkers(all, { key: 'contact', direction: 'asc' }));

    expect(newestFirst).toEqual(['Cvetković', 'Zoran', 'Ana', 'Čolić']);
    expect(oldestFirst).toEqual(['Zoran', 'Cvetković', 'Ana', 'Čolić']);
  });

  /**
   * A comparator that answered 0 for a null-versus-date pair — the obvious shortcut — would be
   * intransitive, and `Array.prototype.sort` given an inconsistent comparator returns an arbitrary
   * order rather than an error. This is that bug asserted as a property: every sort of the same data
   * is the same sort.
   */
  it('is stable across repeated sorts of the same data', () => {
    for (const sort of [
      { key: 'contact', direction: 'asc' },
      { key: 'contact', direction: 'desc' },
      { key: 'state', direction: 'asc' },
    ] satisfies PeopleSort[]) {
      const once = names(sortWorkers(all, sort));
      const twice = names(sortWorkers([...all].reverse(), sort));
      expect(twice, `${sort.key}/${sort.direction} depends on the input order`).toEqual(once);
    }
  });

  it('starts each column in the direction that is worth a first tap', () => {
    // A date wants the most recent contact at the top; a name wants A→Ž.
    expect(DEFAULT_DIRECTION).toEqual({ name: 'asc', state: 'asc', contact: 'desc' });
  });
});
