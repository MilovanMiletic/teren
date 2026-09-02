import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { EntryResponse } from '../../core/api/api-types';
import { ArchiveService } from '../../core/archive/archive.service';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { ReportResult, ReportService } from '../../core/report/report.service';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { describeClick } from '../../core/telemetry/action-descriptor';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { captureEntry } from '../../testing/capture-fixture';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { EntryDetail } from './entry-detail';

/** The day-1 seed, trimmed to what this screen reads. */
const SEEDED_STRUCTURE = {
  schema_version: 1,
  work_done: [
    {
      description: 'Razvod tople i hladne vode',
      location: '2. sprat, zapadno krilo',
      quantity: { value: 40, unit: 'm' },
    },
  ],
  headcount: { total: 3, roles: [{ role: 'vodoinstalater', count: 3 }] },
  materials: [{ name: 'PPR cev 25mm', quantity: { value: 40, unit: 'm' }, delivered: true }],
  blockers: [{ description: 'čeka se štemovanje', waiting_on: 'električari' }],
  hidden_work: [{ description: 'Razvod cevi u zidovima pre zatvaranja', media_ids: [] }],
  notes: null,
};

/** A failed download, in the shape `ReportService` returns. */
function failed(failure: string, retryable: boolean): ReportResult {
  return { ok: false, failure: failure as ReportResult['failure'], retryable, filename: null };
}

function serverEntry(overrides: Partial<EntryResponse> = {}): EntryResponse {
  return {
    id: 'entry-1',
    project_id: 'project-1',
    entry_date: '2026-08-29',
    status: 'reported',
    created_at: '2026-08-29T12:12:00.000Z',
    received_at: '2026-08-29T12:13:35.000Z',
    confirmed_at: '2026-08-29T12:36:00.000Z',
    reported_at: '2026-08-29T12:38:00.000Z',
    failure_reason: null,
    media: [],
    ...overrides,
  };
}

describe('EntryDetail', () => {
  let db: TerenDb;
  let store: EntryStore;
  let fixture: ComponentFixture<EntryDetail>;
  let archive: { getEntry: ReturnType<typeof vi.fn>; getMedia: ReturnType<typeof vi.fn> };
  let reports: { download: ReturnType<typeof vi.fn> };

  async function render(entryId: string): Promise<HTMLElement> {
    fixture = TestBed.createComponent(EntryDetail);
    fixture.componentRef.setInput('entryId', entryId);
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** Wait for the asynchronous local + server loads to land, then read the DOM. */
  /**
   * Wait for a sentence to appear — or, with `gone`, to stop being true.
   *
   * The second mode is what C3 needs: the interesting moment for a fetched photograph is when the
   * "not on this phone" line *stops* applying, and polling for an absence from the first frame
   * would pass before the screen had rendered anything at all.
   */
  async function settled(element: HTMLElement, text: string, gone = false): Promise<void> {
    await waitUntil(() => element.textContent!.includes(text) !== gone, {
      onTick: () => fixture.detectChanges(),
      describe: `"${text}" to ${gone ? 'disappear from' : 'appear on'} the record`,
    });
  }

  /**
   * Wait for the photo strip to hold exactly `count` thumbnails.
   *
   * Waiting on the pictures rather than on the "not on this phone" sentence, deliberately: that
   * sentence is *also* hidden while a fetch is in flight, so waiting for it to go away resolves
   * during loading and the assertions then run against an empty strip. Found the honest way — the
   * first version of the retry spec did exactly that and failed.
   */
  async function thumbs(element: HTMLElement, count: number): Promise<void> {
    await waitUntil(() => element.querySelectorAll('.photos__thumb').length === count, {
      onTick: () => fixture.detectChanges(),
      describe: `${count} photograph(s) on the strip`,
    });
  }

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    archive = {
      getEntry: vi.fn().mockResolvedValue({ status: 'ok', entry: null, missing: true }),
      // C3's read path. Defaults to "no bytes", so every spec written before it existed keeps
      // describing a phone that shows only what it holds itself.
      getMedia: vi.fn().mockResolvedValue(null),
    };
    reports = {
      download: vi
        .fn()
        .mockResolvedValue({ ok: true, failure: null, retryable: false, filename: 'teren.pdf' }),
    };

    TestBed.configureTestingModule({
      imports: [
        EntryDetail,
        TranslocoTestingModule.forRoot({
          langs: { sr, en },
          translocoConfig: {
            availableLangs: ['sr', 'en'],
            defaultLang: 'sr',
            reRenderOnLangChange: true,
          },
          preloadLangs: true,
        }),
      ],
      providers: [
        provideRouter([]),
        { provide: TEREN_DB, useValue: db },
        { provide: ArchiveService, useValue: archive as unknown as ArchiveService },
        { provide: ReportService, useValue: reports as unknown as ReportService },
      ],
    });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('renders the whole structured day the way the seed writes it', async () => {
    const entry = await captureEntry(store, { photoCount: 1 });
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: entry.id, structure: SEEDED_STRUCTURE }),
    });

    const element = await render(entry.id);
    await settled(element, 'Razvod tople i hladne vode');

    // Content is never translated: the Serbian appears exactly as the model wrote it.
    expect(element.textContent).toContain('2. sprat, zapadno krilo');
    expect(element.textContent).toContain('PPR cev 25mm');
    expect(element.textContent).toContain('vodoinstalater');
    expect(element.textContent).toContain('čeka se štemovanje');
    // The blocker's `waiting_on` is chrome around content, so the label is localised…
    expect(element.textContent).toContain('Čeka se: električari');
    // …and hidden work is called out on its own, because it is the evidence that cannot be
    // recovered once the wall closes.
    expect(element.querySelector('.detail__card--hidden')).not.toBeNull();
    // No `corrected` yet — the live seed's `awaiting_confirmation` day is exactly this shape —
    // so the record must not imply a person has approved it.
    expect(element.textContent).toContain('Automatski izdvojeno');
    expect(element.textContent).not.toContain('Proverio čovek');
  });

  it('shows the human-approved version, and says a person approved it', async () => {
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({
        id: entry.id,
        structure: SEEDED_STRUCTURE,
        corrected: {
          ...SEEDED_STRUCTURE,
          notes: 'Izmereno na licu mesta: 42 m, ne 40 m.',
        },
      }),
    });

    const element = await render(entry.id);
    await settled(element, 'Proverio čovek');

    // `corrected` is what the report was built from, and the archive shows what was sent.
    expect(element.textContent).toContain('Izmereno na licu mesta: 42 m, ne 40 m.');
  });

  it('says an extraction has not run yet rather than showing an empty day', async () => {
    // The common case today: B4 is mid-build and no entry has a structure.
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: entry.id, status: 'processing' }),
    });

    const element = await render(entry.id);
    await settled(element, 'Obrada je u toku');
  });

  it('separates "the model found nothing" from "nothing has run"', async () => {
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: entry.id, structure: { schema_version: 1, work_done: [] } }),
    });

    const element = await render(entry.id);
    await settled(element, 'Ništa nije izdvojeno iz ovog snimka');
  });

  it('says the pipeline failed, and that nothing was lost', async () => {
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: entry.id, status: 'needs_review' }),
    });

    const element = await render(entry.id);
    await settled(element, 'Obrada nije uspela');

    expect(element.textContent).toContain('Ništa nije izgubljeno');
    expect(element.querySelector('.detail__state--err')).not.toBeNull();
  });

  it('renders an entry that has never reached the server, from the phone alone', async () => {
    // Principle 3. The record is readable in airplane mode, and it says which parts are missing
    // *because* it has not been sent, rather than leaving blanks.
    const entry = await captureEntry(store, { photoCount: 2 });

    const element = await render(entry.id);
    await settled(element, 'Unos još nije poslat');

    expect(element.textContent).toContain('Još nije stiglo na server');
    expect(element.querySelectorAll('.photos__thumb')).toHaveLength(2);
    // The audio is on this phone, so it is playable.
    expect(element.querySelector('audio')).not.toBeNull();
  });

  it('does not claim an entry is empty when the server could not be asked', async () => {
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({ status: 'offline', entry: null, missing: false });

    const element = await render(entry.id);
    await settled(element, 'Podaci sa servera nisu dostupni');
  });

  it('reports photographs it could not fetch, rather than showing a silent zero', async () => {
    // C3 gave this screen a read path, and `getMedia` still answers null here — the server would
    // not produce the bytes. The count is what is left when fetching has done what it can, and a
    // silent zero over an entry with six photographs would be the archive failing at its one job.
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({
        media: [
          {
            id: 'm1',
            kind: 'photo',
            content_type: 'image/jpeg',
            byte_size: 1,
            sha256: 'x',
            object_key: 'k1',
            upload_status: 'verified',
          },
          {
            id: 'm2',
            kind: 'photo',
            content_type: 'image/jpeg',
            byte_size: 1,
            sha256: 'x',
            object_key: 'k2',
            upload_status: 'verified',
          },
          {
            id: 'm3',
            kind: 'audio',
            content_type: 'audio/ogg',
            byte_size: 1,
            sha256: 'x',
            object_key: 'k3',
            upload_status: 'verified',
          },
        ],
      }),
    });

    const element = await render('entry-1');
    await settled(element, 'na serveru, nisu na ovom telefonu');

    expect(element.querySelectorAll('.photos__thumb')).toHaveLength(0);
    expect(element.textContent).toContain('Snimak je na serveru');
  });

  /**
   * A slow local read for the entry you just left must never land on the one you just opened.
   *
   * `/entry/:entryId` is a single route, so Angular reuses this component across entries: the
   * input signal changes, the effect re-runs, and two Dexie reads are now in flight. Without a
   * freshness guard the slower one wins and paints entry A's site, time and status onto entry B —
   * confidently and plausibly, on the screen this product exists to be trusted on months later.
   *
   * Found by review on 2026-09-01; no spec covered it. Remove the `entryId() !== id` guard in
   * `entry-detail.ts` and this goes red.
   */
  it('never paints the previous entry over the one now on screen', async () => {
    // Two different sites, because the site name is read straight off `local` and painted on the
    // card. The photo strip is NOT a witness here — it comes from `watchMedia(entryId)`, keyed on
    // the current id, so it stays correct even with the race wide open. The first version of this
    // spec asserted on the strip and passed with the guard removed: vacuous, and caught by
    // actually running the mutation.
    const first = await captureEntry(store, { project: DEMO_PROJECTS[0], photoCount: 1 });
    const second = await captureEntry(store, { project: DEMO_PROJECTS[1], photoCount: 0 });
    expect(DEMO_PROJECTS[0].name).not.toBe(DEMO_PROJECTS[1].name);

    const entries = TestBed.inject(EntryStore);
    const real = entries.getEntry.bind(entries);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The first entry's local read hangs until we let it go — the ordering that actually happens
    // when a foreman taps twice on a cold database.
    vi.spyOn(entries, 'getEntry').mockImplementation(async (id: string) => {
      if (id === first.id) {
        await gate;
      }
      return real(id);
    });

    const element = await render(first.id);
    fixture.componentRef.setInput('entryId', second.id);

    // Poll rather than count turns: these are real Dexie reads on a real IndexedDB, so a fixed
    // number of ticks is a guess about the machine (the same reasoning `settled` records).
    await settled(element, DEMO_PROJECTS[1].name);

    // Now the abandoned read comes back and must be dropped on the floor.
    release();
    await fixture.whenStable();
    fixture.detectChanges();
    await flushLiveQueries();
    fixture.detectChanges();

    expect(element.textContent).toContain(DEMO_PROJECTS[1].name);
    expect(element.textContent).not.toContain(DEMO_PROJECTS[0].name);
  });

  // ------------------------------------------------------- C3: the photographs themselves

  /**
   * One remote photograph, as the server describes it.
   *
   * `upload_status` is the interesting field: only `verified` means `/complete` checked the stored
   * bytes against what the phone declared, and the endpoint refuses anything else with a 409.
   */
  function remotePhoto(id: string, upload_status = 'verified') {
    return {
      id,
      kind: 'photo',
      content_type: 'image/jpeg',
      byte_size: 1,
      sha256: 'x',
      object_key: `k-${id}`,
      upload_status,
    };
  }

  function serverHolding(...media: ReturnType<typeof remotePhoto>[]): void {
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ media }),
    });
  }

  /**
   * **The case the archive exists for, and the one it could not serve until C3.**
   *
   * An owner opens a record on his office tablet. Every photograph of that day was taken on a
   * foreman's phone, so this device holds none of the bytes — and before the read path landed the
   * screen could only tell him how many pictures it was not showing him. That is the buyer's
   * reason to pay, failing.
   */
  it('fetches and shows photographs this device never held', async () => {
    serverHolding(remotePhoto('m1'), remotePhoto('m2'));
    archive.getMedia.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));

    const element = await render('entry-1');
    await thumbs(element, 2);
    expect(archive.getMedia).toHaveBeenCalledWith('entry-1', 'm1');
    expect(archive.getMedia).toHaveBeenCalledWith('entry-1', 'm2');
    // Nothing is left over to apologise for, and the "no photographs" line must not appear either.
    expect(element.textContent).not.toContain('na serveru, nisu na ovom telefonu');
    expect(element.textContent).not.toContain('Uz ovaj unos nema fotografija');
  });

  /**
   * Media the server has not certified is not asked for at all.
   *
   * The endpoint answers a non-`verified` id with a 409, so asking is a guaranteed round trip to a
   * refusal — and the two cases are different sentences anyway. A photograph still on its way is
   * not a photograph that failed, and on a site connection the difference is most of the time.
   */
  it('does not ask for bytes the server has not certified', async () => {
    serverHolding(remotePhoto('m1', 'pending'), remotePhoto('m2', 'uploaded'));

    const element = await render('entry-1');
    await settled(element, 'na serveru, nisu na ovom telefonu');

    expect(archive.getMedia).not.toHaveBeenCalled();
    expect(element.querySelectorAll('.photos__thumb')).toHaveLength(0);
  });

  /**
   * A failure leaves the count honest and offers the one thing that might work.
   *
   * All four of the endpoint's distinctions — 404, the two 409s, 503 — arrive here as `null`,
   * because with `responseType: 'blob'` the problem document is unreadable. The screen says one
   * sentence for all of them, which is also the only sentence it can justify.
   */
  it('offers another attempt when a photograph will not come, and takes it', async () => {
    serverHolding(remotePhoto('m1'));
    archive.getMedia.mockResolvedValue(null);

    const element = await render('entry-1');
    await settled(element, 'na serveru, nisu na ovom telefonu');
    expect(element.querySelectorAll('.photos__thumb')).toHaveLength(0);

    // The server comes back. Pressing again must actually re-ask — the guard that stops a
    // re-render re-downloading must not also stop the foreman.
    archive.getMedia.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
    [...element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Pokušaj ponovo'))
      ?.click();
    await thumbs(element, 1);

    expect(archive.getMedia).toHaveBeenCalledTimes(2);
  });

  it('renders the transcript verbatim when the server sends one', async () => {
    const spoken =
      'Danas smo radili razvod tople i hladne vode na drugom spratu, zapadno krilo. ' +
      'Postavljeno je nekih četrdeset metara PPR cevi od dvadeset pet.';
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ raw_transcript: spoken }),
    });

    const element = await render('entry-1');
    await settled(element, 'četrdeset metara');

    expect(element.querySelector('.detail__transcript')!.textContent).toContain(spoken);
  });

  it('says the transcript has not arrived rather than leaving the card blank', async () => {
    // Today's real state: the API does not project `raw_transcript` yet.
    archive.getEntry.mockResolvedValue({ status: 'ok', missing: false, entry: serverEntry() });

    const element = await render('entry-1');
    await settled(element, 'Transkript još nije stigao sa servera');
  });

  it('shows the position and the weather when the record carries them', async () => {
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({
        latitude: 44.76931,
        longitude: 20.47858,
        gps_accuracy_m: 9.5,
        weather: {
          conditions: 'sunčano',
          temperature_min_c: 19.2,
          temperature_max_c: 30.5,
          precipitation_mm: 0,
        },
      }),
    });

    const element = await render('entry-1');
    await settled(element, '44.769310');

    expect(element.textContent).toContain('sunčano');
    expect(element.textContent).toContain('±10 m');
  });

  it('opens a photograph full size and closes it again', async () => {
    const entry = await captureEntry(store, { photoCount: 2 });

    const element = await render(entry.id);
    await waitUntil(() => element.querySelectorAll('.photos__thumb').length === 2, {
      onTick: () => fixture.detectChanges(),
      describe: 'both thumbnails to appear',
    });

    element.querySelectorAll<HTMLButtonElement>('.photos__thumb')[1].click();
    fixture.detectChanges();

    const viewer = element.querySelector('.viewer')!;
    expect(viewer).not.toBeNull();
    expect(viewer.textContent).toContain('2 / 2');

    // Wraps rather than dead-ending: with two photographs a stop at the end is only friction.
    viewer.querySelectorAll<HTMLButtonElement>('.viewer__nav')[1].click();
    fixture.detectChanges();
    expect(element.querySelector('.viewer')!.textContent).toContain('1 / 2');

    element.querySelector<HTMLButtonElement>('.viewer__bar .viewer__button')!.click();
    fixture.detectChanges();
    expect(element.querySelector('.viewer')).toBeNull();
  });

  it('says so when an entry is on neither the phone nor the server', async () => {
    // Only on an explicit 404 — the server answering "I do not have this".
    const element = await render('never-existed');
    await settled(element, 'Unos nije pronađen');
  });

  it('never claims an entry is missing when the server was merely unreachable', async () => {
    // G1. An owner opens a record captured on the foreman’s phone and the wifi blips. Saying
    // the entry does not exist on the server, on the screen whose whole job is proving evidence
    // exists, is the worst thing it can say.
    archive.getEntry.mockResolvedValue({ status: 'offline', entry: null, missing: false });

    const element = await render('server-only-entry');
    await settled(element, 'Unos nije učitan');

    expect(element.textContent).not.toContain('Unos nije pronađen');
    expect(element.textContent).not.toContain('nije ni na telefonu ni na serveru');
  });

  it('does not turn a 500 into a missing record either', async () => {
    archive.getEntry.mockResolvedValue({ status: 'unavailable', entry: null, missing: false });

    const element = await render('server-only-entry');
    await settled(element, 'Unos nije učitan');

    expect(element.textContent).not.toContain('Unos nije pronađen');
  });

  it('does not promise a blocked entry will send itself', async () => {
    // Its defining property is that no retry will move it, so the banner that says it uploads
    // on its own must not appear beside a chip reading "cannot be sent".
    const entry = await captureEntry(store);
    await store.queue(entry.id);
    await store.setOutboxState(entry.id, 'blocked', { failureKind: 'rejected' });

    const element = await render(entry.id);
    await settled(element, 'Unos ne može da se pošalje');

    expect(element.textContent).not.toContain('šalju se sami');
    expect(element.querySelector('.detail__notice--err')).not.toBeNull();
  });

  it('does not say a failed transcription is still on its way', async () => {
    // Two cards on one screen disagreeing about whether the pipeline is alive.
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ status: 'needs_review', raw_transcript: null }),
    });

    const element = await render('entry-1');
    await settled(element, 'Snimak nije mogao da se prepiše');

    expect(element.textContent).not.toContain('Transkript još nije stigao');
  });

  it('keeps "ordered, not delivered" apart from "he did not say"', async () => {
    // A material fact a report has to carry. The parser preserved it; the template used to drop it.
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({
        structure: {
          schema_version: 1,
          materials: [{ name: 'kuglasti ventil 1"', delivered: false }, { name: 'Silikon' }],
        },
      }),
    });

    const element = await render('entry-1');
    await settled(element, 'Nije isporučeno');

    // Exactly one chip: the material with no stated delivery gets no claim made about it.
    expect(element.querySelectorAll('.items__chip')).toHaveLength(1);
  });

  it('offers the confirmation gate on an entry the server is holding for a person', async () => {
    // The record stays read-only — that is what makes it evidence — but naming the problem and
    // hiding the only control that fixes it is the defect B5 fixed on Home.
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: entry.id, status: 'needs_review', reported_at: null }),
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    const element = await render(entry.id);
    await settled(element, 'Proverite i potvrdite');

    element.querySelector<HTMLButtonElement>('.detail__notice-action')!.click();
    expect(navigate).toHaveBeenCalledWith(['/confirm', entry.id]);
  });

  it('lets a foreman go back and correct an entry he has already confirmed', async () => {
    // The window between `confirmed` and `reported` is the last cheap chance to fix a typo: once
    // the report goes out the row is sealed for ever (B6) and the only remedy is a new correction
    // entry (C4, not built). Before this the way back existed only by typing the URL.
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: entry.id, status: 'confirmed', reported_at: null }),
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    const element = await render(entry.id);
    await settled(element, 'Ovaj unos još može da se ispravi');

    // A second chance, not an outstanding task: he did the work and said yes, and the record must
    // not imply he left something unfinished.
    expect(element.textContent).toContain('Ovaj dan ste već potvrdili');
    expect(element.textContent).not.toContain('Proverite i potvrdite');
    // Nor an alarm — the entry is fine. The warning tones belong to entries that need something.
    expect(element.querySelector('.detail__notice--warn')).toBeNull();
    expect(element.querySelector('.detail__notice--err')).toBeNull();

    element.querySelector<HTMLButtonElement>('.detail__notice-action')!.click();
    expect(navigate).toHaveBeenCalledWith(['/confirm', entry.id]);
  });

  it('offers no correction once the server says the report has gone out', async () => {
    // The status lags; `reported_at` does not. An entry the server has sealed must have no
    // editable path from anywhere.
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({
        id: entry.id,
        status: 'confirmed',
        reported_at: '2026-08-29T18:00:00.000Z',
      }),
    });

    const element = await render(entry.id);
    // The chip only reads "Potvrđen" once the server's answer has landed, so this waits for the
    // very load that carries `reported_at` rather than asserting on a half-drawn record.
    await settled(element, 'Potvrđen');

    expect(element.querySelector('.detail__notice-action')).toBeNull();
    expect(element.textContent).not.toContain('Ovaj unos još može da se ispravi');
  });

  it('offers no gate on a reported entry, which never changes again', async () => {
    const entry = await captureEntry(store);
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: entry.id }),
    });

    const element = await render(entry.id);
    await settled(element, 'Poslat');

    expect(element.querySelector('.detail__notice-action')).toBeNull();
  });

  /*
   * ---- The report download (PROJECT.md §11, ruling 5) -----------------------------------------
   *
   * The founder's rule for this screen, three reviews running: it must never claim to know
   * something it does not. So these tests are mostly about *what the screen refuses to say* —
   * that a report is missing when the server merely could not be reached, that it is gone when it
   * is thirty seconds away.
   */

  /** Render a reported entry and wait for the download action to appear. */
  async function reportedRecord(): Promise<HTMLElement> {
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ reported_at: '2026-08-29T18:00:00.000Z' }),
    });
    const element = await render('entry-1');
    await settled(element, 'Preuzmi PDF');
    return element;
  }

  function downloadButton(element: HTMLElement): HTMLButtonElement {
    const button = element.querySelector<HTMLButtonElement>('.detail__report-action');
    if (!button) {
      throw new Error('no download action on the record');
    }
    return button;
  }

  /** Click, let the (already resolved) service promise settle, and repaint. */
  async function tapDownload(element: HTMLElement): Promise<void> {
    downloadButton(element).click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('offers the report on a reported entry, and says the client already has it', async () => {
    const element = await reportedRecord();

    expect(element.textContent).toContain('Izveštaj poslat klijentu');
    // A fetch with the device token, never a link — so it must be a button, not an anchor.
    expect(downloadButton(element).tagName).toBe('BUTTON');
  });

  it('offers nothing to download on an entry whose report has not gone out', async () => {
    // A button that can only fail is the same lie as a screen inventing a fact. `reported_at`
    // from the server decides — never the local status cache, which is written once at upload
    // time and never refreshed.
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ status: 'confirmed', reported_at: null }),
    });

    const element = await render('entry-1');
    await settled(element, 'Potvrđen');

    expect(element.querySelector('.detail__report-action')).toBeNull();
    expect(reports.download).not.toHaveBeenCalled();
  });

  it('downloads the report and says so, naming the file from the entry date', async () => {
    const element = await reportedRecord();
    await tapDownload(element);

    expect(reports.download).toHaveBeenCalledTimes(1);
    // The fallback name carries no translated words: the report's language is the project's, not
    // the phone's, so a UI-locale filename would be wrong exactly when it is used.
    expect(reports.download.mock.calls[0][1]).toBe('teren-2026-08-29');
    expect(element.textContent).toContain('Izveštaj je preuzet na ovaj uređaj');
  });

  it('says "not ready yet" for a 409 — not that the entry is missing', async () => {
    // The distinction the whole feature turns on. The report is being produced and sent; nothing
    // is wrong, and nothing has been lost.
    reports.download.mockResolvedValue(failed('notReady', true));

    const element = await reportedRecord();
    await tapDownload(element);

    expect(element.textContent).toContain('Izveštaj još nije spreman');
    expect(element.textContent).not.toContain('Server nema ovaj unos');
    // Not an alarm, either: an orange notice, not a red one.
    expect(element.querySelector('.detail__report-error.notice--warn')).not.toBeNull();
    expect(element.querySelector('.detail__report-error.notice--err')).toBeNull();
    // And the button now says what pressing it would do.
    expect(downloadButton(element).textContent).toContain('Pokušaj ponovo');
  });

  it('says the server could not be asked when it could not be asked', async () => {
    // C3's review found a 404 rendering identically to an unreachable server on this very
    // screen. Offline is not evidence that the report is gone.
    reports.download.mockResolvedValue(failed('offline', true));

    const element = await reportedRecord();
    await tapDownload(element);

    expect(element.textContent).toContain('Nema interneta');
    expect(element.textContent).not.toContain('Server nema ovaj unos');
    expect(element.textContent).not.toContain('Izveštaj još nije spreman');
  });

  it('says a missing entry is missing, and calls that an error rather than a wait', async () => {
    reports.download.mockResolvedValue(failed('missing', false));

    const element = await reportedRecord();
    await tapDownload(element);

    expect(element.textContent).toContain('Server nema ovaj unos');
    expect(element.querySelector('.detail__report-error.notice--err')).not.toBeNull();
    // Nothing to try again: offering a retry over a terminal answer costs a foreman five taps.
    expect(downloadButton(element).textContent).not.toContain('Pokušaj ponovo');
  });

  it('says a lost report is lost, and that the client still has it', async () => {
    // The server sent the report and can no longer produce the file. "Try again in a few
    // moments" would be the screen promising a document that is never coming — so this one is
    // told as a fault, and it carries the part that is still true and still useful.
    reports.download.mockResolvedValue(failed('unavailable', false));

    const element = await reportedRecord();
    await tapDownload(element);

    expect(element.textContent).toContain('server više ne može da napravi fajl');
    expect(element.textContent).toContain('Klijent ga i dalje ima na mejlu');
    expect(element.textContent).not.toContain('Izveštaj još nije spreman');
    expect(element.querySelector('.detail__report-error.notice--err')).not.toBeNull();
    expect(downloadButton(element).textContent).not.toContain('Pokušaj ponovo');
  });

  it('starts one download however many times the button is tapped', async () => {
    // A few megabytes on a site connection is a button that looks inert for ten seconds, which is
    // how a foreman queues five downloads. The disabled attribute is the visible half; the guard
    // in the component is the half that holds when the tap arrives anyway.
    let release: (result: ReportResult) => void = () => undefined;
    reports.download.mockReturnValue(
      new Promise<ReportResult>((resolve) => {
        release = resolve;
      }),
    );

    const element = await reportedRecord();
    const button = downloadButton(element);

    // Three taps with **no change detection between them**, which is the real race: setting
    // `reportBusy` marks the component dirty, but the `disabled` attribute does not reach the DOM
    // until Angular repaints, and a browser will happily deliver a second tap before that. If the
    // only guard were the attribute, this would start three downloads.
    button.click();
    button.click();
    button.click();
    expect(reports.download).toHaveBeenCalledTimes(1);

    // And the visible half, once the repaint does happen.
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Preuzimanje');

    release({ ok: true, failure: null, retryable: false, filename: 'teren.pdf' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(downloadButton(element).disabled).toBe(false);
  });

  it('shows real progress while the bytes are arriving', async () => {
    // Determinate where the server sent a length: a silent button is what a foreman taps five
    // times.
    reports.download.mockImplementation(
      (_id: string, _name: string, onProgress: (fraction: number | null) => void) => {
        onProgress(0.42);
        return new Promise<ReportResult>(() => undefined);
      },
    );

    const element = await reportedRecord();
    downloadButton(element).click();
    fixture.detectChanges();

    const bar = element.querySelector<HTMLElement>('.detail__progress-bar');
    expect(bar?.style.width).toBe('42%');
    expect(element.textContent).toContain('Preuzeto 42%');
  });

  it('will not carry one entry’s failure onto the next record opened', async () => {
    reports.download.mockResolvedValue(failed('missing', false));

    const element = await reportedRecord();
    await tapDownload(element);
    expect(element.textContent).toContain('Server nema ovaj unos');

    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ id: 'entry-2', reported_at: '2026-08-29T18:00:00.000Z' }),
    });
    fixture.componentRef.setInput('entryId', 'entry-2');
    await fixture.whenStable();
    fixture.detectChanges();
    await settled(element, 'Preuzmi PDF');

    expect(element.textContent).not.toContain('Server nema ovaj unos');
  });

  it('will not call a half-uploaded entry from another phone "received"', async () => {
    // `received` means the JSON arrived; `received_at` means the evidence is sealed.
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({ status: 'received', received_at: null }),
    });

    const element = await render('entry-1');
    await settled(element, 'Prijem u toku');

    expect(element.querySelector('.chip--warn')).not.toBeNull();
  });

  /**
   * What the record tells the action log (D5).
   *
   * The photo strip and the two ways into the gate declare themselves; the download does not,
   * because pressing it is not the interesting fact. A report is a few megabytes over a site
   * connection and the question a support call actually asks is whether the PDF arrived — and, if
   * it did not, which of the eight refusals it was.
   */
  describe('the action log', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('names a photograph on the thumbnail that opens it', async () => {
      const entry = await captureEntry(store, { photoCount: 2 });
      const element = await render(entry.id);
      await thumbs(element, 2);

      expect(describeClick(element.querySelector('.photos__thumb'))).toBe(ACTIONS.archiveMediaOpen);
      // The `<img>` inside it is what a thumb is actually tapped on.
      expect(describeClick(element.querySelector('.photos__thumb img'))).toBe(
        ACTIONS.archiveMediaOpen,
      );
    });

    it('names the way into the gate on an entry the server is holding', async () => {
      const entry = await captureEntry(store);
      archive.getEntry.mockResolvedValue({
        status: 'ok',
        missing: false,
        entry: serverEntry({ id: entry.id, status: 'needs_review', reported_at: null }),
      });

      const element = await render(entry.id);
      await settled(element, 'Proverite i potvrdite');

      expect(describeClick(element.querySelector('.detail__notice-action'))).toBe(
        ACTIONS.confirmOpen,
      );
    });

    it('records a report that reached the phone', async () => {
      const element = await reportedRecord();
      const record = vi.spyOn(ActionLogService.prototype, 'record');

      await tapDownload(element);

      expect(record).toHaveBeenCalledWith(ACTIONS.archiveReportDownload, {
        outcome: 'ok',
        entryId: 'entry-1',
        detail: undefined,
      });
    });

    /**
     * The camelCase of `ReportFailure` is not a slug, and the contract's `detail` alphabet is
     * lower-case: an unconverted `notReady` would be dropped by the scrubber and the log would say
     * a download failed without ever saying why.
     */
    it('records a refused download with a reason the wire will actually carry', async () => {
      reports.download.mockResolvedValue(failed('notReady', true));
      const element = await reportedRecord();
      const record = vi.spyOn(ActionLogService.prototype, 'record');

      await tapDownload(element);

      expect(record).toHaveBeenCalledWith(ACTIONS.archiveReportDownload, {
        outcome: 'fail',
        entryId: 'entry-1',
        detail: { reason: 'not-ready' },
      });
    });
  });
});
