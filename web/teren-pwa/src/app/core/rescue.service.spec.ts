import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { TEST_PROJECT, captureEntry } from '../testing/capture-fixture';
import { AudioRecorderService } from './media/audio-recorder.service';
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
   * The saved screen is the only screen a *URL* can exempt: every other screen either holds no
   * draft (the confirm gate opens on an entry that is long past `draft`) or holds nothing at all.
   * Asserted against the table's own paths so a regex loose enough to swallow a sibling
   * `:entryId` route — `confirm/:entryId` is right next to it — is caught here.
   */
  it('exempts nothing on any other screen', async () => {
    expect(openEntryIds('/')).toEqual([]);
    expect(openEntryIds(await entryUrlFor(ConfirmPage, 'abc'))).toEqual([]);
    expect(openEntryIds(await routeUrlFor(PendingPage))).toEqual([]);
  });

  /**
   * **The recording screen is not exempt here, and until 2026-09-02 that was the whole defect.**
   *
   * This assertion is unchanged and still correct — `/record` carries no entry id, so there is
   * nothing for a URL to name — but the sentence that used to sit over it ("only the saved screen
   * is exempt, and deliberately so") was read as *nothing else needs to be*, and the sweep this
   * function feeds truncated every live recording that survived a return to the foreground.
   *
   * What changed is where the recording screen's exemption comes from: the recorder, which knows
   * which capture the microphone is filling, via `RescueService.exempt`. See the live-recording
   * specs below — they are the ones that would go red.
   */
  it('cannot exempt the recording screen, because that URL names no entry', async () => {
    expect(openEntryIds(await routeUrlFor(CaptureRecordingPage))).toEqual([]);
  });
});

describe('RescueService', () => {
  let db: TerenDb;
  let store: EntryStore;
  /** What the recorder says is live. Null unless a spec puts a take in the microphone. */
  let live: WritableSignal<string | null>;

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    live = signal<string | null>(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: TEREN_DB, useValue: db },
        // Only `entryId` is read, and reading it is the point: the recorder is the one thing that
        // knows which capture the microphone is filling.
        { provide: AudioRecorderService, useValue: { entryId: live.asReadonly() } },
      ],
    });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  /**
   * Open a capture with one chunk on disk, and say how long ago that chunk arrived.
   *
   * The age is the whole point of the helper. A capture whose last chunk landed a moment ago is a
   * recording in progress; one whose last chunk landed a minute ago is a tab the OS discarded, and
   * only the second is this sweep's business.
   */
  async function capture(options: { lastChunkAgeMs: number }): Promise<string> {
    const entryId = crypto.randomUUID();
    await store.beginCapture({
      entryId,
      project: TEST_PROJECT,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      mimeType: 'audio/ogg;codecs=opus',
    });
    await store.appendChunk(entryId, new Blob([new Uint8Array([5, 5])]));
    await db.captures.update(entryId, {
      lastChunkAt: new Date(Date.now() - options.lastChunkAgeMs).toISOString(),
    });
    return entryId;
  }

  it('assembles an interrupted recording when the app comes back', async () => {
    const entryId = await capture({ lastChunkAgeMs: 60_000 });

    await TestBed.inject(RescueService).run();

    expect((await db.entries.get(entryId))?.status).toBe('draft');
  });

  /**
   * ## The worst bug this product has had, and the first of the two defences against it
   *
   * `run()` fires on every `visibilitychange → visible`: a notification pulled down and dismissed,
   * a screen lock, a glance at the clock, the phone handing the tab back after the camera. Until
   * 2026-09-02 the only exemption was the saved screen's URL, so each of those swept the take the
   * foreman was in the middle of speaking — `finishCapture` assembled the seconds recorded so far
   * and **deleted the session**, after which every further chunk hit `appendChunk`'s
   * missing-session branch and was dropped while the timer went on climbing. Measured against the
   * production build: a six-second take with one tab switch at 2.5 s saved 2.2 s of audio, silently.
   *
   * The capture here is deliberately **stale** — its last chunk is a minute old — so the store's
   * own freshness guard cannot rescue this assertion. Only the recorder's exemption can, which is
   * what makes this a proof of that line rather than of the pair.
   */
  it('leaves the take the microphone is filling alone, even though no URL names it', async () => {
    const entryId = await capture({ lastChunkAgeMs: 60_000 });
    live.set(entryId);

    await TestBed.inject(RescueService).run();

    // Still a capture, not an entry: the session is intact and the next chunk has somewhere to go.
    expect(await db.captures.get(entryId)).toBeDefined();
    expect(await db.entries.get(entryId)).toBeUndefined();
    expect(await db.chunks.where('entryId').equals(entryId).count()).toBe(1);
  });

  /**
   * The second defence, and the one that does not depend on the caller remembering anything.
   *
   * A capture that produced audio a second ago is a live recording whoever asked for the sweep and
   * whatever they thought they were exempting. The recorder is deliberately silent here (`live` is
   * null), so this asserts the store's guard alone.
   */
  it('leaves a capture whose last chunk just arrived, whatever it was told to exempt', async () => {
    const entryId = await capture({ lastChunkAgeMs: 500 });

    await TestBed.inject(RescueService).run();

    expect(await db.captures.get(entryId)).toBeDefined();
    expect(await db.entries.get(entryId)).toBeUndefined();
  });

  /**
   * The exemption is a description of *now*, and it has to expire.
   *
   * `AudioRecorderService.entryId` is cleared when the device is released, and this is why that
   * matters: the same list goes to the abandoned-draft sweep, so a recorder that went on naming a
   * finished take would quietly stop that man's draft from ever reaching the queue — which is the
   * defect this fix would have traded for the one it closed.
   */
  it('exempts nothing once the recording is over', async () => {
    const entry = await captureEntry(store);
    await db.entries.update(entry.id, { updatedAt: '2020-01-01T00:00:00.000Z' });
    // What a finished take leaves behind: an idle recorder naming nothing.
    live.set(null);

    await TestBed.inject(RescueService).run();

    expect((await db.entries.get(entry.id))?.status).toBe('queued');
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
