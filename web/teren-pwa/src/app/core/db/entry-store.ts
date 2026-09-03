import { Injectable, inject } from '@angular/core';
import { Observable, from } from 'rxjs';
import Dexie, { liveQuery } from 'dexie';

import { FailureKind, STALLED_AFTER_ATTEMPTS } from '../api/api-failure';
import { localDay } from './local-day';
import {
  CaptureSession,
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

/**
 * How recently a chunk must have arrived for a capture to count as **live** rather than orphaned.
 *
 * Five seconds against a one-second chunk interval, so a recording that is running has always
 * written something inside the window and a capture the tab died in the middle of has not. See
 * `EntryStore.rescue`, which is the only reader and the only place this matters.
 */
export const LIVE_CAPTURE_WINDOW_MS = 5_000;

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
    return (await this.captureSessions()).map((session) => session.entryId);
  }

  /**
   * Correct a capture's start time to the moment audio actually began.
   *
   * `beginCapture` has to stamp *something* before `getUserMedia` is called — a chunk cannot be
   * homeless — but the moment it stamps is the moment the microphone was *asked for*, and on a
   * first-ever recording the permission sheet sits there until a man with muddy hands finds the
   * "Allow" button. Twenty seconds of that used to become twenty seconds of phantom recording: in
   * the entry's `capturedAt` and therefore in `created_at`, in the timestamp printed on the client's
   * report, and in the duration `finishCapture` derives from `lastChunkAt - capturedAt` when
   * nobody pressed stop.
   *
   * Only the timestamp moves. The chunks, the id and the session are untouched, so this is safe to
   * lose: a call that never lands leaves the honest-but-early stamp behind rather than nothing.
   */
  async markCaptureStarted(entryId: string, capturedAt: string): Promise<void> {
    await this.db.captures.update(entryId, { capturedAt, updatedAt: new Date().toISOString() });
  }

  /** The capture rows themselves, newest first. */
  private async captureSessions(): Promise<CaptureSession[]> {
    const sessions = await this.db.captures.toArray();
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
   *
   * ## A capture that is still producing audio is not an orphan
   *
   * `finishCapture` assembles what is on disk and **deletes the session**, and every chunk that
   * arrives afterwards is dropped by `appendChunk`'s missing-session branch while the screen's
   * timer keeps climbing. Called against a live recording, this method is therefore not a rescue
   * at all: it is a silent truncation, which is what it did on every return to the foreground
   * until 2026-09-02 (see `rescue.service.ts`).
   *
   * So {@link LIVE_CAPTURE_WINDOW_MS} is checked here, in the store, in addition to the caller's
   * `except` list. **Deliberately not instead of it**: the caller knows which take is live from
   * the recorder and can say so with certainty, and this only knows that bytes arrived a moment
   * ago. Either alone closes the defect; both together mean the next caller of `rescue()` — a
   * future "clean up" button, a spec, a background task — cannot reopen it by forgetting the
   * exemption.
   *
   * The window is generous relative to the one-second chunk interval and *tiny* relative to the
   * thing it protects. Being wrong the other way — declining to assemble a genuinely dead capture
   * for five seconds — costs nothing at all: the next sweep, or the next app start, takes it.
   */
  async rescue(
    options: { graceMs?: number; except?: readonly string[] } = {},
  ): Promise<{ assembled: number; queued: number }> {
    const except = new Set(options.except ?? []);
    const liveSince = Date.now() - LIVE_CAPTURE_WINDOW_MS;
    let assembled = 0;
    for (const session of await this.captureSessions()) {
      if (except.has(session.entryId)) {
        continue;
      }
      // An unparseable or absent stamp reads as NaN and falls through to be assembled, which is
      // the safe direction: a capture nothing can date is exactly the orphan this sweep is for.
      if (Date.parse(session.lastChunkAt ?? '') > liveSince) {
        continue;
      }
      if (await this.finishCapture(session.entryId)) {
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
  /**
   * Live count of entries stuck on **this phone's credential** rather than on the network.
   *
   * A strict subset of {@link watchStuckCount}: the same "past `STALLED_AFTER_ATTEMPTS`" bar, plus
   * the one failure kind that a foreman can personally fix and that "try again" cannot. The
   * distinction matters because the two need opposite words — an unreachable server is something
   * to wait out, and a refused credential is something to act on, and the sync row's "not getting
   * through" tells him to wait in both cases.
   *
   * **Derived from the queue, never from a stored flag.** The server is the only thing that knows
   * a device is revoked; it reaches this phone as a 401 on next contact (plan §7). A local
   * "revoked" boolean would be a second source of truth that goes stale in a basement, and would
   * still be saying so after the admin had put it right.
   *
   * **A fallback since 2026-09-03.** By founder decision a refused phone signs itself out on the
   * first 401 (`core/session/device-refusal.service.ts`), so this count is no longer how a foreman
   * learns of a revocation — the sentence he reads is on `/welcome`. What is left for it is rows an
   * older build wrote, carried across an upgrade: {@link releaseBlockedByAuth} works on `blocked`
   * rows and leaves these `failed` ones alone, so they outlive a re-activation until the loop's
   * next attempt clears them. `features/pending/pending-page.ts` carries the full note. The query
   * is unchanged and still correct.
   */
  watchReactivationCount(): Observable<number> {
    return from(
      liveQuery(async () => {
        const items = await this.db.outbox.toArray();
        return items.filter(
          (item) =>
            item.state === 'failed' &&
            item.attempts >= STALLED_AFTER_ATTEMPTS &&
            item.failureKind === 'unauthenticated',
        ).length;
      }),
    );
  }

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
      (item) => isLive(item) && (item.nextAttemptAt === null || item.nextAttemptAt <= nowIso),
    );
  }

  /**
   * When the loop should next wake for an item that is waiting, or null if nothing is.
   *
   * Lets the loop sleep exactly as long as it has to instead of polling — and it reads
   * {@link isLive}, the *same* predicate {@link dueOutboxItems} reads, which is the point.
   *
   * This used to test `state === 'failed'` while the due filter accepted `queued` as well, and
   * that asymmetry is the same defect F1 exists to fix, wearing a different hat: a row the due
   * filter **defers** (its `nextAttemptAt` is in the future) but the scheduler **cannot see** is a
   * row nothing ever wakes for. The loop then sleeps for good with work still in the queue. It was
   * unreachable only because no caller happened to pass a `nextAttemptAt` alongside `queued` —
   * a coincidence of call sites, not a property of the code, and one refactor from being false.
   *
   * The invariant, pinned by a spec over every `OutboxState`: **anything the due filter can defer,
   * the wake scheduler must be able to see.**
   */
  async earliestNextAttempt(): Promise<string | null> {
    const items = await this.db.outbox.toArray();
    const waiting = items
      .filter((item) => isLive(item) && item.nextAttemptAt !== null)
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
   * Put back every row that is stuck only because of the credential this phone was using.
   *
   * Called when the credential *changes* — a phone is activated, a revoked device is re-activated
   * with a fresh code. That event is a statement that the reason those rows stopped no longer
   * holds, and the whole point is that it costs the foreman **no taps at all**: he types one code
   * and a morning's entries start moving again on their own.
   *
   * Scoped to {@link AUTH_FAILURE_KINDS}. A new token does not conjure up a missing project or an
   * https origin, and releasing those rows would put them back in the queue to fail identically —
   * the queue claiming to have learned something it did not.
   *
   * **Two callers, and only one of them is reliable.** `ActivationService` calls this explicitly
   * on every successful activation, and the credential-change effect in `UploadService.start()`
   * calls it when the token changes by any other route. The explicit call is the one that
   * matters: the effect is keyed on the token's string identity, so an idempotent re-activation
   * returning the *same* token moves nothing — and that is precisely the case where a foreman has
   * most reason to expect his morning to start moving. Treat the effect as belt-and-braces, never
   * as the mechanism.
   *
   * (This paragraph said the opposite until 2026-09-02: that the effect "never fires in the
   * shipped app" because `SessionService.token()` fell back to a compiled-in credential and
   * nothing ever called `adopt()`. Both halves stopped being true at F3 and D7/F9 respectively.)
   *
   * Reuses {@link retryNow} per row rather than writing state itself, so there is exactly one path
   * that clears a failure, and rows released here are indistinguishable from rows a foreman
   * released by hand. Moving them to `queued` changes `watchOutboxBacklog()`, which the sync
   * loop's existing subscription already turns into a `wake()` — so nothing has to be told to run.
   *
   * Returns how many rows were released, for the caller that wants to say so on screen.
   */
  async releaseBlockedByAuth(): Promise<number> {
    const blocked = await this.db.outbox.where('state').equals('blocked').toArray();
    const releasable = blocked.filter((item) => isAuthFailure(item.failureKind));
    for (const item of releasable) {
      await this.retryNow(item.entryId);
    }
    return releasable.length;
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
 * Whether the sync loop acts on a row in each outbox state.
 *
 * A `Record` over the whole union, not a boolean expression, and that is the entire guard: adding
 * a fifth `OutboxState` **fails to compile** here until someone states, deliberately, whether the
 * loop should pick it up. A `state === 'queued' || state === 'failed'` test would accept a new
 * state in silence and answer `false` about it — which is precisely how a row becomes invisible to
 * the loop, and precisely the defect F1 exists to fix.
 *
 * The excluded pair is deliberate and each for its own reason: `in_flight` has an attempt running
 * against it in this process (and `releaseInFlight()` covers the process that died holding one),
 * and `blocked` is terminal — re-offering it is the battery-burning behaviour the state exists to
 * prevent.
 */
const LOOP_ACTS_ON: Record<OutboxState, boolean> = {
  queued: true,
  in_flight: false,
  failed: true,
  blocked: false,
};

/**
 * The outbox rows the sync loop will act on.
 *
 * Read by {@link EntryStore.dueOutboxItems} and {@link EntryStore.earliestNextAttempt} both, so
 * the two can never again disagree about which rows exist as far as the loop is concerned.
 */
function isLive(item: OutboxItem): boolean {
  return LOOP_ACTS_ON[item.state];
}

/**
 * The failure kinds a *new credential* can actually fix.
 *
 * Everything here is a statement about the phone's standing with the server, not about the entry:
 * the token was refused, the caller was not allowed, or this build had no token at all. A fresh
 * credential is a real answer to each. `unauthenticated` is in the set because builds *before* F1
 * treated a 401 as terminal, so phones upgrading from one carry `blocked` rows stamped with it.
 *
 * Deliberately **not** here: `rejected` (a 404 project stays missing), `insecure_context` (a token
 * does not turn http into https) and every retryable kind (the loop owns those). Releasing them
 * would be the queue lying about what it learned.
 *
 * Typed `ReadonlySet<FailureKind>`, not `ReadonlySet<string>`: a typo, or a kind that no longer
 * exists, is a compile error rather than a member that silently never matches.
 */
const AUTH_FAILURE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'unauthenticated',
  'unauthorized',
  'not_configured',
]);

/**
 * Whether a stored `failureKind` is one a credential fixes.
 *
 * The stored value is `string | null` — the local data model deliberately does not depend on the
 * API layer's union — so the widening happens here, at one guarded crossing, rather than by
 * loosening the set's own type and giving up the compile-time check above.
 */
function isAuthFailure(kind: string | null): boolean {
  return kind !== null && (AUTH_FAILURE_KINDS as ReadonlySet<string>).has(kind);
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
