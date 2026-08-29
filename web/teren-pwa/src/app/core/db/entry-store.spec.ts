import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { TEST_PROJECT, captureEntry } from '../../testing/capture-fixture';
import { EntryNotOpenError, EntryStore } from './entry-store';
import { LocalEntry } from './models';
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

      const result = await store.rescue();

      expect(result.assembled).toBe(1);
      const entry = await db.entries.get(entryId);
      expect(entry?.status).toBe('draft');
      const [audio] = await db.media.where({ entryId, kind: 'audio' }).toArray();
      expect(audio.byteSize).toBe(360);
      expect(entry?.audioDurationMs).toBeGreaterThan(170_000);
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
});
