import { EntryListItemResponse } from '../api/api-types';
import { LocalEntry } from '../db/models';
import { groupArchiveRowsByDay, mergeArchiveRows } from './archive-rows';

function localEntry(overrides: Partial<LocalEntry> & Pick<LocalEntry, 'id'>): LocalEntry {
  return {
    projectId: 'project-1',
    projectName: 'Stambena zgrada Vojvode Stepe 212',
    capturedAt: '2026-08-29T14:12:00.000Z',
    localDay: '2026-08-29',
    status: 'queued',
    serverStatus: null,
    geo: null,
    audioDurationMs: 41_000,
    photoCount: 2,
    confirmedByServerAt: null,
    createdAt: '2026-08-29T14:12:00.000Z',
    updatedAt: '2026-08-29T14:12:00.000Z',
    ...overrides,
  };
}

function listItem(overrides: Partial<EntryListItemResponse> & Pick<EntryListItemResponse, 'id'>) {
  return {
    project_id: 'project-1',
    entry_date: '2026-08-27',
    status: 'reported',
    created_at: '2026-08-27T13:40:00.000Z',
    received_at: '2026-08-27T13:41:35.000Z',
    reported_at: '2026-08-27T14:06:00.000Z',
    photo_count: 4,
    has_audio: true,
    failure_reason: null,
    supersedes_entry_id: null,
    ...overrides,
  } satisfies EntryListItemResponse;
}

describe('mergeArchiveRows', () => {
  it('shows work that has never left the phone', () => {
    // Principle 3: the phone is the source of truth until the server confirms. An archive that
    // listed only what the server knows would hide the foreman's unsent day from him.
    const rows = mergeArchiveRows([localEntry({ id: 'a' })], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', onPhone: true, onServer: false, localStatus: 'queued' });
  });

  it('shows work recorded on another phone, which this one never held', () => {
    const rows = mergeArchiveRows([], [listItem({ id: 'b' })]);

    expect(rows[0]).toMatchObject({
      id: 'b',
      onPhone: false,
      onServer: true,
      localStatus: null,
      serverStatus: 'reported',
      // Only the phone knows a duration; the list endpoint does not carry one.
      audioDurationMs: null,
    });
  });

  it('merges the two halves of one entry instead of listing it twice', () => {
    const rows = mergeArchiveRows(
      [localEntry({ id: 'a', status: 'confirmed_by_server', confirmedByServerAt: 'x' })],
      [listItem({ id: 'a', entry_date: '2026-08-29', status: 'awaiting_confirmation' })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Each side is authoritative about different things: the server owns the pipeline status…
      serverStatus: 'awaiting_confirmation',
      // …and the phone owns whether the evidence can actually be opened here.
      onPhone: true,
      audioDurationMs: 41_000,
    });
  });

  it('prefers the larger photo count, so a pruned phone does not under-report the evidence', () => {
    // After C1 prunes a confirmed entry's local media the phone's count drops to zero. The entry
    // still has six photographs and the archive must still say so.
    const rows = mergeArchiveRows(
      [localEntry({ id: 'a', photoCount: 0 })],
      [listItem({ id: 'a', photo_count: 6 })],
    );

    expect(rows[0].photoCount).toBe(6);
  });

  it('prefers the server status over the stale one the sync loop last stored', () => {
    const rows = mergeArchiveRows(
      [localEntry({ id: 'a', serverStatus: 'processing' })],
      [listItem({ id: 'a', status: 'confirmed' })],
    );

    expect(rows[0].serverStatus).toBe('confirmed');
  });

  it('carries the moment the report went out, which decides whether the entry may still change', () => {
    // `reportedAt` is the field the archive reads to offer — or refuse — the way back into the
    // confirmation gate. Reading the status alone would offer a correction on an entry the
    // server has already sealed.
    const reported = mergeArchiveRows([], [listItem({ id: 'sent' })]);
    const editable = mergeArchiveRows(
      [],
      [listItem({ id: 'open', status: 'confirmed', reported_at: null })],
    );

    expect(reported[0].reportedAt).toBe('2026-08-27T14:06:00.000Z');
    expect(editable[0].reportedAt).toBeNull();
  });

  it('lets the server overrule a phone that still thinks a reported entry is merely confirmed', () => {
    // The phone stores a status and never a `reported_at`, so a local row alone cannot know the
    // report has gone. The list is what corrects it — and until it does, the confirmation screen
    // itself re-reads the entry and refuses to edit a sealed one.
    const rows = mergeArchiveRows(
      [localEntry({ id: 'a', serverStatus: 'confirmed' })],
      [listItem({ id: 'a', status: 'reported', reported_at: '2026-08-29T18:00:00.000Z' })],
    );

    expect(rows[0].reportedAt).toBe('2026-08-29T18:00:00.000Z');
    expect(mergeArchiveRows([localEntry({ id: 'a', serverStatus: 'confirmed' })], [])[0].reportedAt)
      .toBeNull();
  });

  it('orders by site day first, then by the moment inside it', () => {
    // Day before time: an entry captured just after midnight for the previous day's work must
    // not jump out of the day it belongs to.
    const rows = mergeArchiveRows(
      [
        localEntry({ id: 'late', localDay: '2026-08-28', capturedAt: '2026-08-29T00:20:00.000Z' }),
        localEntry({ id: 'early', localDay: '2026-08-29', capturedAt: '2026-08-29T07:05:00.000Z' }),
        localEntry({ id: 'noon', localDay: '2026-08-29', capturedAt: '2026-08-29T12:40:00.000Z' }),
      ],
      [],
    );

    expect(rows.map((row) => row.id)).toEqual(['noon', 'early', 'late']);
  });
});

describe('groupArchiveRowsByDay', () => {
  it('groups consecutive days and keeps the newest-first order', () => {
    const rows = mergeArchiveRows(
      [
        localEntry({ id: 'a', localDay: '2026-08-29', capturedAt: '2026-08-29T07:00:00.000Z' }),
        localEntry({ id: 'b', localDay: '2026-08-29', capturedAt: '2026-08-29T16:00:00.000Z' }),
        localEntry({ id: 'c', localDay: '2026-08-27', capturedAt: '2026-08-27T09:00:00.000Z' }),
      ],
      [],
    );

    const groups = groupArchiveRowsByDay(rows);

    expect(groups.map((group) => group.day)).toEqual(['2026-08-29', '2026-08-27']);
    expect(groups[0].rows.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('builds the heading date in local time, not UTC', () => {
    // `new Date('2026-08-29')` is UTC midnight, which prints as the 28th anywhere west of
    // Greenwich — a date header that is off by one for half the world.
    const [group] = groupArchiveRowsByDay(mergeArchiveRows([localEntry({ id: 'a' })], []));

    expect(group.date.getFullYear()).toBe(2026);
    expect(group.date.getMonth()).toBe(7);
    expect(group.date.getDate()).toBe(29);
    expect(group.date.getHours()).toBe(0);
  });
});

/*
 * ---- The two ends of a correction (2026-09-03) -------------------------------------------------
 *
 * `GET /api/entries` carries `supersedes_entry_id` on a correction and **nothing on the day it
 * replaces** — which is right: a reverse link would be a second copy of one fact, written onto a
 * row that is immutable the moment it is reported. So the older end can only be marked by looking
 * at the rows beside it, and everything below is about what that does and does not license the
 * screen to claim.
 */
describe('mergeArchiveRows and the correction link', () => {
  it('carries the forward link the server sent', () => {
    const rows = mergeArchiveRows(
      [],
      [listItem({ id: 'new', supersedes_entry_id: 'old' }), listItem({ id: 'old' })],
    );

    expect(rows.find((row) => row.id === 'new')?.supersedesEntryId).toBe('old');
  });

  /** Both ends, from one forward link — which is what lets the list stop looking identical. */
  it('marks the day a correction replaces', () => {
    const rows = mergeArchiveRows(
      [],
      [
        listItem({ id: 'new', entry_date: '2026-08-30', supersedes_entry_id: 'old' }),
        listItem({ id: 'old', entry_date: '2026-08-27' }),
      ],
    );

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('old')?.supersededBy).toBe('new');
    // …and the correction is not marked as replaced. A list where both ends carried the same chip
    // would be a list that produces the wrong record in a dispute.
    expect(byId.get('new')?.supersededBy).toBeNull();
    expect(byId.get('old')?.supersedesEntryId).toBeNull();
  });

  /**
   * **The limit, stated as a property of the data.**
   *
   * A correction recorded on another foreman's phone, or one sitting on a page of the list this
   * device has not fetched, leaves the day it replaces unmarked. So a screen may say "of the days
   * I can see, this one was replaced" and must never say "this day is the current record".
   */
  it('leaves the older day unmarked when the correction is not in the rows in hand', () => {
    const rows = mergeArchiveRows([], [listItem({ id: 'old' })]);

    expect(rows[0].supersededBy).toBeNull();
  });

  /**
   * Two corrections of one day is a legal state — a correction can itself be wrong, and the server
   * allows chains — and the one worth naming on screen is the **newest**.
   *
   * The marking runs after the sort and walks the list in the order it is drawn, so the first
   * correction it meets wins. Run before the sort, the *oldest* replacement would silently become
   * the one a foreman is sent to.
   */
  it('names the newest correction when a day was corrected twice', () => {
    const rows = mergeArchiveRows(
      [],
      [
        listItem({
          id: 'first',
          entry_date: '2026-08-28',
          created_at: '2026-08-28T09:00:00.000Z',
          supersedes_entry_id: 'old',
        }),
        listItem({
          id: 'second',
          entry_date: '2026-08-30',
          created_at: '2026-08-30T09:00:00.000Z',
          supersedes_entry_id: 'old',
        }),
        listItem({ id: 'old', entry_date: '2026-08-27' }),
      ],
    );

    // Newest first is the drawn order, so `second` is met first.
    expect(rows.map((row) => row.id)).toEqual(['second', 'first', 'old']);
    expect(rows.find((row) => row.id === 'old')?.supersededBy).toBe('second');
  });

  /**
   * A row replacing itself cannot be written by this app and cannot be stored by the server — the
   * target has to exist before the entry that names it. Drawn, though, it would be its own
   * replacement, which is a sentence with no meaning. Cheaper to refuse than to explain.
   */
  it('refuses a row that names itself', () => {
    const rows = mergeArchiveRows([], [listItem({ id: 'a', supersedes_entry_id: 'a' })]);

    expect(rows[0].supersededBy).toBeNull();
  });

  /**
   * **The phone's own answer wins**, because it wrote the link at capture time and principle 3
   * makes the phone the source of truth until the server confirms.
   *
   * The consequence that matters is the outbox: a correction that has not reached the server at all
   * must still read as a correction, or the archive would call it an ordinary entry for exactly as
   * long as the queue takes.
   */
  it('knows a correction that has never left the phone', () => {
    const rows = mergeArchiveRows([localEntry({ id: 'new', supersedesEntryId: 'old' })], []);

    expect(rows[0].supersedesEntryId).toBe('old');
  });

  it('fills the link from the server for a day this phone never recorded', () => {
    const rows = mergeArchiveRows([], [listItem({ id: 'new', supersedes_entry_id: 'old' })]);

    expect(rows[0].supersedesEntryId).toBe('old');
  });
});

/*
 * ---- Why a day is stuck --------------------------------------------------------------------
 *
 * **Null is silence, not an answer.** Three different situations produce it — a row the phone
 * captured and the server has not listed, a page from an older server that does not send the
 * field, and a day with nothing wrong with it — and all three must leave the list behaving exactly
 * as it did before this field existed.
 */
describe('mergeArchiveRows and the failure reason', () => {
  it('carries the reason the server wrote', () => {
    const rows = mergeArchiveRows(
      [],
      [listItem({ id: 'a', failure_reason: 'superseded_after_send' })],
    );

    expect(rows[0].failureReason).toBe('superseded_after_send');
  });

  it('reads a row the phone holds and the server has not listed as silence', () => {
    const rows = mergeArchiveRows([localEntry({ id: 'a' })], []);

    // The server owns this: a failure is written onto an entry by the pipeline and by the report
    // pass, never by the phone.
    expect(rows[0].failureReason).toBeNull();
  });

  it('reads an older server’s missing field as silence', () => {
    const rows = mergeArchiveRows(
      [localEntry({ id: 'a' })],
      // A page from a build that predates the field: `failure_reason` is simply absent.
      [{ ...listItem({ id: 'a' }), failure_reason: undefined }],
    );

    expect(rows[0].failureReason).toBeNull();
  });

  /**
   * `?? null` rather than `||`, so a future server sending an empty string is not quietly turned
   * into silence — the two would then be indistinguishable on screen.
   */
  it('keeps an empty reason distinguishable from no reason', () => {
    const rows = mergeArchiveRows([], [listItem({ id: 'a', failure_reason: '' })]);

    expect(rows[0].failureReason).toBe('');
  });
});
