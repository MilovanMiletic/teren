import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { TEST_PROJECT, captureEntry } from '../../testing/capture-fixture';
import { EntryNotOpenError, EntryStore, LIVE_CAPTURE_WINDOW_MS } from './entry-store';
import { LocalEntry, OUTBOX_STATES } from './models';
import { TEREN_DB, TerenDb } from './teren-db';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('EntryStore', () => {
  let db: TerenDb;
  let store: EntryStore;

  beforeEach(() => {
    // A throwaway database per spec: state must never leak between them.
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    TestBed.configureTestingModule({
      providers: [{ provide: TEREN_DB, useValue: db }],
    });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  function chunk(byte: number): Blob {
    return new Blob([new Uint8Array([byte, byte])], { type: 'audio/ogg;codecs=opus' });
  }

  /**
   * Back-date a capture's last chunk, so the sweep reads it as an orphan rather than a live take.
   *
   * Every spec that expects `rescue()` to *assemble* something has to do this, and that is the
   * point: a capture whose last chunk arrived a moment ago is a recording in progress, and
   * assembling one deletes the session out from under the microphone. A spec that skipped this
   * would be asserting the truncation.
   */
  async function abandon(entryId: string, agoMs = 60_000): Promise<void> {
    await db.captures.update(entryId, {
      lastChunkAt: new Date(Date.now() - agoMs).toISOString(),
    });
  }

  // ---- Recording straight to disk -------------------------------------------------------------

  describe('capture', () => {
    it('writes every chunk to disk as it arrives, before anything is stopped', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: '2026-08-29T14:05:00.000Z',
        mimeType: 'audio/ogg;codecs=opus',
      });

      await store.appendChunk(entryId, chunk(1));
      await store.appendChunk(entryId, chunk(2));

      // Mid-recording: nothing has been stopped, and two seconds of audio are already durable.
      expect(await db.chunks.where('entryId').equals(entryId).count()).toBe(2);
      expect((await db.captures.get(entryId))?.chunkCount).toBe(2);
      expect(await db.entries.count()).toBe(0);
    });

    /**
     * The link is written **before the first byte**, like the site — so it is part of what the day
     * *is* rather than something the entry acquired later. PROJECT.md invariant 2 makes a
     * correction a new entry that names the one it replaces; an entry that gained that link
     * afterwards would be a record whose meaning changed after it was recorded.
     */
    it('records at capture time which day a correction replaces', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: '2026-09-03T14:05:00.000Z',
        mimeType: 'audio/ogg;codecs=opus',
        supersedesEntryId: 'the-day-being-replaced',
      });

      // On the session, before anything is stopped.
      expect((await db.captures.get(entryId))?.supersedesEntryId).toBe('the-day-being-replaced');

      await store.appendChunk(entryId, chunk(1));
      const entry = await store.finishCapture(entryId, { durationMs: 41_000 });

      expect(entry?.supersedesEntryId).toBe('the-day-being-replaced');
    });

    /** An ordinary take carries `null`, and absence and `null` both mean "not a correction". */
    it('leaves an ordinary take with no correction link', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: '2026-09-03T14:05:00.000Z',
        mimeType: 'audio/ogg;codecs=opus',
      });
      await store.appendChunk(entryId, chunk(1));
      const entry = await store.finishCapture(entryId, { durationMs: 41_000 });

      expect(entry?.supersedesEntryId).toBeNull();
    });

    it('assembles the chunks in order into one blob, and clears the leftovers', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: '2026-08-29T14:05:00.000Z',
        mimeType: 'audio/ogg;codecs=opus',
      });
      await store.appendChunk(entryId, chunk(1));
      await store.appendChunk(entryId, chunk(2));
      await store.appendChunk(entryId, chunk(3));

      const entry = await store.finishCapture(entryId, { durationMs: 41_000 });

      expect(entry?.status).toBe('draft');
      const [audio] = await db.media.where({ entryId, kind: 'audio' }).toArray();
      expect(new Uint8Array(await audio.blob.arrayBuffer())).toEqual(
        new Uint8Array([1, 1, 2, 2, 3, 3]),
      );
      expect(audio.mimeType).toBe('audio/ogg;codecs=opus');
      expect(audio.durationMs).toBe(41_000);
      // The chunks and the blob are the same bytes; keeping both would double the storage.
      expect(await db.chunks.count()).toBe(0);
      expect(await db.captures.count()).toBe(0);
    });

    it('keys the entry by a device-generated UUID', async () => {
      const entry = await captureEntry(store);
      expect(entry.id).toMatch(UUID_PATTERN);
    });

    it('derives the duration from the last chunk when nobody pressed stop', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 12_000).toISOString(),
        mimeType: 'audio/webm;codecs=opus',
      });
      await store.appendChunk(entryId, chunk(1));

      const entry = await store.finishCapture(entryId);

      // ~12 s of wall clock between the start and the last chunk landing.
      expect(entry?.audioDurationMs).toBeGreaterThanOrEqual(11_000);
      expect(entry?.audioDurationMs).toBeLessThan(20_000);
    });

    it('creates no entry for a capture that recorded nothing', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/mp4',
      });

      expect(await store.finishCapture(entryId)).toBeNull();
      // No empty entry in the diary, and no session left for the sweep to trip over.
      expect(await db.entries.count()).toBe(0);
      expect(await db.captures.count()).toBe(0);
    });

    it('is idempotent: finishing twice yields the one entry, not two takes', async () => {
      const entry = await captureEntry(store);
      const again = await store.finishCapture(entry.id);

      expect(again?.id).toBe(entry.id);
      expect(await db.entries.count()).toBe(1);
      expect(await db.media.where({ entryId: entry.id, kind: 'audio' }).count()).toBe(1);
    });

    it('keeps the position fix attached to a capture in progress', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/ogg',
      });
      await store.appendChunk(entryId, chunk(1));
      await store.setCaptureGeo(entryId, {
        latitude: 44.77,
        longitude: 20.48,
        accuracyM: 12,
        fixedAt: '2026-08-29T14:05:01.000Z',
      });

      const entry = await store.finishCapture(entryId);
      expect(entry?.geo?.latitude).toBe(44.77);
    });

    it('throws away only a take the user explicitly cancelled', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/ogg',
      });
      await store.appendChunk(entryId, chunk(1));

      await store.discardCapture(entryId);

      expect(await db.chunks.count()).toBe(0);
      expect(await db.captures.count()).toBe(0);
      // And the sweep must not resurrect what the foreman refused.
      expect((await store.rescue()).assembled).toBe(0);
    });
  });

  // ---- Rescue ----------------------------------------------------------------------------------

  describe('rescue', () => {
    it('assembles a recording the phone was killed in the middle of', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 180_000).toISOString(),
        mimeType: 'audio/webm;codecs=opus',
      });
      // Three minutes of a site walk-through that a plain in-memory buffer would have lost.
      for (let index = 0; index < 180; index += 1) {
        await store.appendChunk(entryId, chunk(index % 251));
      }
      // Just outside the live window, so the derived duration is still the three minutes recorded.
      await abandon(entryId, LIVE_CAPTURE_WINDOW_MS + 1_000);

      const result = await store.rescue();

      expect(result.assembled).toBe(1);
      const entry = await db.entries.get(entryId);
      expect(entry?.status).toBe('draft');
      const [audio] = await db.media.where({ entryId, kind: 'audio' }).toArray();
      expect(audio.byteSize).toBe(360);
      expect(entry?.audioDurationMs).toBeGreaterThan(170_000);
    });

    /**
     * **A correction the tab died in the middle of comes back as a correction.**
     *
     * This is the whole reason the link lives on the *session* rather than being attached when the
     * take is saved: the start-up sweep assembles orphaned chunks into a draft without the screen
     * that started them, so a correction whose tab was killed mid-sentence would otherwise return
     * as an ordinary entry — the same day's work, filed as a new record rather than as the
     * replacement of a wrong one, and nothing on any screen would say so.
     */
    it('assembles an interrupted correction as a correction', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 60_000).toISOString(),
        mimeType: 'audio/webm;codecs=opus',
        supersedesEntryId: 'the-day-being-replaced',
      });
      await store.appendChunk(entryId, chunk(1));
      await store.appendChunk(entryId, chunk(2));
      await abandon(entryId, LIVE_CAPTURE_WINDOW_MS + 1_000);

      const result = await store.rescue();

      expect(result.assembled).toBe(1);
      expect((await db.entries.get(entryId))?.supersedesEntryId).toBe('the-day-being-replaced');
    });

    it('leaves the capture whose screen is open alone', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date().toISOString(),
        mimeType: 'audio/ogg',
      });
      await store.appendChunk(entryId, chunk(1));

      const result = await store.rescue({ except: [entryId] });

      expect(result.assembled).toBe(0);
      expect(await db.captures.count()).toBe(1);
    });

    it('queues drafts abandoned by an interrupted capture, but leaves a fresh one alone', async () => {
      const abandoned = await captureEntry(store);
      const fresh = await captureEntry(store);
      await db.entries.update(abandoned.id, { updatedAt: '2020-01-01T00:00:00.000Z' });

      const result = await store.rescue();

      expect(result.queued).toBe(1);
      expect((await db.entries.get(abandoned.id))?.status).toBe('queued');
      expect((await db.entries.get(fresh.id))?.status).toBe('draft');
    });

    it('never queues the entry the saved screen is showing, however stale it looks', async () => {
      const entry = await captureEntry(store);
      await db.entries.update(entry.id, { updatedAt: '2020-01-01T00:00:00.000Z' });

      await store.rescue({ except: [entry.id] });

      expect((await db.entries.get(entry.id))?.status).toBe('draft');
      expect(await db.outbox.count()).toBe(0);
    });

    it('does not queue a draft it has only just assembled — the user may be coming back', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 600_000).toISOString(),
        mimeType: 'audio/ogg',
      });
      await store.appendChunk(entryId, chunk(1));
      await abandon(entryId);

      const result = await store.rescue();

      expect(result.assembled).toBe(1);
      expect(result.queued).toBe(0);
      expect((await db.entries.get(entryId))?.status).toBe('draft');
    });

    it('keeps a draft out of the sweep while the saved screen keeps touching it', async () => {
      const entry = await captureEntry(store);
      await db.entries.update(entry.id, { updatedAt: '2020-01-01T00:00:00.000Z' });

      await store.touchDraft(entry.id);
      await store.rescue();

      expect((await db.entries.get(entry.id))?.status).toBe('draft');
    });

    /**
     * ## A capture that is still producing audio is not an orphan
     *
     * `finishCapture` assembles what is on disk and **deletes the session**, so every chunk that
     * arrives afterwards is dropped by `appendChunk`'s missing-session branch while the screen's
     * timer keeps climbing. Run against a live recording, `rescue()` is therefore not a rescue at
     * all — it is a silent truncation, which is what happened on every return to the foreground
     * until 2026-09-02.
     *
     * The guard is here as well as in the caller on purpose. `RescueService` names the live take
     * from the recorder and is the precise defence; this one holds for **whoever** calls `rescue()`
     * next, including a caller who has never heard of the exemption.
     */
    it('refuses to assemble a capture whose last chunk just arrived', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 6_000).toISOString(),
        mimeType: 'audio/ogg',
      });
      await store.appendChunk(entryId, chunk(1));

      // No `except` at all: the caller has forgotten, or does not know, that a take is running.
      const result = await store.rescue();

      expect(result.assembled).toBe(0);
      // The session survives, so the next chunk still has somewhere to land.
      expect(await db.captures.get(entryId)).toBeDefined();
      expect(await db.entries.get(entryId)).toBeUndefined();

      // …and a chunk that arrives after the sweep is still kept, which is the thing the truncation
      // destroyed: with the session gone this write is a no-op and the audio is lost.
      await store.appendChunk(entryId, chunk(2));
      expect((await db.captures.get(entryId))?.chunkCount).toBe(2);
    });

    it('assembles it as soon as it really has gone quiet', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 60_000).toISOString(),
        mimeType: 'audio/ogg',
      });
      await store.appendChunk(entryId, chunk(1));
      // Just outside the window: declining for a few seconds costs nothing, declining for ever
      // would strand the take.
      await abandon(entryId, LIVE_CAPTURE_WINDOW_MS + 1_000);

      expect((await store.rescue()).assembled).toBe(1);
    });

    /**
     * A capture with no `lastChunkAt` at all — the tab died between opening the session and the
     * first timeslice — must still be swept. `Date.parse` answers NaN, every comparison against it
     * is false, and the row falls through to be assembled (and then discarded, having no audio).
     * The safe direction: a capture nothing can date is exactly the orphan this sweep is for.
     */
    it('sweeps a capture it cannot date at all', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 60_000).toISOString(),
        mimeType: 'audio/ogg',
      });

      await store.rescue();

      expect(await db.captures.get(entryId)).toBeUndefined();
    });
  });

  // ---- When the recording really started -------------------------------------------------------

  describe('markCaptureStarted', () => {
    /**
     * The stamp `beginCapture` takes is when the microphone was *asked for*, and on a first-ever
     * recording that is a permission sheet a man with muddy hands has to find the "Allow" button
     * on. Twenty seconds of that used to become twenty seconds of phantom recording — in the
     * entry's `capturedAt`, therefore in `created_at`, therefore on the client's report, and at one
     * end of the duration `finishCapture` derives when nobody presses stop.
     */
    it('moves the capture to when audio actually began, and the entry follows', async () => {
      const entryId = crypto.randomUUID();
      const asked = new Date(Date.now() - 20_000).toISOString();
      const granted = new Date().toISOString();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: asked,
        mimeType: 'audio/ogg',
      });

      await store.markCaptureStarted(entryId, granted);
      await store.appendChunk(entryId, chunk(1));
      await abandon(entryId);
      await store.rescue();

      expect((await db.entries.get(entryId))?.capturedAt).toBe(granted);
      // The derived duration is the one that would have been twenty seconds too long.
      expect((await db.entries.get(entryId))?.audioDurationMs).toBeLessThan(20_000);
    });

    it('touches nothing but the timestamp', async () => {
      const entryId = crypto.randomUUID();
      await store.beginCapture({
        entryId,
        project: TEST_PROJECT,
        capturedAt: new Date(Date.now() - 20_000).toISOString(),
        mimeType: 'audio/ogg',
      });
      await store.appendChunk(entryId, chunk(1));
      const before = await db.captures.get(entryId);

      await store.markCaptureStarted(entryId, new Date().toISOString());

      const after = await db.captures.get(entryId);
      expect(after?.chunkCount).toBe(before?.chunkCount);
      expect(after?.lastChunkAt).toBe(before?.lastChunkAt);
      expect(after?.mimeType).toBe(before?.mimeType);
      expect(await db.chunks.where('entryId').equals(entryId).count()).toBe(1);
    });
  });

  // ---- Photos ---------------------------------------------------------------------------------

  describe('addPhoto', () => {
    const photo = {
      blob: new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' }),
      mimeType: 'image/jpeg',
      width: 1600,
      height: 1200,
      capturedAt: '2026-08-29T14:06:00.000Z',
      originalByteSize: 4_000_000,
      originalMimeType: 'image/heic',
      geo: null,
    };

    it('attaches photos and keeps the entry photo count in step', async () => {
      const entry = await captureEntry(store);

      await store.addPhoto(entry.id, photo);

      expect((await db.entries.get(entry.id))?.photoCount).toBe(1);
      const photos = await db.media.where({ entryId: entry.id, kind: 'photo' }).toArray();
      expect(photos).toHaveLength(1);
      expect(photos[0].originalMimeType).toBe('image/heic');
    });

    it('writes no orphan media row for an entry that does not exist', async () => {
      await expect(store.addPhoto('no-such-entry', photo)).rejects.toBeInstanceOf(
        EntryNotOpenError,
      );
      expect(await db.media.count()).toBe(0);
    });

    it('refuses an entry already handed to the outbox, and changes nothing', async () => {
      const entry = await captureEntry(store);
      await store.queue(entry.id);

      await expect(store.addPhoto(entry.id, photo)).rejects.toBeInstanceOf(EntryNotOpenError);
      expect(await db.media.where({ entryId: entry.id, kind: 'photo' }).count()).toBe(0);
      expect((await db.entries.get(entry.id))?.photoCount).toBe(0);
    });
  });

  // ---- Queue ------------------------------------------------------------------------------------

  describe('queue', () => {
    it('does not queue a recording on save — photos may still be coming', async () => {
      const entry = await captureEntry(store);
      expect(await db.outbox.get(entry.id)).toBeUndefined();
    });

    it('moves draft to queued and creates exactly one outbox row', async () => {
      const entry = await captureEntry(store);

      await store.queue(entry.id);

      expect((await db.entries.get(entry.id))?.status).toBe('queued');
      const item = await db.outbox.get(entry.id);
      expect(item?.state).toBe('queued');
      expect(item?.attempts).toBe(0);
      expect(await db.outbox.count()).toBe(1);
    });

    it('is idempotent when queueing twice, and never resets an in-flight attempt', async () => {
      const entry = await captureEntry(store);
      await store.queue(entry.id);
      await store.setOutboxState(entry.id, 'in_flight');

      await store.queue(entry.id);

      expect(await db.outbox.count()).toBe(1);
      expect((await db.outbox.get(entry.id))?.attempts).toBe(1);
      expect((await db.entries.get(entry.id))?.status).toBe('uploading');
    });

    it('numbers outbox items so the sync loop can take the oldest first', async () => {
      const first = await captureEntry(store);
      const second = await captureEntry(store);
      await store.queue(first.id);
      await store.queue(second.id);

      const items = await db.outbox.orderBy('seq').toArray();
      expect(items.map((item) => item.entryId)).toEqual([first.id, second.id]);
    });

    it('deletes nothing: queueing and failing keep every entry and every blob', async () => {
      const entry = await captureEntry(store);
      await store.queue(entry.id);
      await store.setOutboxState(entry.id, 'failed', { lastError: 'network' });

      expect(await db.entries.count()).toBe(1);
      expect(await db.media.count()).toBe(1);
      expect((await db.entries.get(entry.id))?.status).toBe('failed');
      expect((await db.outbox.get(entry.id))?.lastError).toBe('network');
    });
  });

  // ---- Queries ----------------------------------------------------------------------------------

  describe('queries', () => {
    it('hands the archive the recording as well as the photographs', async () => {
      // `watchPhotos` deliberately excludes the audio; the entry record needs it, because playing
      // back what was actually said is half of what makes a record evidence.
      const entry = await captureEntry(store, { photoCount: 2 });

      const media = await firstValueFrom(store.watchMedia(entry.id));

      expect(media.filter((item) => item.kind === 'audio')).toHaveLength(1);
      expect(media.filter((item) => item.kind === 'photo')).toHaveLength(2);
    });

    it('counts an un-queued draft as pending — home must never claim "all sent" over one', async () => {
      const entry = await captureEntry(store);

      const pending = await firstValueFrom(store.watchPending());
      expect(pending).toHaveLength(1);
      expect(pending[0].entry.id).toBe(entry.id);
      expect(pending[0].outbox).toBeNull();
      expect(await firstValueFrom(store.watchPendingCount())).toBe(1);
    });

    it('lists queued items before drafts, and counts each entry once', async () => {
      const queued = await captureEntry(store);
      await store.queue(queued.id);
      const draft = await captureEntry(store);

      const pending = await firstValueFrom(store.watchPending());
      expect(pending.map((item) => item.entry.id)).toEqual([queued.id, draft.id]);
      expect(pending[0].outbox?.state).toBe('queued');
    });

    it('reports the pending queue from the store, so a reload cannot lose it', async () => {
      const entry = await captureEntry(store);
      await store.queue(entry.id);

      // A second connection over the same database stands in for a reload.
      const reloaded = new TerenDb(db.name);
      try {
        expect(await reloaded.outbox.count()).toBe(1);
        expect((await reloaded.entries.get(entry.id))?.status).toBe('queued');
      } finally {
        reloaded.close();
      }
    });

    it('lists an entry for the day it was captured', async () => {
      const entry = await captureEntry(store, { capturedAt: '2026-08-29T14:05:00.000Z' });
      const stored = (await db.entries.get(entry.id)) as LocalEntry;

      const today = await firstValueFrom(
        store.watchEntriesForDay(TEST_PROJECT.id, stored.localDay),
      );
      expect(today.map((item) => item.id)).toEqual([entry.id]);

      const other = await firstValueFrom(store.watchEntriesForDay(TEST_PROJECT.id, '1999-01-01'));
      expect(other).toEqual([]);
    });

    it('lists recent entries newest first, scoped to the project', async () => {
      const older = await captureEntry(store, { capturedAt: '2026-08-27T09:00:00.000Z' });
      const newer = await captureEntry(store, { capturedAt: '2026-08-29T14:05:00.000Z' });
      await captureEntry(store, {
        capturedAt: '2026-08-28T09:00:00.000Z',
        project: { ...TEST_PROJECT, id: 'project-2' },
      });

      const recent = await firstValueFrom(store.watchRecentEntries(TEST_PROJECT.id));
      expect(recent.map((item) => item.id)).toEqual([newer.id, older.id]);
    });
  });

  // ---- The outbox seam the sync loop writes through (B3) -------------------------------------

  describe('outbox', () => {
    async function queued(): Promise<string> {
      const entry = await captureEntry(store, { photoCount: 1 });
      await store.queue(entry.id);
      return entry.id;
    }

    it('keeps entry status and outbox state in step through every transition', async () => {
      const entryId = await queued();

      await store.setOutboxState(entryId, 'in_flight');
      expect((await store.getEntry(entryId))?.status).toBe('uploading');

      await store.setOutboxState(entryId, 'failed', {
        failureKind: 'offline',
        nextAttemptAt: '2099-01-01T00:00:00.000Z',
      });
      expect((await store.getEntry(entryId))?.status).toBe('failed');

      await store.setOutboxState(entryId, 'blocked', { failureKind: 'rejected' });
      expect((await store.getEntry(entryId))?.status).toBe('blocked');
    });

    it('gives a blocked item no next attempt — that is what makes it terminal', async () => {
      const entryId = await queued();
      await store.setOutboxState(entryId, 'failed', {
        failureKind: 'offline',
        nextAttemptAt: '2099-01-01T00:00:00.000Z',
      });

      await store.setOutboxState(entryId, 'blocked', { failureKind: 'unauthorized' });

      expect(await store.getOutboxItem(entryId)).toMatchObject({
        nextAttemptAt: null,
        failureKind: 'unauthorized',
      });
    });

    it('offers the loop only what is due, and never a blocked item', async () => {
      const due = await queued();
      const backingOff = await queued();
      const terminal = await queued();

      await store.setOutboxState(backingOff, 'failed', {
        failureKind: 'server',
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await store.setOutboxState(terminal, 'blocked', { failureKind: 'rejected' });

      // Re-offering a terminal item is exactly the battery-burning loop the state exists to stop.
      expect((await store.dueOutboxItems()).map((item) => item.entryId)).toEqual([due]);
      expect(await store.earliestNextAttempt()).not.toBeNull();
    });

    /**
     * The invariant that stops F1's bug class returning through a different door.
     *
     * `dueOutboxItems` and `earliestNextAttempt` are two readers of one question — which rows the
     * loop acts on — and they used to answer it differently: the due filter accepted `queued` and
     * `failed`, the wake scheduler only `failed`. A row the due filter **defers** (its
     * `nextAttemptAt` is in the future) that the scheduler **cannot see** is a row nothing ever
     * wakes for, and the loop sleeps for good with work still in the queue. That is the same
     * defect as a `blocked` row scheduling no timer, wearing a different hat.
     *
     * Two things make this a guard rather than a restatement of the code:
     *
     * 1. **The state list is derived, not written down.** `OUTBOX_STATES` comes from a
     *    `Record<OutboxState, true>`, so a fifth state joins this loop automatically. A
     *    hand-written array was the first version of this spec and it was worthless: the reviewer
     *    added a fifth state, mapped it to a status the loop plainly must act on, and all 472
     *    specs stayed green.
     * 2. **The expectation is measured, not asserted.** Nothing here names which states are live.
     *    It asks the due filter what it would do with the row when the row is due, then insists
     *    the scheduler agrees when the very same row is deferred. Divergence is the failure,
     *    whatever the states happen to be — so this cannot drift into echoing `isLive`'s body.
     */
    it('never defers a row the wake scheduler cannot see, in any outbox state', async () => {
      for (const state of OUTBOX_STATES) {
        const entryId = await queued();

        // Written straight to the table: `setOutboxState` deliberately nulls `nextAttemptAt` for
        // `blocked`, and the point is to test the *readers* against every shape a row can
        // physically take on disk — including shapes only a future writer would produce.

        // (a) Due right now — does the loop act on a row in this state at all?
        await db.outbox.update(entryId, { state, nextAttemptAt: null });
        const loopActsOnIt = (await store.dueOutboxItems()).some((i) => i.entryId === entryId);

        // (b) The identical row, deferred. It must now be absent from the due list…
        await db.outbox.update(entryId, {
          state,
          nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        });
        expect((await store.dueOutboxItems()).some((i) => i.entryId === entryId)).toBe(false);

        // …and something must be scheduled to come back for it — if, and only if, (a) said the
        // loop acts on this state. Anything the due filter can defer, the scheduler must see.
        expect((await store.earliestNextAttempt()) !== null).toBe(loopActsOnIt);

        await db.outbox.delete(entryId);
      }
    });

    it('strands nothing in flight: a killed upload comes back to the queue', async () => {
      // `in_flight` lives on disk; the attempt it describes lives in a JavaScript task the web
      // platform ends without warning. Every reader of the outbox skips `in_flight`, so a row
      // left there is invisible to the loop, to the backlog, to the stuck count and to the retry
      // button — while the entry goes on claiming to be uploading.
      const stranded = await queued();
      const untouched = await queued();
      await store.setOutboxState(stranded, 'in_flight');

      expect(await store.releaseInFlight()).toBe(1);

      expect(await store.getOutboxItem(stranded)).toMatchObject({
        state: 'queued',
        attempts: 1,
      });
      // Released through the single writer, so the entry's own status came back with it. A row
      // that read `queued` under an entry still reading `uploading` would swap one lie for
      // another.
      expect((await store.getEntry(stranded))?.status).toBe('queued');
      expect((await store.dueOutboxItems()).map((item) => item.entryId)).toEqual([
        stranded,
        untouched,
      ]);
    });

    it('releases nothing when nothing was in flight', async () => {
      await queued();

      expect(await store.releaseInFlight()).toBe(0);
    });

    describe('releaseBlockedByAuth', () => {
      /** A row the loop gave up on, stamped with the kind that made it give up. */
      async function blockedWith(kind: string): Promise<string> {
        const entryId = await queued();
        await store.setOutboxState(entryId, 'in_flight');
        await store.setOutboxState(entryId, 'blocked', { failureKind: kind, lastError: 'no' });
        return entryId;
      }

      it('releases every row a new credential could actually fix, with no per-entry tap', async () => {
        // The morning this exists for: a revoked device, three entries, and a foreman who fixes
        // all of them by typing one code. `unauthenticated` is in the set because builds *before*
        // F1 wrote 401s as terminal, so phones in the field carry rows stamped with it.
        const revoked = await blockedWith('unauthenticated');
        const forbidden = await blockedWith('unauthorized');
        const unconfigured = await blockedWith('not_configured');

        expect(await store.releaseBlockedByAuth()).toBe(3);

        for (const entryId of [revoked, forbidden, unconfigured]) {
          expect(await store.getOutboxItem(entryId)).toMatchObject({
            state: 'queued',
            attempts: 0,
            failureKind: null,
            nextAttemptAt: null,
          });
          expect((await store.getEntry(entryId))?.status).toBe('queued');
        }
      });

      it('leaves alone every row a new credential does not fix', async () => {
        // A fresh token does not conjure up a missing project, and it does not turn http into
        // https. Releasing these would put them straight back in the queue to fail identically —
        // the queue claiming to have learned something it did not.
        const missingProject = await blockedWith('rejected');
        const plainHttp = await blockedWith('insecure_context');

        expect(await store.releaseBlockedByAuth()).toBe(0);

        for (const entryId of [missingProject, plainHttp]) {
          expect((await store.getOutboxItem(entryId))?.state).toBe('blocked');
        }
      });

      it('releases nothing when nothing is blocked', async () => {
        await queued();
        expect(await store.releaseBlockedByAuth()).toBe(0);
      });
    });

    it('takes the oldest item first, by sequence rather than by timestamp', async () => {
      // Two entries queued inside the same second would tie on a plain timestamp.
      const first = await queued();
      const second = await queued();

      expect((await store.dueOutboxItems()).map((item) => item.entryId)).toEqual([first, second]);
    });

    it('removes only the work ticket when the server confirms — never the evidence', async () => {
      const entryId = await queued();

      await store.markConfirmedByServer(entryId, {
        serverStatus: 'processing',
        confirmedAt: '2026-08-29T10:05:00.000Z',
      });

      // PROJECT.md principle 3: pruning local media is C1's job, and only after a grace period.
      const media = await store.listMediaForUpload(entryId);
      expect(media).toHaveLength(2);
      expect(media.every((file) => file.blob.size > 0)).toBe(true);

      expect(await store.getEntry(entryId)).toMatchObject({
        status: 'confirmed_by_server',
        serverStatus: 'processing',
        confirmedByServerAt: '2026-08-29T10:05:00.000Z',
      });
      // The ticket goes, which is what takes the entry off the pending screen.
      expect(await store.getOutboxItem(entryId)).toBeUndefined();
      expect(await firstValueFrom(store.watchPending())).toEqual([]);
    });

    it('drops an outbox row whose entry is gone, and refuses to touch one whose entry is not', async () => {
      const entryId = await queued();
      const orphan = crypto.randomUUID();
      await db.outbox.put({
        entryId: orphan,
        state: 'queued',
        seq: 99,
        attempts: 0,
        lastAttemptAt: null,
        nextAttemptAt: null,
        lastError: null,
        failureKind: null,
        createdAt: new Date().toISOString(),
      });

      await store.discardOrphanOutboxItem(orphan);
      await store.discardOrphanOutboxItem(entryId);

      expect(await store.getOutboxItem(orphan)).toBeUndefined();
      expect(await store.getOutboxItem(entryId)).toBeDefined();
    });

    it('lists media for upload with the audio first, then the photos in capture order', async () => {
      // ARCHITECTURE §8: the report is built from the recording, so the audio goes up first and
      // the pipeline can start while photos are still climbing over a bad connection.
      const entry = await captureEntry(store, { photoCount: 3 });

      const media = await store.listMediaForUpload(entry.id);
      expect(media.map((file) => file.kind)).toEqual(['audio', 'photo', 'photo', 'photo']);

      const photos = media.slice(1);
      expect(photos.map((file) => file.createdAt)).toEqual(
        [...photos].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((f) => f.createdAt),
      );
    });
  });
});
