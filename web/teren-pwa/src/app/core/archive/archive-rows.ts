import { EntryListItemResponse } from '../api/api-types';
import { LocalEntry, LocalEntryStatus } from '../db/models';

/**
 * One row of the archive.
 *
 * The archive has two sources that overlap and neither is complete on its own. The phone knows
 * everything it captured, including work that has never reached the server — hiding that would
 * contradict principle 3, which says the phone is the source of truth until the server confirms.
 * The server knows everything the *company* captured, including days recorded on another phone,
 * before this device was bound, or after its local copy was pruned (C1). So a row is the union,
 * and it remembers which side it came from, because "not yet sent" and "sent months ago and
 * pruned from this phone" look identical on a list that forgets.
 */
export interface ArchiveRow {
  id: string;
  /** The site day, `YYYY-MM-DD` — the day the work happened, not the day it was uploaded. */
  day: string;
  /**
   * The best known capture moment, ISO-8601, used to order within a day and to print a time.
   *
   * The phone's own `capturedAt` wins when there is one: it is the clock that was on the site,
   * recorded before any network was involved.
   */
  capturedAt: string;
  photoCount: number;
  hasAudio: boolean;
  /** Only the phone knows this; the list endpoint does not carry a duration. */
  audioDurationMs: number | null;
  /** Null for a row this device never captured. */
  localStatus: LocalEntryStatus | null;
  serverStatus: string | null;
  /** The evidence is on this phone: photos and audio can actually be opened. */
  onPhone: boolean;
  /** The server holds the complete entry (`received_at` is stamped). */
  onServer: boolean;
}

/**
 * Merge what the phone holds with what the server listed, newest first.
 *
 * Where both sides describe the same entry the merge is not "one wins": each side is authoritative
 * about different things. The server owns the pipeline status (only it knows an entry was
 * transcribed); the phone owns the capture facts (the real clock, the recording length, and — the
 * one that matters for opening the record — whether the bytes are on this device.)
 *
 * `remote` may be empty because the device is offline, because the build has no token, or because
 * the server is down. None of those is a reason to show an empty archive, which is why this
 * function takes the two lists rather than fetching either.
 */
export function mergeArchiveRows(
  local: readonly LocalEntry[],
  remote: readonly EntryListItemResponse[],
): ArchiveRow[] {
  const rows = new Map<string, ArchiveRow>();

  for (const entry of local) {
    rows.set(entry.id, {
      id: entry.id,
      day: entry.localDay,
      capturedAt: entry.capturedAt,
      photoCount: entry.photoCount,
      hasAudio: true,
      audioDurationMs: entry.audioDurationMs,
      localStatus: entry.status,
      // The last thing the sync loop heard. Overwritten below if the list is fresher.
      serverStatus: entry.serverStatus,
      onPhone: true,
      onServer: entry.confirmedByServerAt !== null,
    });
  }

  for (const item of remote) {
    const existing = rows.get(item.id);
    if (existing) {
      existing.serverStatus = item.status;
      existing.onServer = existing.onServer || item.received_at !== null;
      // The server counts what it verified. The phone counts what it holds, and after C1 prunes
      // a confirmed entry that is zero — so the larger of the two is the honest number of photos
      // this entry has, and `onPhone` says separately whether they can be opened here.
      existing.photoCount = Math.max(existing.photoCount, item.photo_count);
      continue;
    }

    rows.set(item.id, {
      id: item.id,
      day: item.entry_date,
      capturedAt: item.created_at,
      photoCount: item.photo_count,
      hasAudio: item.has_audio,
      audioDurationMs: null,
      localStatus: null,
      serverStatus: item.status,
      onPhone: false,
      onServer: item.received_at !== null,
    });
  }

  return [...rows.values()].sort(byNewestFirst);
}

/**
 * Newest first, by the site day and then by the moment inside it.
 *
 * Day before time on purpose: a phone whose clock was wrong, or an entry captured just after
 * midnight for the previous day's work, must not jump out of its day in a list that is grouped by
 * day. The id is the final tiebreak so the order is stable across renders.
 */
function byNewestFirst(a: ArchiveRow, b: ArchiveRow): number {
  return (
    b.day.localeCompare(a.day) ||
    b.capturedAt.localeCompare(a.capturedAt) ||
    a.id.localeCompare(b.id)
  );
}

export interface ArchiveDayGroup {
  day: string;
  /** Midnight of `day` in local time — what the template hands to the date pipe. */
  date: Date;
  rows: ArchiveRow[];
}

/**
 * Group the merged rows by site day, preserving the newest-first order.
 *
 * The roadmap asks for entries "grouped or labelled by date". Grouped, because a foreman looking
 * for the day the pipes went into the wall is looking for a *day*, and because two entries on one
 * day — the normal shape of a day where something changed after lunch — read as one day's work
 * rather than as two unrelated rows.
 */
export function groupArchiveRowsByDay(rows: readonly ArchiveRow[]): ArchiveDayGroup[] {
  const groups: ArchiveDayGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.day === row.day) {
      last.rows.push(row);
      continue;
    }
    groups.push({ day: row.day, date: dayToLocalDate(row.day), rows: [row] });
  }
  return groups;
}

/**
 * `YYYY-MM-DD` as a local `Date`.
 *
 * `new Date('2026-08-29')` parses as **UTC midnight**, which in Belgrade prints as the 29th but
 * in any negative offset prints as the 28th — a date header that is off by one for half the
 * world. The explicit time component forces local-time parsing.
 */
function dayToLocalDate(day: string): Date {
  return new Date(`${day}T00:00:00`);
}
