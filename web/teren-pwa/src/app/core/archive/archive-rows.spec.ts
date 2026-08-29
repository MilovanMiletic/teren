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
