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
import { flushLiveQueries } from '../../testing/flush';
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
    // The capture chain is several IndexedDB transactions deep (open session, then a chunk per
    // second of audio); give every one of them a turn before asserting.
    await flushLiveQueries(10);
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
    await flushLiveQueries(5);
    fixture.detectChanges();

    expect(element.textContent).toContain('Snimanje je prekinuto');
    expect(element.textContent).toContain('Otvori sačuvani snimak');
    expect((await db.entries.get(entryId))?.status).toBe('draft');
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
