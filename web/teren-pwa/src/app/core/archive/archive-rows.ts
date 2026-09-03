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
  /**
   * When the report went out, or null — including "null because only the phone knows this row".
   *
   * Carried on the row rather than looked up per click because it is what decides whether the
   * list may offer a way back into the confirmation gate (`canRevise`). The phone does not store
   * it: a local-only row has never been reported by definition, and a row whose stale local
   * status still says `confirmed` is corrected by the server's answer the moment one arrives.
   */
  reportedAt: string | null;
  /** The evidence is on this phone: photos and audio can actually be opened. */
  onPhone: boolean;
  /** The server holds the complete entry (`received_at` is stamped). */
  onServer: boolean;
  /**
   * Why this day is stuck, as the server said it — or null, which is **silence and not an answer**.
   *
   * Null for a row the phone captured and the server has not listed, for a row an older server
   * sent without the field, and for a day with nothing wrong with it. All three must leave the
   * list behaving exactly as it did before this field existed, which is why every reader goes
   * through a named predicate (`core/api/failure-reason.ts`) rather than comparing strings.
   */
  failureReason: string | null;
  /** The day this row replaces, when it is a correction (PROJECT.md invariant 2). */
  supersedesEntryId: string | null;
  /**
   * The day that replaces **this** one, derived from the rows on screen — or null.
   *
   * **Only ever complete over the rows in hand**, and that limit is a property of the data rather
   * than of this function: the server sends the forward link on a correction and no reverse link
   * on the original, so the only way to mark the older end is to find the correction beside it. A
   * correction recorded on another foreman's phone, or one sitting on a page of the list this
   * device has not fetched, leaves the day it replaces unmarked. So a screen may say "of the days
   * I can see, this one was replaced" and must never say "this day is the current record".
   */
  supersededBy: string | null;
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
      // Only the server knows this. Overwritten below when it has answered.
      reportedAt: null,
      onPhone: true,
      onServer: entry.confirmedByServerAt !== null,
      // Only the server knows this too: a failure is written onto an entry by the pipeline and by
      // the report pass, never by the phone.
      failureReason: null,
      // The phone's own answer, because it wrote the link at capture time and principle 3 makes
      // the phone the source of truth until the server confirms. Filled from the server below
      // only where the phone has nothing — which is the row another device recorded.
      supersedesEntryId: entry.supersedesEntryId ?? null,
      // Derived from the whole list once it is assembled; see `markSuperseded`.
      supersededBy: null,
    });
  }

  for (const item of remote) {
    const existing = rows.get(item.id);
    if (existing) {
      existing.serverStatus = item.status;
      existing.reportedAt = item.reported_at;
      existing.onServer = existing.onServer || item.received_at !== null;
      // The server owns this: it is the pipeline and the report pass that write a failure onto an
      // entry. `?? null` rather than `||`, so a future server sending an empty string is not
      // quietly turned into silence — the two would then be indistinguishable on screen.
      existing.failureReason = item.failure_reason ?? null;
      existing.supersedesEntryId = existing.supersedesEntryId ?? item.supersedes_entry_id ?? null;
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
      reportedAt: item.reported_at,
      onPhone: false,
      onServer: item.received_at !== null,
      failureReason: item.failure_reason ?? null,
      supersedesEntryId: item.supersedes_entry_id ?? null,
      supersededBy: null,
    });
  }

  return markSuperseded([...rows.values()].sort(byNewestFirst));
}

/**
 * Fill in `supersededBy` from the forward links the rows themselves carry.
 *
 * The server gives a correction the id of the day it replaces and gives that day nothing, which is
 * right: a reverse link would be a second copy of one fact, written onto a row that is immutable
 * the moment it is reported. So the older end is marked by looking at the rows beside it.
 *
 * **After the sort, deliberately.** Two corrections of one day is a legal state — a correction can
 * itself be wrong, and the server allows chains — and the one worth naming on screen is the
 * newest. This walks the list in the order it is drawn, so the first correction it meets wins;
 * run it before the sort and the *oldest* replacement would silently become the one a foreman is
 * sent to.
 *
 * Mutates the rows it was handed, exactly as the merge above does throughout. The array is local
 * to {@link mergeArchiveRows} and has been handed to nobody yet.
 */
function markSuperseded(rows: ArchiveRow[]): ArchiveRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const row of rows) {
    const target = row.supersedesEntryId;
    if (target === null || target === row.id) {
      // A row replacing itself cannot be written by this app and cannot be stored by the server —
      // the target has to exist before the entry that names it — but drawn, it would be its own
      // replacement, which is a sentence with no meaning. Cheaper to refuse than to explain.
      continue;
    }
    const replaced = byId.get(target);
    if (replaced && replaced.supersededBy === null) {
      replaced.supersededBy = row.id;
    }
  }

  return rows;
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
