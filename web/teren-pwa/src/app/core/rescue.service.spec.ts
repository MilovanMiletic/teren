import { TestBed } from '@angular/core/testing';

import { TEST_PROJECT, captureEntry } from '../testing/capture-fixture';
import { AppStatus } from './app-status.service';
import { EntryStore } from './db/entry-store';
import { TEREN_DB, TerenDb } from './db/teren-db';
import { RescueService, openEntryIds } from './rescue.service';

describe('openEntryIds', () => {
  it('exempts the entry the saved screen is showing', () => {
    expect(openEntryIds('/entry/72c32db1-1db8-499e-88b1-dd644af662f2')).toEqual([
      '72c32db1-1db8-499e-88b1-dd644af662f2',
    ]);
  });

  it('ignores a query string or fragment on the way', () => {
    expect(openEntryIds('/entry/abc?x=1#y')).toEqual(['abc']);
  });

  it('exempts nothing on any other screen', () => {
    expect(openEntryIds('/')).toEqual([]);
    expect(openEntryIds('/pending')).toEqual([]);
    expect(openEntryIds('/record')).toEqual([]);
  });
});

describe('RescueService', () => {
  let db: TerenDb;
  let store: EntryStore;

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    TestBed.configureTestingModule({ providers: [{ provide: TEREN_DB, useValue: db }] });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('assembles an interrupted recording when the app comes back', async () => {
    const entryId = crypto.randomUUID();
    await store.beginCapture({
      entryId,
      project: TEST_PROJECT,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      mimeType: 'audio/ogg;codecs=opus',
    });
    await store.appendChunk(entryId, new Blob([new Uint8Array([5, 5])]));

    await TestBed.inject(RescueService).run();

    expect((await db.entries.get(entryId))?.status).toBe('draft');
  });

  it('queues a draft nobody came back to', async () => {
    const entry = await captureEntry(store);
    await db.entries.update(entry.id, { updatedAt: '2020-01-01T00:00:00.000Z' });

    await TestBed.inject(RescueService).run();

    expect((await db.entries.get(entry.id))?.status).toBe('queued');
  });

  it('degrades to "nothing rescued" when the store is unusable, and never rejects', async () => {
    // A closed connection stands in for a store that will not open at all.
    db.close();
    const status = TestBed.inject(AppStatus);

    await expect(TestBed.inject(RescueService).run()).resolves.toBeUndefined();
    expect(status.storageAvailable()).toBe(false);
  });
});
