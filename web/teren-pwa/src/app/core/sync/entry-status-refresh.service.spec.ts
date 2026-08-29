import { TestBed } from '@angular/core/testing';

import { TEST_PROJECT, captureEntry } from '../../testing/capture-fixture';
import { EntryListItemResponse } from '../api/api-types';
import { ArchiveService, RemoteList } from '../archive/archive.service';
import { EntryStore } from '../db/entry-store';
import { TEREN_DB, TerenDb } from '../db/teren-db';
import { EntryStatusRefresher } from './entry-status-refresh.service';

/**
 * The fix for the defect that made the confirmation gate invisible.
 *
 * `LocalEntry.serverStatus` was written once, at upload time, from a `/complete` response that
 * always says `received` — and never again. Home reads that field, so it went on rendering
 * "Primljen" over entries the pipeline had long since parked in `needs_review`, waiting for the
 * foreman. "Primljen" reads as *done, nothing to do*, so he never opened them, never confirmed
 * them, and the day's evidence never became a report.
 */
class FakeArchive {
  items: EntryListItemResponse[] = [];
  status: RemoteList['status'] = 'ok';
  calls: { projectId: string; limit: number }[] = [];

  /** While true every call parks unanswered, so a spec can stage two overlapping refreshes. */
  defer = false;
  private readonly parked: ((list: RemoteList) => void)[] = [];

  async listEntries(projectId: string, limit = 200): Promise<RemoteList> {
    this.calls.push({ projectId, limit });
    if (this.defer) {
      return new Promise<RemoteList>((resolve) => {
        this.parked.push(resolve);
      });
    }
    return { status: this.status, items: this.status === 'ok' ? this.items : [] };
  }

  /** Answer the n-th parked call — in whichever order the spec wants them coming back. */
  answer(index: number, items: EntryListItemResponse[]): void {
    this.parked[index]({ status: 'ok', items });
  }
}

function listItem(id: string, status: string): EntryListItemResponse {
  return {
    id,
    project_id: TEST_PROJECT.id,
    entry_date: '2026-08-29',
    status,
    created_at: '2026-08-29T10:00:00.000Z',
    received_at: '2026-08-29T10:05:00.000Z',
    reported_at: null,
    photo_count: 0,
    has_audio: true,
  };
}

describe('EntryStatusRefresher', () => {
  let db: TerenDb;
  let store: EntryStore;
  let archive: FakeArchive;
  let refresher: EntryStatusRefresher;

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    archive = new FakeArchive();
    TestBed.configureTestingModule({
      providers: [
        { provide: TEREN_DB, useValue: db },
        { provide: ArchiveService, useValue: archive as unknown as ArchiveService },
      ],
    });
    store = TestBed.inject(EntryStore);
    refresher = TestBed.inject(EntryStatusRefresher);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  /** An entry as the upload path leaves it: received by the server, and never re-read since. */
  async function givenUploadedEntry(): Promise<string> {
    const entry = await captureEntry(store);
    await store.markConfirmedByServer(entry.id, { serverStatus: 'received' });
    return entry.id;
  }

  it('replaces the status the upload path left behind with the one the server holds now', async () => {
    const id = await givenUploadedEntry();
    expect((await store.getEntry(id))?.serverStatus).toBe('received');

    archive.items = [listItem(id, 'needs_review')];
    const result = await refresher.refresh(TEST_PROJECT.id);

    expect(result.changed).toBe(1);
    expect((await store.getEntry(id))?.serverStatus).toBe('needs_review');
  });

  it('carries every state the pipeline can be in, not just the interesting one', async () => {
    const id = await givenUploadedEntry();

    for (const status of ['processing', 'awaiting_confirmation', 'confirmed', 'reported']) {
      archive.items = [listItem(id, status)];
      await refresher.refresh(TEST_PROJECT.id);
      expect((await store.getEntry(id))?.serverStatus).toBe(status);
    }
  });

  it('writes nothing when the server repeats itself', async () => {
    const id = await givenUploadedEntry();
    archive.items = [listItem(id, 'needs_review')];
    await refresher.refresh(TEST_PROJECT.id);

    const second = await refresher.refresh(TEST_PROJECT.id);

    expect(second.changed).toBe(0);
  });

  it('leaves every local row alone when the server could not be asked', async () => {
    // A refresh reports; it never erases. Blanking a status because the wifi blipped would make
    // the screen forget something it correctly knew.
    const id = await givenUploadedEntry();
    archive.items = [listItem(id, 'needs_review')];
    await refresher.refresh(TEST_PROJECT.id);

    archive.status = 'offline';
    const result = await refresher.refresh(TEST_PROJECT.id);

    expect(result.status).toBe('offline');
    expect(result.changed).toBe(0);
    expect((await store.getEntry(id))?.serverStatus).toBe('needs_review');
  });

  it('ignores server rows this phone does not hold', async () => {
    // The list also carries days recorded on another phone. They belong in the archive, not in
    // this table.
    await givenUploadedEntry();
    archive.items = [listItem('an-entry-from-another-phone', 'confirmed')];

    const result = await refresher.refresh(TEST_PROJECT.id);

    expect(result.changed).toBe(0);
    expect(await db.entries.get('an-entry-from-another-phone')).toBeUndefined();
  });

  it('touches nothing but the server status', async () => {
    const id = await givenUploadedEntry();
    const before = await store.getEntry(id);
    archive.items = [listItem(id, 'awaiting_confirmation')];

    await refresher.refresh(TEST_PROJECT.id);

    const after = await store.getEntry(id);
    expect(after?.status).toBe(before?.status);
    expect(after?.capturedAt).toBe(before?.capturedAt);
    expect(after?.confirmedByServerAt).toBe(before?.confirmedByServerAt);
    expect(after?.audioDurationMs).toBe(before?.audioDurationMs);
  });

  it('drops an answer that arrives after a newer one, instead of writing it over the top', async () => {
    // Home fires refreshes from three places — a 20 s timer, `visibilitychange`, and connectivity
    // returning — and coming back to the app trips two of them at once. On a site connection the
    // earlier request can easily answer last, and its older statuses would land on top of the
    // newer ones: Home back to "Primljen" over an entry already parked in `needs_review`, which
    // is precisely the defect this service exists to fix.
    const id = await givenUploadedEntry();
    archive.defer = true;

    const slow = refresher.refresh(TEST_PROJECT.id);
    const fast = refresher.refresh(TEST_PROJECT.id);

    // The newer request answers first, with what the server holds now.
    archive.answer(1, [listItem(id, 'needs_review')]);
    expect((await fast).changed).toBe(1);
    expect((await store.getEntry(id))?.serverStatus).toBe('needs_review');

    // The older one finally answers, carrying what the server said a moment earlier.
    archive.answer(0, [listItem(id, 'received')]);
    const late = await slow;

    expect(late.stale).toBe(true);
    expect(late.changed).toBe(0);
    expect((await store.getEntry(id))?.serverStatus).toBe('needs_review');
  });

  it('still writes answers that come back in order', async () => {
    // The guard drops what is *older*, never merely what is second. A sequencing fix that also
    // swallowed ordinary consecutive refreshes would freeze Home at its first answer.
    const id = await givenUploadedEntry();
    archive.defer = true;

    const first = refresher.refresh(TEST_PROJECT.id);
    archive.answer(0, [listItem(id, 'awaiting_confirmation')]);
    expect((await first).stale).toBe(false);

    const second = refresher.refresh(TEST_PROJECT.id);
    archive.answer(1, [listItem(id, 'confirmed')]);
    const result = await second;

    expect(result.stale).toBe(false);
    expect(result.changed).toBe(1);
    expect((await store.getEntry(id))?.serverStatus).toBe('confirmed');
  });

  it('asks for the same window the archive does, so the two cannot disagree', async () => {
    await refresher.refresh(TEST_PROJECT.id);

    expect(archive.calls).toEqual([{ projectId: TEST_PROJECT.id, limit: 200 }]);
  });
});
