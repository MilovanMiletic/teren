import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { AppStatus } from '../../core/app-status.service';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import {
  AudioRecorderService,
  FinishedRecording,
  RecorderState,
} from '../../core/media/audio-recorder.service';
import { GeolocationService } from '../../core/media/geolocation.service';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { ProjectService } from '../../core/projects/project.service';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import { CaptureRecordingPage } from './capture-recording-page';
import { inject, signal } from '@angular/core';

/**
 * A recorder that behaves like the real one from the component's side: it writes chunks to the
 * store as it "records", so the specs exercise the durability contract rather than a mock of it.
 */
class FakeRecorder {
  readonly stateSignal = signal<RecorderState>('idle');
  readonly state = this.stateSignal.asReadonly();
  readonly elapsedMs = signal(0).asReadonly();
  readonly levels = signal<number[]>([]).asReadonly();

  startCalls = 0;
  cancelled = false;
  private duration = 41_000;

  constructor(
    private readonly entries: EntryStore,
    private readonly outcome: 'ok' | 'denied' = 'ok',
  ) {}

  async start(entryId: string): Promise<boolean> {
    this.startCalls += 1;
    if (this.outcome === 'denied') {
      this.stateSignal.set('denied');
      return false;
    }
    this.stateSignal.set('recording');
    // Two seconds of audio land on disk while recording, exactly as the real recorder does.
    await this.entries.appendChunk(entryId, new Blob([new Uint8Array([1, 1])]));
    await this.entries.appendChunk(entryId, new Blob([new Uint8Array([2, 2])]));
    return true;
  }

  async stop(): Promise<FinishedRecording | null> {
    if (this.stateSignal() !== 'recording') {
      return null;
    }
    this.stateSignal.set('idle');
    return { durationMs: this.duration, mimeType: 'audio/ogg;codecs=opus' };
  }

  cancel(): void {
    this.cancelled = true;
    this.stateSignal.set('idle');
  }

  reset(): void {
    if (this.stateSignal() !== 'recording') {
      this.stateSignal.set('idle');
    }
  }

  async flush(): Promise<void> {}

  lastDurationMs(): number {
    return this.duration;
  }

  /** Simulate the OS taking the microphone away mid-sentence. */
  interrupt(): void {
    this.stateSignal.set('interrupted');
  }
}

/** What the screen is currently saying, as a plain string the assertions can search. */
function text(element: HTMLElement): string {
  return element.textContent ?? '';
}

describe('CaptureRecordingPage', () => {
  let db: TerenDb;
  let store: EntryStore;
  let recorder: FakeRecorder;
  let fixture: ComponentFixture<CaptureRecordingPage>;

  async function configure(options: { outcome?: 'ok' | 'denied'; projects?: boolean } = {}) {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    TestBed.configureTestingModule({
      imports: [
        CaptureRecordingPage,
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
        { provide: GeolocationService, useValue: { currentFix: async () => null } },
        {
          provide: AudioRecorderService,
          useFactory: () => new FakeRecorder(inject(EntryStore), options.outcome ?? 'ok'),
        },
      ],
    });

    store = TestBed.inject(EntryStore);
    recorder = TestBed.inject(AudioRecorderService) as unknown as FakeRecorder;

    if (options.projects !== false) {
      await TestBed.inject(ProjectService).load();
    }

    fixture = TestBed.createComponent(CaptureRecordingPage);
    await fixture.whenStable();
    // The capture chain is several IndexedDB transactions deep — open the session, then one
    // chunk per second of audio — and `whenStable()` only knows about Angular's own pending
    // work, not Dexie's. Wait for the two seconds of audio the fake recorder writes to actually
    // be on disk, rather than for a number of turns that is right on an idle machine and wrong
    // on a loaded one: every spec below starts from a settled store, not a probable one.
    // Only when a recording really was started: without a site the screen refuses to record, and
    // with a denied microphone there is nothing to write.
    if ((options.outcome ?? 'ok') === 'ok' && options.projects !== false) {
      await waitUntil(async () => (await db.chunks.count()) === 2, {
        onTick: () => fixture.detectChanges(),
        describe: 'the recorded chunks to reach the store',
      });
    } else {
      await flushLiveQueries(10);
    }
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('opens the capture session before the first byte, so no chunk is homeless', async () => {
    await configure();

    const sessions = await db.captures.toArray();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectId).toBe(DEMO_PROJECTS[0].id);
    expect(await db.chunks.count()).toBe(2);
  });

  it('keeps the take when the screen is destroyed mid-recording — the back gesture', async () => {
    await configure();
    const entryId = (await db.captures.toArray())[0].entryId;

    fixture.destroy();
    await flushLiveQueries(5);

    // A draft exists with the audio recorded so far; nothing was discarded.
    const entry = await db.entries.get(entryId);
    expect(entry?.status).toBe('draft');
    const [audio] = await db.media.where({ entryId, kind: 'audio' }).toArray();
    expect(new Uint8Array(await audio.blob.arrayBuffer())).toEqual(new Uint8Array([1, 1, 2, 2]));
    expect(recorder.cancelled).toBe(false);
  });

  it('salvages an interrupted recording and offers it, instead of a climbing dead timer', async () => {
    const element = await configure();
    const entryId = (await db.captures.toArray())[0].entryId;

    recorder.interrupt();
    fixture.detectChanges();
    // Wait for the salvage to actually land. Assembling the chunks is several IndexedDB
    // transactions deep and takes as long as the device takes; a fixed number of turns is a guess
    // about the machine, not an assertion about the code.
    await waitUntil(() => text(element).includes('Otvori sačuvani snimak'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the salvaged take to be offered',
    });

    expect(text(element)).toContain('Snimanje je prekinuto');
    expect((await db.entries.get(entryId))?.status).toBe('draft');
  });

  it('offers no action at all while the interrupted take is still being salvaged', async () => {
    const element = await configure();

    recorder.interrupt();
    fixture.detectChanges();

    // The first render after the interruption, before the salvage has resolved. "Pokušaj ponovo"
    // here would start a fresh recording over chunks that are not yet a draft, stranding the take
    // the foreman just lost behind a screen with no route back to it.
    expect(text(element)).toContain('Snimanje je prekinuto');
    expect(text(element)).toContain('Čuvanje snimljenog…');
    expect(text(element)).not.toContain('Pokušaj ponovo');

    const primary = element.querySelector<HTMLButtonElement>('.problem__actions .btn--primary');
    expect(primary?.disabled).toBe(true);
  });

  it('keeps the interrupted take and offers another attempt when assembling it fails', async () => {
    const element = await configure();
    const entryId = (await db.captures.toArray())[0].entryId;

    vi.spyOn(store, 'finishCapture').mockRejectedValueOnce(new Error('quota exceeded'));
    recorder.interrupt();
    fixture.detectChanges();
    await waitUntil(() => text(element).includes('Sačuvaj ponovo'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the failed salvage to offer another attempt',
    });

    // A failed assemble is not a lost take: the chunks are untouched, and the screen offers to
    // save them again rather than to record over them.
    expect(await db.chunks.where('entryId').equals(entryId).count()).toBe(2);
    expect(text(element)).not.toContain('Pokušaj ponovo');

    element.querySelector<HTMLButtonElement>('.problem__actions .btn--primary')?.click();
    await waitUntil(() => text(element).includes('Otvori sačuvani snimak'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the retried salvage to be offered',
    });

    expect((await db.entries.get(entryId))?.status).toBe('draft');
  });

  it('lets a new take own the screen when the previous salvage lands late', async () => {
    const element = await configure();
    const first = (await db.captures.toArray())[0].entryId;

    // Hold the salvage open so a new take starts while the previous one is still assembling.
    // The UI no longer offers that (the action slot is disabled until the salvage resolves), so
    // this is the guard behind the guard: a late salvage must not write over the take that
    // replaced it — nulling its entry id would leave the foreman with a stop button that does
    // nothing and a recording only the start-up sweep could rescue.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const finishCapture = store.finishCapture.bind(store);
    vi.spyOn(store, 'finishCapture').mockImplementationOnce(async (entryId, options) => {
      await held;
      return finishCapture(entryId, options);
    });

    recorder.interrupt();
    fixture.detectChanges();
    await flushLiveQueries(2);

    await (fixture.componentInstance as unknown as { begin(): Promise<void> }).begin();
    await flushLiveQueries(5);
    release();
    await flushLiveQueries(10);
    fixture.detectChanges();

    const second = (await db.captures.toArray())[0].entryId;
    expect(second).not.toBe(first);

    element.querySelector<HTMLButtonElement>('.stop')?.click();
    await waitUntil(async () => (await db.entries.get(second))?.status === 'draft', {
      onTick: () => fixture.detectChanges(),
      describe: 'the second take to be saved',
    });

    // Both takes survived: the salvaged one and the one recorded after it.
    expect(await db.entries.count()).toBe(2);
    expect((await db.entries.get(first))?.status).toBe('draft');
  });

  it('throws the take away only on an explicit cancel', async () => {
    const element = await configure();
    const entryId = (await db.captures.toArray())[0].entryId;

    element.querySelector<HTMLButtonElement>('.actions__cancel')?.click();
    await flushLiveQueries(5);

    expect(recorder.cancelled).toBe(true);
    expect(await db.entries.get(entryId)).toBeUndefined();
    expect(await db.chunks.count()).toBe(0);
    expect(await db.captures.count()).toBe(0);
  });

  it('refuses to start without a site rather than recording something unsaveable', async () => {
    const element = await configure({ projects: false });

    expect(recorder.startCalls).toBe(0);
    expect(await db.captures.count()).toBe(0);
    expect(element.textContent).toContain('Gradilište nije izabrano');
  });

  it('refuses to start when the local store is unavailable', async () => {
    await configure();
    fixture.destroy();

    TestBed.inject(AppStatus).reportStorageFailure();
    const second = TestBed.createComponent(CaptureRecordingPage);
    await second.whenStable();
    second.detectChanges();

    expect((second.nativeElement as HTMLElement).textContent).toContain(
      'Telefon ne može da čuva snimke',
    );
    second.destroy();
  });

  it('keeps the audio and offers a retry when saving the take fails', async () => {
    const element = await configure();
    const entryId = (await db.captures.toArray())[0].entryId;

    // The assemble-and-save fails once: the chunks are still on disk, so nothing is stranded.
    vi.spyOn(store, 'finishCapture').mockRejectedValueOnce(new Error('quota exceeded'));
    element.querySelector<HTMLButtonElement>('.stop')?.click();
    await flushLiveQueries(10);
    fixture.detectChanges();

    expect(element.textContent).toContain('Snimak nije mogao da se sačuva');
    expect(element.textContent).toContain('Sačuvaj ponovo');
    expect(await db.chunks.where('entryId').equals(entryId).count()).toBe(2);
    expect(await db.entries.count()).toBe(0);

    // And the retry, with the store working again, produces the entry from the same chunks.
    element.querySelector<HTMLButtonElement>('.btn--solid')?.click();
    await flushLiveQueries(10);

    const entry = await db.entries.get(entryId);
    expect(entry?.status).toBe('draft');
    const [audio] = await db.media.where({ entryId, kind: 'audio' }).toArray();
    expect(new Uint8Array(await audio.blob.arrayBuffer())).toEqual(new Uint8Array([1, 1, 2, 2]));
  });

  it('shows the microphone denial as a recoverable state and leaves no session behind', async () => {
    const element = await configure({ outcome: 'denied' });

    expect(element.textContent).toContain('Mikrofon nije dozvoljen');
    expect(element.textContent).toContain('Ništa nije izgubljeno');
    expect(await db.captures.count()).toBe(0);
    expect(await db.entries.count()).toBe(0);
  });
});
