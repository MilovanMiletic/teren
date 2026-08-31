import { TestBed } from '@angular/core/testing';

import { TEST_PROJECT, captureEntry } from '../testing/capture-fixture';
import { entryUrlFor, routeUrlFor } from '../testing/route-table';
import { CaptureRecordingPage } from '../features/capture/capture-recording-page';
import { CaptureSavedPage } from '../features/capture/capture-saved-page';
import { ConfirmPage } from '../features/confirm/confirm-page';
import { PendingPage } from '../features/pending/pending-page';
import { AppStatus } from './app-status.service';
import { EntryStore } from './db/entry-store';
import { TEREN_DB, TerenDb } from './db/teren-db';
import { RescueService, openEntryIds } from './rescue.service';

describe('openEntryIds', () => {
  /**
   * The spec `rescue.service.ts` says exists — and until F4b did not.
   *
   * The URL is built from the **real** route table, looked up by the component the route renders
   * rather than by its path text, so renaming `entry/:entryId` in `app.routes.ts` without
   * touching the regex above turns this red instead of silently killing the exemption that stands
   * between a foreman adding photos and his draft being force-queued out from under him.
   * A hardcoded `/entry/...` on both sides is two copies agreeing with each other while both
   * disagree with the app, which is exactly the state main was in.
   */
  it('derives the saved screen from the route table, so a rename cannot pass unnoticed', async () => {
    const entryId = '72c32db1-1db8-499e-88b1-dd644af662f2';

    expect(openEntryIds(await entryUrlFor(CaptureSavedPage, entryId))).toEqual([entryId]);
  });

  it('ignores a query string or fragment on the way', async () => {
    expect(openEntryIds(`${await entryUrlFor(CaptureSavedPage, 'abc')}?x=1#y`)).toEqual(['abc']);
  });

  /**
   * Only the saved screen is exempt, and deliberately so: every other screen either holds no
   * draft (the confirm gate opens on an entry that is long past `draft`) or holds nothing at all.
   * Asserted against the table's own paths so a regex loose enough to swallow a sibling
   * `:entryId` route — `confirm/:entryId` is right next to it — is caught here.
   */
  it('exempts nothing on any other screen', async () => {
    expect(openEntryIds('/')).toEqual([]);
    expect(openEntryIds(await entryUrlFor(ConfirmPage, 'abc'))).toEqual([]);
    expect(openEntryIds(await routeUrlFor(PendingPage))).toEqual([]);
    expect(openEntryIds(await routeUrlFor(CaptureRecordingPage))).toEqual([]);
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
