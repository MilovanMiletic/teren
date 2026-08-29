import Dexie from 'dexie';

import { CaptureSession, LocalEntry } from './models';
import { TerenDb } from './teren-db';

/**
 * The demo project ids the PWA carried during B2. They never existed on the server, so an entry
 * captured under one is rejected by `POST /api/entries` with a `404` for as long as it is left
 * that way (see `legacy-project-ids.ts`).
 */
const PHANTOM_FIRST = '6f7a1c1e-3a4b-4f2e-9c1d-000000000001';
const PHANTOM_THIRD = '6f7a1c1e-3a4b-4f2e-9c1d-000000000003';

/** What the seeder really creates. */
const CANONICAL_FIRST = 'd3a0c1f0-5b8e-4f1a-9c62-000000000002';
const CANONICAL_THIRD = 'd3a0c1f0-5b8e-4f1a-9c62-000000000004';

/**
 * A database at exactly the v2 schema — what a phone that captured anything during B2 is holding
 * right now. The upgrade is then performed by the real `TerenDb`, not by a copy of it, so this
 * proves the migration that ships rather than a restatement of it.
 */
function openLegacyDb(name: string): Dexie {
  const db = new Dexie(name);
  db.version(1).stores({
    entries: 'id, projectId, capturedAt, status, localDay, [projectId+capturedAt]',
    media: 'id, entryId, kind, [entryId+kind], uploadState',
    outbox: 'entryId, state, seq, nextAttemptAt',
  });
  db.version(2).stores({
    chunks: '[entryId+seq], entryId',
    captures: 'entryId, updatedAt',
  });
  return db;
}

function legacyEntry(id: string, projectId: string, projectName: string): LocalEntry {
  return {
    id,
    projectId,
    projectName,
    capturedAt: '2026-08-20T07:15:00.000Z',
    localDay: '2026-08-20',
    status: 'queued',
    serverStatus: null,
    geo: null,
    audioDurationMs: 41_000,
    photoCount: 2,
    confirmedByServerAt: null,
    createdAt: '2026-08-20T07:15:41.000Z',
    updatedAt: '2026-08-20T07:15:41.000Z',
  };
}

function legacyCapture(entryId: string, projectId: string, projectName: string): CaptureSession {
  return {
    entryId,
    projectId,
    projectName,
    capturedAt: '2026-08-20T07:20:00.000Z',
    mimeType: 'audio/ogg;codecs=opus',
    geo: null,
    chunkCount: 3,
    lastChunkAt: '2026-08-20T07:20:03.000Z',
    updatedAt: '2026-08-20T07:20:03.000Z',
  };
}

describe('TerenDb v3 — correcting the demo project ids', () => {
  let name: string;

  beforeEach(() => {
    name = `teren-test-${crypto.randomUUID()}`;
  });

  afterEach(async () => {
    await Dexie.delete(name);
  });

  it('moves entries and capture sessions off the ids the server never had', async () => {
    const legacy = openLegacyDb(name);
    await legacy
      .table('entries')
      .bulkPut([
        legacyEntry('entry-1', PHANTOM_FIRST, 'Stambena zgrada Vojvode Stepe 212'),
        legacyEntry('entry-2', PHANTOM_THIRD, 'Kuća Miloša Obrenovića 17'),
      ]);
    await legacy.table('captures').put(legacyCapture('entry-3', PHANTOM_THIRD, 'Kuća Miloša'));
    await legacy.table('outbox').put({
      entryId: 'entry-1',
      state: 'queued',
      seq: 1,
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      lastError: null,
      createdAt: '2026-08-20T07:15:41.000Z',
    });
    legacy.close();

    const db = new TerenDb(name);
    await db.open();

    expect(db.verno).toBe(5);

    const first = await db.entries.get('entry-1');
    expect(first?.projectId).toBe(CANONICAL_FIRST);
    expect(first?.projectName).toBe('Stambena zgrada Vojvode Stepe 212');

    const second = await db.entries.get('entry-2');
    expect(second?.projectId).toBe(CANONICAL_THIRD);
    // The denormalised name moves with the id, so it never names a project the row left behind.
    expect(second?.projectName).toBe('Kuća Miloša Obrenovića 17');

    // A recording that was still in progress when the app was last closed is remapped too — the
    // start-up sweep turns it into an entry, and it would inherit a phantom id otherwise.
    const capture = await db.captures.get('entry-3');
    expect(capture?.projectId).toBe(CANONICAL_THIRD);
    expect(capture?.projectName).toBe('Kuća Miloša Obrenovića 17');

    // Nothing else about the evidence was touched.
    expect(first?.capturedAt).toBe('2026-08-20T07:15:00.000Z');
    expect(first?.status).toBe('queued');
    expect(first?.audioDurationMs).toBe(41_000);
    expect(first?.photoCount).toBe(2);
    expect(await db.outbox.get('entry-1')).toMatchObject({ state: 'queued', seq: 1 });

    // The compound index the home screen's recent list rides on was rebuilt around the new id.
    const recent = await db.entries
      .where('[projectId+capturedAt]')
      .between([CANONICAL_FIRST, Dexie.minKey], [CANONICAL_FIRST, Dexie.maxKey])
      .toArray();
    expect(recent.map((entry) => entry.id)).toEqual(['entry-1']);
    expect(await db.entries.where('projectId').equals(PHANTOM_FIRST).count()).toBe(0);

    db.close();
  });

  it('opens a database that has no local data at all', async () => {
    const db = new TerenDb(name);
    await db.open();

    expect(db.verno).toBe(5);
    expect(await db.entries.count()).toBe(0);
    expect(await db.captures.count()).toBe(0);

    db.close();
  });

  it('leaves rows that are already on the seeded ids exactly as they are', async () => {
    const legacy = openLegacyDb(name);
    await legacy
      .table('entries')
      .put(legacyEntry('entry-1', CANONICAL_FIRST, 'Stambena zgrada Vojvode Stepe 212'));
    legacy.close();

    const db = new TerenDb(name);
    await db.open();

    expect(await db.entries.get('entry-1')).toEqual(
      legacyEntry('entry-1', CANONICAL_FIRST, 'Stambena zgrada Vojvode Stepe 212'),
    );

    db.close();
  });

  it('changes nothing further when the database is opened again', async () => {
    const legacy = openLegacyDb(name);
    await legacy
      .table('entries')
      .put(legacyEntry('entry-1', PHANTOM_FIRST, 'Stambena zgrada Vojvode Stepe 212'));
    legacy.close();

    const first = new TerenDb(name);
    await first.open();
    const migrated = await first.entries.get('entry-1');
    first.close();

    // Re-opening an already-migrated database must be a plain open: same row, same id, and no
    // second pass that could walk the mapping any further along.
    const second = new TerenDb(name);
    await second.open();
    expect(await second.entries.get('entry-1')).toEqual(migrated);
    expect(migrated?.projectId).toBe(CANONICAL_FIRST);
    expect(await second.entries.count()).toBe(1);
    second.close();
  });
});
