import { Injectable, inject } from '@angular/core';
import { Observable, from } from 'rxjs';
import Dexie, { liveQuery } from 'dexie';

import { STALLED_AFTER_ATTEMPTS } from '../api/api-failure';
import { localDay } from './local-day';
import {
  ConfirmDraft,
  GeoFix,
  LocalEntry,
  LocalMedia,
  OutboxItem,
  OutboxState,
  Project,
  needsConfirmation,
} from './models';
import { TEREN_DB } from './teren-db';

/** A photo that has already been compressed, with the metadata read before compression. */
export interface CapturedPhoto {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  /** The camera's own timestamp, from the original file. */
  capturedAt: string;
  originalByteSize: number;
  originalMimeType: string;
  geo: GeoFix | null;
}

export interface BeginCaptureInput {
  /** Generated with `crypto.randomUUID()` before recording starts — the idempotency key. */
  entryId: string;
  project: Project;
  /** When recording started, ISO-8601. */
  capturedAt: string;
  /** The container the recorder actually negotiated on this device. */
  mimeType: string;
}

/**
 * A pending entry and, if it has one, the outbox row trying to send it.
 *
 * `outbox` is null for a draft that has not been handed over yet. Drafts still appear here: from
 * the foreman's side an unsent recording is unsent, whether or not the queue has adopted it, and
 * a home screen that says "Sve poslato" over a draft sitting on disk would be a lie.
 */
export interface PendingEntry {
  entry: LocalEntry;
  outbox: OutboxItem | null;
}

/** Thrown when a photo is offered to an entry that is no longer open for changes. */
export class EntryNotOpenError extends Error {
  constructor(
    readonly entryId: string,
    readonly reason: 'missing' | 'not-draft',
  ) {
    super(`Entry ${entryId} is not open for changes (${reason})`);
    this.name = 'EntryNotOpenError';
  }
}

/**
 * Every write the phone makes to its own store.
 *
 * The contract, from PROJECT.md principle 3 and ARCHITECTURE.md §11:
 *
 * - Captured evidence is persisted here *before* any network attempt is even considered, and
 *   audio goes to disk *while* it is being recorded rather than only at stop.
 * - Multi-table writes run in one Dexie transaction, so an entry never exists without its audio
 *   and an outbox row never points at an entry that was not written.
 * - Nothing that is evidence is ever deleted. The only two deletions in this file are audio
 *   chunks — removed in the same transaction that writes the blob they were assembled into, so
 *   no byte is ever unreferenced — and a capture the user explicitly cancelled, which never
 *   became an entry in the first place.
 */
@Injectable({ providedIn: 'root' })
export class EntryStore {
  private readonly db = inject(TEREN_DB);

  // ---- Capture: recording straight to disk -------------------------------------------------

  /**
   * Open a capture session. Called before `MediaRecorder.start()`, so that the very first chunk
   * has somewhere to land and an interrupted recording can be reconstructed without the screen
   * that started it.
   */
  async beginCapture(input: BeginCaptureInput): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.captures.put({
      entryId: input.entryId,
      projectId: input.project.id,
      projectName: input.project.name,
      capturedAt: input.capturedAt,
      mimeType: input.mimeType,
      geo: null,
      chunkCount: 0,
      lastChunkAt: null,
      updatedAt: nowIso,
    });
  }

  /**
   * Write one slice of audio as it arrives. The counter on the session is bumped in the same
   * transaction, so `chunkCount` can never promise a chunk that is not there.
   */
  async appendChunk(entryId: string, blob: Blob): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.transaction('rw', this.db.captures, this.db.chunks, async () => {
      const session = await this.db.captures.get(entryId);
      if (!session) {
        return;
      }
      await this.db.chunks.put({ entryId, seq: session.chunkCount, blob, createdAt: nowIso });
      await this.db.captures.update(entryId, {
        chunkCount: session.chunkCount + 1,
        lastChunkAt: nowIso,
        updatedAt: nowIso,
      });
    });
  }

  /** Attach the position fix to a capture in progress, whenever it happens to arrive. */
  async setCaptureGeo(entryId: string, geo: GeoFix | null): Promise<void> {
    if (!geo) {
      return;
    }
    await this.db.captures.update(entryId, { geo, updatedAt: new Date().toISOString() });
  }

  /**
   * Turn a capture's chunks into a **draft** entry with its audio.
   *
   * Draft, not queued: the saved screen still lets the foreman add photos, and queueing here
   * would let B3's sync loop upload the entry out from under him. `queue()` is the explicit
   * hand-over to the network.
   *
   * Safe to call twice and safe to call from the start-up sweep: if the entry already exists the
   * leftovers are cleared and the existing entry returned. Returns null when the session captured
   * no audio at all — there is no evidence in an empty recording, and an empty entry in the diary
   * would be worse than none.
   *
   * `durationMs` comes from the live timer when a human pressed stop; when nobody did, it is
   * derived from the arrival time of the last chunk, which is the honest answer.
   */
  async finishCapture(
    entryId: string,
    options: { durationMs?: number } = {},
  ): Promise<LocalEntry | null> {
    return this.db.transaction(
      'rw',
      this.db.entries,
      this.db.media,
      this.db.chunks,
      this.db.captures,
      async () => {
        const session = await this.db.captures.get(entryId);
        const existing = await this.db.entries.get(entryId);
        if (existing) {
          await this.clearCaptureLeftovers(entryId);
          return existing;
        }
        if (!session) {
          return null;
        }

        const chunks = await this.db.chunks.where('entryId').equals(entryId).toArray();
        if (chunks.length === 0) {
          await this.clearCaptureLeftovers(entryId);
          return null;
        }
        chunks.sort((a, b) => a.seq - b.seq);

        const nowIso = new Date().toISOString();
        const durationMs =
          options.durationMs ??
          Math.max(
            0,
            Date.parse(session.lastChunkAt ?? session.capturedAt) - Date.parse(session.capturedAt),
          );

        const entry: LocalEntry = {
          id: entryId,
          projectId: session.projectId,
          projectName: session.projectName,
          capturedAt: session.capturedAt,
          localDay: localDay(new Date(session.capturedAt)),
          status: 'draft',
          serverStatus: null,
          geo: session.geo,
          audioDurationMs: durationMs,
          photoCount: 0,
          confirmedByServerAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        const blob = new Blob(
          chunks.map((chunk) => chunk.blob),
          { type: session.mimeType },
        );

        const audio: LocalMedia = {
          id: crypto.randomUUID(),
          entryId,
          kind: 'audio',
          blob,
          mimeType: session.mimeType,
          byteSize: blob.size,
          capturedAt: session.capturedAt,
          durationMs,
          geo: session.geo,
          uploadState: 'pending',
          storageKey: null,
          createdAt: nowIso,
        };

        await this.db.entries.put(entry);
        await this.db.media.put(audio);
        // The chunks and the assembled blob are the same bytes; dropping them here, inside the
        // transaction that wrote the blob, is a move rather than a deletion.
        await this.clearCaptureLeftovers(entryId);

        return entry;
      },
    );
  }

  /**
   * Throw away a capture the user explicitly cancelled.
   *
   * The only user-initiated deletion in the app, and it removes something that was never an
   * entry: a take the foreman decided against. Leaving the chunks behind would have the start-up
   * sweep resurrect a recording he already refused.
   */
  async discardCapture(entryId: string): Promise<void> {
    await this.db.transaction('rw', this.db.chunks, this.db.captures, () =>
      this.clearCaptureLeftovers(entryId),
    );
  }

  /** Sessions currently on disk, newest first. */
  async listCaptures(): Promise<string[]> {
    const sessions = await this.db.captures.toArray();
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((s) => s.entryId);
  }

  private async clearCaptureLeftovers(entryId: string): Promise<void> {
    await this.db.chunks.where('entryId').equals(entryId).delete();
    await this.db.captures.delete(entryId);
  }

  // ---- Photos --------------------------------------------------------------------------------

  /**
   * Attach a compressed photo to an entry, keeping the entry's photo counter in step.
   *
   * Guarded inside the transaction, not around it: a photo may only join an entry that exists and
   * is still a draft. Writing media for an entry that was never created would leave an orphan row
   * that no screen shows and no upload ever claims, and attaching to an entry already handed to
   * the outbox would mean B3 uploading a photo set that changes under it.
   */
  async addPhoto(entryId: string, photo: CapturedPhoto): Promise<LocalMedia> {
    const nowIso = new Date().toISOString();

    const media: LocalMedia = {
      id: crypto.randomUUID(),
      entryId,
      kind: 'photo',
      blob: photo.blob,
      mimeType: photo.mimeType,
      byteSize: photo.blob.size,
      capturedAt: photo.capturedAt,
      width: photo.width,
      height: photo.height,
      originalByteSize: photo.originalByteSize,
      originalMimeType: photo.originalMimeType,
      geo: photo.geo,
      uploadState: 'pending',
      storageKey: null,
      createdAt: nowIso,
    };

    await this.db.transaction('rw', this.db.entries, this.db.media, async () => {
      const entry = await this.db.entries.get(entryId);
      if (!entry) {
        throw new EntryNotOpenError(entryId, 'missing');
      }
      if (entry.status !== 'draft') {
        throw new EntryNotOpenError(entryId, 'not-draft');
      }
      await this.db.media.put(media);
      await this.db.entries.update(entryId, {
        photoCount: entry.photoCount + 1,
        updatedAt: nowIso,
      });
    });

    return media;
  }

  /**
   * Mark a draft as still being worked on.
   *
   * The saved screen calls this while it is open, so the abandonment sweep can tell a foreman
   * choosing his photos from a capture the phone forgot about.
   */
  async touchDraft(entryId: string): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.transaction('rw', this.db.entries, async () => {
      const entry = await this.db.entries.get(entryId);
      if (entry?.status === 'draft') {
        await this.db.entries.update(entryId, { updatedAt: nowIso });
      }
    });
  }

  /**
   * Hand an entry over to the outbox: `draft → queued`.
   *
   * Idempotent — pressing "done" twice, or a reload landing on the saved screen again, must not
   * produce two outbox rows or reset the attempt counter of one already in flight.
   */
  async queue(entryId: string): Promise<void> {
    const nowIso = new Date().toISOString();

    await this.db.transaction('rw', this.db.entries, this.db.outbox, async () => {
      const entry = await this.db.entries.get(entryId);
      if (!entry || entry.status !== 'draft') {
        return;
      }

      const existing = await this.db.outbox.get(entryId);
      if (!existing) {
        const last = await this.db.outbox.orderBy('seq').last();
        await this.db.outbox.put({
          entryId,
          state: 'queued',
          seq: (last?.seq ?? 0) + 1,
          attempts: 0,
          lastAttemptAt: null,
          nextAttemptAt: null,
          lastError: null,
          failureKind: null,
          createdAt: nowIso,
        });
      }

      await this.db.entries.update(entryId, { status: 'queued', updatedAt: nowIso });
    });
  }

  /**
   * Queue every draft left behind by an interrupted capture — the app was killed, the battery
   * died, the browser was swiped away on the saved screen.
   *
   * An abandoned capture is still evidence, and the one thing it must never do is sit on the
   * phone invisible to the sync queue.
   *
   * `graceMs` skips drafts touched in the last few minutes, and `except` skips the entry whose
   * screen is open right now — a foreman standing on the saved screen choosing photos must never
   * have his entry sent out from under him, however long the tab was in the background before he
   * came back to it.
   */
  async queueAbandonedDrafts(
    options: { graceMs?: number; except?: readonly string[] } = {},
  ): Promise<number> {
    const graceMs = options.graceMs ?? 2 * 60_000;
    const except = new Set(options.except ?? []);
    const cutoff = new Date(Date.now() - graceMs).toISOString();

    const drafts = await this.db.entries.where('status').equals('draft').toArray();
    const abandoned = drafts.filter((draft) => draft.updatedAt < cutoff && !except.has(draft.id));
    for (const draft of abandoned) {
      await this.queue(draft.id);
    }
    return abandoned.length;
  }

  /**
   * Everything the app does on start and on coming back to the front: assemble any recording the
   * phone was interrupted in the middle of, then hand abandoned drafts to the queue.
   *
   * Ordering matters — a rescued capture becomes a draft with a fresh `updatedAt`, so it is
   * inside the grace period and will not be queued in the same pass. That is deliberate: the user
   * may well be coming back to it.
   */
  async rescue(
    options: { graceMs?: number; except?: readonly string[] } = {},
  ): Promise<{ assembled: number; queued: number }> {
    const except = new Set(options.except ?? []);
    let assembled = 0;
    for (const entryId of await this.listCaptures()) {
      if (except.has(entryId)) {
        continue;
      }
      if (await this.finishCapture(entryId)) {
        assembled += 1;
      }
    }
    const queued = await this.queueAbandonedDrafts(options);
    return { assembled, queued };
  }

  async getEntry(entryId: string): Promise<LocalEntry | undefined> {
    return this.db.entries.get(entryId);
  }

  /**
   * Live list of everything an entry holds — the audio and every photo — oldest first.
   *
   * The archive needs the audio row that `watchPhotos` deliberately excludes: playing back what
   * was actually said is half of what makes a record evidence rather than a summary.
   */
  watchMedia(entryId: string): Observable<LocalMedia[]> {
    return from(
      liveQuery(async () => {
        const media = await this.db.media.where('entryId').equals(entryId).toArray();
        return media.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }),
    );
  }

  /** Live list of an entry's photos, oldest first. */
  watchPhotos(entryId: string): Observable<LocalMedia[]> {
    return from(
      liveQuery(async () => {
        const photos = await this.db.media.where({ entryId, kind: 'photo' }).toArray();
        return photos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }),
    );
  }

  /** Live list of the newest entries of a project, most recent first. */
  watchRecentEntries(projectId: string, limit = 5): Observable<LocalEntry[]> {
    return from(
      liveQuery(() =>
        this.db.entries
          .where('[projectId+capturedAt]')
          .between([projectId, Dexie.minKey], [projectId, Dexie.maxKey])
          .reverse()
          .limit(limit)
          .toArray(),
      ),
    );
  }

  /**
   * Live list of every entry this phone holds for a project, most recent first — the archive's
   * local half.
   *
   * Capped rather than unbounded: the cap is a memory guard on a device that may have been
   * recording daily for a year, not a product decision about how far back the archive goes. Older
   * work is still reachable, because the server's list is merged in beside this one.
   */
  watchEntriesForProject(projectId: string, limit = 200): Observable<LocalEntry[]> {
    return this.watchRecentEntries(projectId, limit);
  }

  /** Live view of "has an entry been recorded for this project today?". */
  watchEntriesForDay(projectId: string, day: string): Observable<LocalEntry[]> {
    return from(
      liveQuery(async () => {
        const entries = await this.db.entries.where('localDay').equals(day).toArray();
        return entries
          .filter((entry) => entry.projectId === projectId)
          .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      }),
    );
  }

  /**
   * Live view of everything the server has not got yet — the pending screen and the home sync row.
   *
   * Queued items first, in the order the sync loop will take them, then drafts that have not been
   * handed over. Drafts count: an entry that exists on the phone and not on the server is
   * pending, and a home screen reading "Sve poslato" over one would be exactly the lie this
   * product cannot afford. Read from the store rather than remembered in memory, so it survives a
   * reload (PROJECT.md principle 3).
   */
  watchPending(): Observable<PendingEntry[]> {
    return from(liveQuery(() => this.readPending()));
  }

  /** Live count of everything the server has not confirmed yet, drafts included. */
  watchPendingCount(): Observable<number> {
    return from(liveQuery(async () => (await this.readPending()).length));
  }

  /**
   * Live count of entries that are not simply waiting — they are not getting through.
   *
   * Blocked items (terminal) and items that have failed past `STALLED_AFTER_ATTEMPTS` while still
   * being retried. The home screen needs this separately from the pending count so its sync row
   * can stop saying "waiting to upload" over an entry that is stuck: the count alone is true but
   * reads as "on its way", and on the one screen a foreman actually looks at, that is the
   * difference between an honest queue and a reassuring one.
   */
  watchStuckCount(): Observable<number> {
    return from(
      liveQuery(async () => {
        const items = await this.db.outbox.toArray();
        return items.filter(
          (item) =>
            item.state === 'blocked' ||
            (item.state === 'failed' && item.attempts >= STALLED_AFTER_ATTEMPTS),
        ).length;
      }),
    );
  }

  private async readPending(): Promise<PendingEntry[]> {
    const pending: PendingEntry[] = [];

    for (const outbox of await this.db.outbox.orderBy('seq').toArray()) {
      const entry = await this.db.entries.get(outbox.entryId);
      if (entry) {
        pending.push({ entry, outbox });
      }
    }

    const drafts = await this.db.entries.where('status').equals('draft').toArray();
    drafts.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    for (const entry of drafts) {
      pending.push({ entry, outbox: null });
    }

    return pending;
  }

  // ---- The outbox: everything the sync loop writes ------------------------------------------

  /**
   * Move an outbox item's state. B3 owns the sync loop; this is the single writer of outbox
   * state, so entry status and outbox state can never drift apart.
   *
   * Everything below is expressed in terms of this one method rather than reaching into the
   * tables directly — a reviewer flagged the original seam as likely to be too narrow for B3, and
   * it was: the loop also has to record *why* an attempt failed. It is widened by adding
   * `failureKind` and the `blocked` state here, not by opening a second write path.
   */
  async setOutboxState(
    entryId: string,
    state: OutboxState,
    details: {
      lastError?: string | null;
      nextAttemptAt?: string | null;
      failureKind?: string | null;
    } = {},
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.transaction('rw', this.db.entries, this.db.outbox, async () => {
      const item = await this.db.outbox.get(entryId);
      if (!item) {
        return;
      }
      const failed = state === 'failed' || state === 'blocked';
      await this.db.outbox.update(entryId, {
        state,
        attempts: state === 'in_flight' ? item.attempts + 1 : item.attempts,
        lastAttemptAt: state === 'in_flight' ? nowIso : item.lastAttemptAt,
        lastError: details.lastError ?? (failed ? item.lastError : null),
        failureKind: details.failureKind ?? (failed ? item.failureKind : null),
        // A blocked item has no next attempt by definition: that is what makes it terminal.
        nextAttemptAt: state === 'blocked' ? null : (details.nextAttemptAt ?? null),
      });
      await this.db.entries.update(entryId, {
        status: ENTRY_STATUS_BY_OUTBOX_STATE[state],
        updatedAt: nowIso,
      });
    });
  }

  /**
   * The outbox items whose next attempt is due, oldest first.
   *
   * `blocked` items are never returned: they are terminal, and re-offering them to the loop is
   * exactly the battery-burning behaviour the state exists to prevent. `in_flight` items are not
   * returned either, because an attempt is already running against them **in this process** —
   * which is precisely why {@link releaseInFlight} has to exist: that reasoning holds inside one
   * page lifetime and breaks the moment the page is killed, and the row on disk outlives the loop
   * that wrote it.
   */
  async dueOutboxItems(now: number = Date.now()): Promise<OutboxItem[]> {
    const nowIso = new Date(now).toISOString();
    const items = await this.db.outbox.orderBy('seq').toArray();
    return items.filter(
      (item) =>
        (item.state === 'queued' || item.state === 'failed') &&
        (item.nextAttemptAt === null || item.nextAttemptAt <= nowIso),
    );
  }

  /**
   * When the loop should next wake for an item that is backing off, or null if nothing is
   * waiting. Lets the loop sleep exactly as long as it has to instead of polling.
   */
  async earliestNextAttempt(): Promise<string | null> {
    const items = await this.db.outbox.toArray();
    const waiting = items
      .filter((item) => item.state === 'failed' && item.nextAttemptAt !== null)
      .map((item) => item.nextAttemptAt!)
      .sort();
    return waiting[0] ?? null;
  }

  async getOutboxItem(entryId: string): Promise<OutboxItem | undefined> {
    return this.db.outbox.get(entryId);
  }

  /**
   * Put every item that was mid-upload back into the queue.
   *
   * ## Why an `in_flight` row on disk is a bug waiting to happen
   *
   * `in_flight` is written to IndexedDB, but the thing it describes — an attempt actually running
   * — lives only in a JavaScript task. The web platform ends those without warning: the foreman
   * pockets the phone and iOS discards the tab, the battery dies, the browser is swiped away.
   * ARCHITECTURE §11 calls this out and promises "resumption on next open"; on a site it is not
   * an edge case but the ordinary way a multi-photo upload ends.
   *
   * Left alone, such a row is stranded for good: it is not due, not counted as a backlog, not
   * counted as stuck, and has no retry button — while the pending screen goes on saying "Slanje
   * na server" about an entry nothing is sending. Every byte is safe and every screen is lying.
   *
   * ## Why releasing them is safe
   *
   * The whole upload conversation is replay-tolerant, and B3 proves it end to end: `POST /entries`
   * is idempotent on the client UUID, a re-declaration of the same file is free, an object already
   * verified comes back with no URL and is skipped, and an entry the server sealed while the phone
   * was not listening answers 409 — which the loop resolves through `received_at` and treats as
   * the success it is. So the worst case of releasing a row that really was still uploading (two
   * tabs open, say) is some repeated work, never a duplicate or a lost entry.
   *
   * The attempt counter is deliberately **not** reset: an attempt was made and it did not finish.
   * Pretending otherwise would let a phone that is killed mid-upload every time look, for ever,
   * like one that is merely on its first try.
   */
  async releaseInFlight(): Promise<number> {
    const stranded = await this.db.outbox.where('state').equals('in_flight').toArray();
    for (const item of stranded) {
      // Through the single writer, so the entry's own status comes back from `uploading` to
      // `queued` with it — a released row that still read "uploading" on the home screen would
      // have swapped one lie for another.
      await this.setOutboxState(item.entryId, 'queued');
    }
    return stranded.length;
  }

  /**
   * Live count of items the sync loop could act on. Its only job is to wake the loop when
   * something new is queued, so the foreman's entry leaves the phone at once rather than at the
   * next tick.
   */
  watchOutboxBacklog(): Observable<number> {
    return from(liveQuery(() => this.db.outbox.where('state').anyOf('queued', 'failed').count()));
  }

  /**
   * Drop an outbox row whose entry no longer exists.
   *
   * The only deletion the sync loop performs, and it removes a work ticket for work that cannot
   * be done — never evidence. An entry is never deleted, so this is reachable only from a store
   * that was interrupted between two writes.
   */
  async discardOrphanOutboxItem(entryId: string): Promise<void> {
    await this.db.transaction('rw', this.db.entries, this.db.outbox, async () => {
      if (await this.db.entries.get(entryId)) {
        return;
      }
      await this.db.outbox.delete(entryId);
    });
  }

  /**
   * Try this entry again now, at the foreman's explicit request.
   *
   * Serves the two rows that offer the button: a **blocked** item, which the loop will otherwise
   * never touch again, and a **stalled** one, which is still backing off and would otherwise wait
   * out its interval. In both cases pressing the button is a statement that something changed —
   * he walked outside, the Wi-Fi came back, a new build was installed — so the wait is cleared
   * and the attempt counter with it, which also puts the row back to "trying again" rather than
   * leaving it labelled as not getting through.
   *
   * An item that is `queued` or in flight is left alone: there is nothing to release.
   */
  async retryNow(entryId: string): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.transaction('rw', this.db.entries, this.db.outbox, async () => {
      const item = await this.db.outbox.get(entryId);
      if (!item || (item.state !== 'blocked' && item.state !== 'failed')) {
        return;
      }
      await this.db.outbox.update(entryId, {
        state: 'queued',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        failureKind: null,
      });
      await this.db.entries.update(entryId, { status: 'queued', updatedAt: nowIso });
    });
  }

  /**
   * The server has the whole entry: `queued → confirmed_by_server`.
   *
   * The outbox row is removed — and only the outbox row. It is a work ticket, not evidence: the
   * entry, its audio and its photos all stay exactly where they are, because pruning local media
   * is C1's job and PROJECT.md principle 3 allows it only after a grace period. Removing the
   * ticket is what takes the entry off the pending screen, which is the whole point of confirming
   * it.
   */
  async markConfirmedByServer(
    entryId: string,
    details: { serverStatus?: string | null; confirmedAt?: string } = {},
  ): Promise<void> {
    const nowIso = details.confirmedAt ?? new Date().toISOString();
    await this.db.transaction('rw', this.db.entries, this.db.outbox, async () => {
      const entry = await this.db.entries.get(entryId);
      if (!entry) {
        return;
      }
      await this.db.entries.update(entryId, {
        status: 'confirmed_by_server',
        serverStatus: (details.serverStatus as LocalEntry['serverStatus']) ?? entry.serverStatus,
        confirmedByServerAt: nowIso,
        updatedAt: nowIso,
      });
      await this.db.outbox.delete(entryId);
    });
  }

  /** Record what the server last said about an entry, without changing the phone's own state. */
  async setServerStatus(entryId: string, serverStatus: string | null): Promise<void> {
    await this.db.entries.update(entryId, {
      serverStatus: serverStatus as LocalEntry['serverStatus'],
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Write several server statuses in one transaction, and report how many actually changed.
   *
   * The count is what the caller needs: a status refresh runs on a timer, and re-rendering a
   * screen because the server repeated itself is churn. Rows the phone does not hold are skipped
   * silently — the server's list also carries entries recorded on other phones, and this table is
   * only ever about this one.
   */
  async applyServerStatuses(statuses: ReadonlyMap<string, string>): Promise<number> {
    if (statuses.size === 0) {
      return 0;
    }
    let changed = 0;
    const nowIso = new Date().toISOString();
    await this.db.transaction('rw', this.db.entries, async () => {
      for (const [entryId, serverStatus] of statuses) {
        const entry = await this.db.entries.get(entryId);
        if (!entry || entry.serverStatus === serverStatus) {
          continue;
        }
        await this.db.entries.update(entryId, {
          serverStatus: serverStatus as LocalEntry['serverStatus'],
          updatedAt: nowIso,
        });
        changed += 1;
      }
    });
    return changed;
  }

  /**
   * Live list of this project's entries that are waiting for the human (B5), oldest first.
   *
   * Oldest first on purpose: the queue of things needing attention is worked from the back of the
   * day forward, and the entry that has been waiting longest is the one closest to being the
   * report that never went out.
   */
  watchAwaitingConfirmation(projectId: string, limit = 50): Observable<LocalEntry[]> {
    return from(
      liveQuery(async () => {
        const entries = await this.db.entries
          .where('[projectId+capturedAt]')
          .between([projectId, Dexie.minKey], [projectId, Dexie.maxKey])
          .toArray();
        return entries.filter((entry) => needsConfirmation(entry.serverStatus)).slice(0, limit);
      }),
    );
  }

  // ---- Confirmation drafts (B5) --------------------------------------------------------------

  /**
   * Persist what a person has typed on the confirmation screen.
   *
   * Called on every change, and it is not a cache: for an entry whose extraction failed this is
   * the *only* copy of the record's content until the server accepts it. Cheap enough to do on a
   * keystroke's debounce — one small object, keyed by the entry id, overwritten in place.
   */
  async saveConfirmDraft(entryId: string, draft: unknown): Promise<void> {
    const row: ConfirmDraft = { entryId, draft, updatedAt: new Date().toISOString() };
    await this.db.confirmDrafts.put(row);
  }

  async getConfirmDraft(entryId: string): Promise<ConfirmDraft | undefined> {
    return this.db.confirmDrafts.get(entryId);
  }

  /**
   * Drop a draft. Called **only** after the server has accepted the confirmation — the same rule
   * that governs the outbox row, for the same reason: until the server answers, this phone is the
   * only place the work exists.
   */
  async clearConfirmDraft(entryId: string): Promise<void> {
    await this.db.confirmDrafts.delete(entryId);
  }

  // ---- Media, as the upload loop needs it ----------------------------------------------------

  /**
   * An entry's files in the order ARCHITECTURE §8 says to upload them: **audio first, then photos
   * one at a time**. The report only needs the recording, so processing can start while photos
   * are still climbing over a bad connection.
   */
  async listMediaForUpload(entryId: string): Promise<LocalMedia[]> {
    const media = await this.db.media.where('entryId').equals(entryId).toArray();
    return media.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'audio' ? -1 : 1;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /** Persist a file's checksum, computed lazily on its first upload attempt (Dexie v4). */
  async setMediaSha256(mediaId: string, sha256: string): Promise<void> {
    await this.db.media.update(mediaId, { sha256 });
  }

  /** The object store holds this file: record where, so a resumed attempt can skip it. */
  async markMediaUploaded(mediaId: string, storageKey: string): Promise<void> {
    await this.db.media.update(mediaId, { uploadState: 'uploaded', storageKey });
  }

  async setMediaUploadState(
    mediaId: string,
    uploadState: LocalMedia['uploadState'],
  ): Promise<void> {
    await this.db.media.update(mediaId, { uploadState });
  }
}

/**
 * The phone-side entry status implied by each outbox state.
 *
 * One table rather than a nested conditional, so adding a state cannot silently fall through to
 * `queued` — which is how an entry that can never be sent would end up telling the foreman it is
 * waiting for the network.
 */
const ENTRY_STATUS_BY_OUTBOX_STATE: Record<OutboxState, LocalEntry['status']> = {
  queued: 'queued',
  in_flight: 'uploading',
  failed: 'failed',
  blocked: 'blocked',
};
