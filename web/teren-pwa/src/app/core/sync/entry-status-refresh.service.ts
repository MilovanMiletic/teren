import { Injectable, inject } from '@angular/core';

import { ArchiveService, RemoteStatus } from '../archive/archive.service';
import { EntryStore } from '../db/entry-store';

export interface StatusRefreshResult {
  status: RemoteStatus;
  /** How many local rows actually moved. Zero on a failed, stale or redundant refresh. */
  changed: number;
  /**
   * True when this answer arrived after a newer one had already been written, and was therefore
   * dropped without touching a single row. Not a failure — the fresher answer is already in.
   */
  stale: boolean;
}

/**
 * Keeps the phone's copy of the **server's** status honest (B5).
 *
 * ## The defect this exists to fix
 *
 * `LocalEntry.serverStatus` was written exactly once — by the upload loop, from the `/complete`
 * response, where it is always `received` — and never again. Home reads that field. The archive
 * does not: it fetches `GET /api/entries` and merges the live status over the stale one. So for
 * every entry that has moved on, the two screens disagreed, and Home was the one that was wrong.
 *
 * That is not a cosmetic drift. `received` renders as "Primljen", which reads as *done, nothing to
 * do* — and it was showing over entries sitting in `needs_review`, waiting for the foreman.
 * Home is the screen he looks at. He would never open the entry that needed him, the confirmation
 * would never happen, and the day's evidence would never become a report. The confirmation gate
 * only works if the screen in front of him admits the gate is there.
 *
 * ## Why the list endpoint and not a poll per entry
 *
 * One request covers every recent entry of a site, carries `status` on each row, and is the same
 * call the archive already makes — so a refresh costs one round trip on a site connection instead
 * of one per entry. The entry endpoint stays what it is: the confirmation screen's poll, for the
 * single entry somebody is looking at.
 *
 * ## Best effort, and silent about it
 *
 * Nothing here throws and nothing here erases. A failed refresh leaves every local row exactly as
 * it was and reports the reason to the caller; the last thing a status refresh may do is turn a
 * flaky connection into a screen that has forgotten what it knew.
 *
 * ## Newest answer wins, and the others are dropped
 *
 * Refreshes overlap by design: Home runs one every 20 s, another when the tab becomes visible,
 * and another when connectivity returns — and coming back to the app fires two of those at once.
 * On a site connection an earlier request can easily resolve after a later one, and without a
 * guard its older statuses would be written straight over the fresher ones. That reintroduces the
 * exact defect this service exists to fix: Home showing `received` over an entry the server has
 * already moved to `needs_review`. It self-heals on the next poll, but "wrong for up to twenty
 * seconds" is wrong on the one screen the foreman reads.
 *
 * So every call takes a ticket, and an answer is written only if no newer answer has been written
 * already. A monotonic counter is enough — this is one service, one JavaScript thread, and the
 * comparison happens before any `await`, so nothing can slip between the check and the claim.
 */
@Injectable({ providedIn: 'root' })
export class EntryStatusRefresher {
  private readonly archive = inject(ArchiveService);
  private readonly store = inject(EntryStore);

  /** Tickets handed out, and the highest one whose answer has been accepted. */
  private issued = 0;
  private applied = 0;

  /**
   * Re-read this project's entries and write back any status that has moved.
   *
   * The limit matches the archive's own: an archive is read by scrolling back through days, and
   * the same list serves both, so asking for less here would mean two different answers to the
   * same question depending on which screen asked.
   */
  async refresh(projectId: string, limit = 200): Promise<StatusRefreshResult> {
    const ticket = ++this.issued;
    const result = await this.archive.listEntries(projectId, limit);
    if (result.status !== 'ok') {
      return { status: result.status, changed: 0, stale: false };
    }

    // Claimed before the write starts, not after: two accepted answers may both be mid-write, and
    // Dexie serialises them in the order their transactions opened — which is this order.
    if (ticket <= this.applied) {
      return { status: 'ok', changed: 0, stale: true };
    }
    this.applied = ticket;

    const statuses = new Map<string, string>();
    for (const item of result.items) {
      statuses.set(item.id, item.status);
    }

    return { status: 'ok', changed: await this.store.applyServerStatuses(statuses), stale: false };
  }
}
