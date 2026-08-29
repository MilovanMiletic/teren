import { Injectable, inject } from '@angular/core';
import { Observable, from } from 'rxjs';
import Dexie, { liveQuery } from 'dexie';

import { localDay } from './local-day';
import { GeoFix, LocalEntry, LocalMedia, OutboxItem, OutboxState, Project } from './models';
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

  /**
   * Move an outbox item's state. B3 owns the sync loop; this is the single writer of outbox
   * state, so entry status and outbox state can never drift apart.
   */
  async setOutboxState(
    entryId: string,
    state: OutboxState,
    details: { lastError?: string | null; nextAttemptAt?: string | null } = {},
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.transaction('rw', this.db.entries, this.db.outbox, async () => {
      const item = await this.db.outbox.get(entryId);
      if (!item) {
        return;
      }
      await this.db.outbox.update(entryId, {
        state,
        attempts: state === 'in_flight' ? item.attempts + 1 : item.attempts,
        lastAttemptAt: state === 'in_flight' ? nowIso : item.lastAttemptAt,
        lastError: details.lastError ?? (state === 'failed' ? item.lastError : null),
        nextAttemptAt: details.nextAttemptAt ?? null,
      });
      await this.db.entries.update(entryId, {
        status: state === 'in_flight' ? 'uploading' : state === 'failed' ? 'failed' : 'queued',
        updatedAt: nowIso,
      });
    });
  }
}
