import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { EntryResponse } from '../../core/api/api-types';
import { ArchiveService } from '../../core/archive/archive.service';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
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
  let archive: { getEntry: ReturnType<typeof vi.fn> };

  async function render(entryId: string): Promise<HTMLElement> {
    fixture = TestBed.createComponent(EntryDetail);
    fixture.componentRef.setInput('entryId', entryId);
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** Wait for the asynchronous local + server loads to land, then read the DOM. */
  async function settled(element: HTMLElement, text: string): Promise<void> {
    await waitUntil(() => element.textContent!.includes(text), {
      onTick: () => fixture.detectChanges(),
      describe: `"${text}" to appear on the record`,
    });
  }

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    archive = { getEntry: vi.fn().mockResolvedValue({ status: 'ok', entry: null, missing: true }) };

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
        { provide: TEREN_DB, useValue: db },
        { provide: ArchiveService, useValue: archive as unknown as ArchiveService },
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

  it('reports photographs the server holds that this phone does not', async () => {
    // Media bytes never pass through the API and there is no presigned GET, so they cannot be
    // shown — but a silent zero over an entry with six photographs would be the archive failing.
    archive.getEntry.mockResolvedValue({
      status: 'ok',
      missing: false,
      entry: serverEntry({
        media: [
          { id: 'm1', kind: 'photo', content_type: 'image/jpeg', byte_size: 1, sha256: 'x', object_key: 'k1', upload_status: 'verified' },
          { id: 'm2', kind: 'photo', content_type: 'image/jpeg', byte_size: 1, sha256: 'x', object_key: 'k2', upload_status: 'verified' },
          { id: 'm3', kind: 'audio', content_type: 'audio/ogg', byte_size: 1, sha256: 'x', object_key: 'k3', upload_status: 'verified' },
        ],
      }),
    });

    const element = await render('entry-1');
    await settled(element, 'na serveru, nisu na ovom telefonu');

    expect(element.querySelectorAll('.photos__thumb')).toHaveLength(0);
    expect(element.textContent).toContain('Snimak je na serveru');
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
          materials: [
            { name: 'kuglasti ventil 1"', delivered: false },
            { name: 'Silikon' },
          ],
        },
      }),
    });

    const element = await render('entry-1');
    await settled(element, 'Nije isporučeno');

    // Exactly one chip: the material with no stated delivery gets no claim made about it.
    expect(element.querySelectorAll('.items__chip')).toHaveLength(1);
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
});
