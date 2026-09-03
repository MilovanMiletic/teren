import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { AppStatus } from '../../core/app-status.service';
import { ArchiveService, RemoteEntry } from '../../core/archive/archive.service';
import { CORRECTION_PARAM } from '../../core/capture/correction-route';
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
import { describeClick } from '../../core/telemetry/action-descriptor';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { entryUrlFor } from '../../testing/route-table';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import { routes } from '../../app.routes';
import { SESSION_STORAGE_KEY } from '../../core/session/session';
import { CaptureRecordingPage } from './capture-recording-page';
import { CaptureSavedPage } from './capture-saved-page';
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
  /**
   * When `getUserMedia` actually resolved — the moment audio began, as opposed to the moment it
   * was asked for. Null until a take starts.
   */
  grantedAt: number | null = null;
  private duration = 41_000;

  constructor(
    private readonly entries: EntryStore,
    private readonly outcome: 'ok' | 'denied' = 'ok',
    /** How long the permission sheet sits in front of the foreman before he taps "Allow". */
    private readonly permissionDelayMs = 0,
  ) {}

  async start(entryId: string): Promise<boolean> {
    this.startCalls += 1;
    if (this.permissionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.permissionDelayMs));
    }
    if (this.outcome === 'denied') {
      this.stateSignal.set('denied');
      return false;
    }
    this.grantedAt = Date.now();
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
  let router: Router;
  let fixture: ComponentFixture<CaptureRecordingPage>;

  async function configure(
    options: {
      outcome?: 'ok' | 'denied';
      projects?: boolean;
      /** How long the microphone permission sheet stays up before the take begins. */
      permissionDelayMs?: number;
      /**
       * `?supersedes=<id>` on the URL that opened the screen — the correction gesture.
       *
       * Provided as an `ActivatedRoute` snapshot rather than by navigating, because
       * `TestBed.createComponent` builds the component outside the router's outlet and there is no
       * activated snapshot to read. The component takes the value **once**, in a field initialiser,
       * so a snapshot is exactly the shape it consumes.
       */
      correction?: string;
      /** A take that records nothing, so the harness must not wait for chunks. */
      expectSilence?: boolean;
    } = {},
  ) {
    /*
     * An activated phone, because that is the only kind that can be on this screen.
     *
     * The real table is gated since F4: without a stored session `canMatch` sends every one of
     * these navigations to `/welcome`, and the assertions below would fail for a reason that has
     * nothing to do with capture. Written before the router is built, since `SessionService`
     * reads the credential during construction.
     */
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        token: 'trn_d_a-real-device-token',
        deviceId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
        username: 'zoran.jovanovic',
        displayName: 'Zoran Jovanović',
        companyId: '33333333-3333-3333-3333-333333333333',
        companyName: 'Gradnja d.o.o.',
        activatedAt: '2026-08-30T08:00:00.000Z',
      }),
    );

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
        /*
         * The **real** route table, not `provideRouter([])`.
         *
         * Every exit from this screen is a `router.navigate` to a literal path, and an empty
         * table matches all of them equally badly — so an empty table is a spec that cannot see
         * the one failure this screen has. It happened: after the F4 back-out the component
         * navigated to `/entry/<id>` while `app.routes.ts` still registered `unos/:entryId`, the
         * wildcard bounced the foreman to Home with nothing on screen to say so, and all 538
         * specs stayed green. With the real routes in, a navigate target that stops matching
         * lands on `/` and the assertions below go red.
         */
        provideRouter(routes),
        { provide: TEREN_DB, useValue: db },
        { provide: GeolocationService, useValue: { currentFix: async () => null } },
        ...(options.correction === undefined
          ? []
          : [
              {
                provide: ActivatedRoute,
                useValue: {
                  snapshot: {
                    queryParamMap: convertToParamMap({ [CORRECTION_PARAM]: options.correction }),
                  },
                },
              },
            ]),
        {
          provide: AudioRecorderService,
          useFactory: () =>
            new FakeRecorder(
              inject(EntryStore),
              options.outcome ?? 'ok',
              options.permissionDelayMs ?? 0,
            ),
        },
      ],
    });

    store = TestBed.inject(EntryStore);
    recorder = TestBed.inject(AudioRecorderService) as unknown as FakeRecorder;
    router = TestBed.inject(Router);

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
    if ((options.outcome ?? 'ok') === 'ok' && options.projects !== false && !options.expectSilence) {
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
    localStorage.removeItem(SESSION_STORAGE_KEY);
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

  /**
   * ## A permission prompt is not recording
   *
   * The session has to be opened before `getUserMedia` is called — a chunk needs somewhere to land
   * before the first one arrives — so `beginCapture` stamps the moment the microphone was *asked
   * for*. On a first-ever recording that is a sheet a man with muddy hands has to find the "Allow"
   * button on, and until 2026-09-02 every second of it became a second of phantom recording: in
   * the entry's `capturedAt`, therefore in `created_at`, therefore in the timestamp printed on the
   * client's report, and at one end of the duration `finishCapture` derives when nobody presses
   * stop.
   *
   * Asserted against the moment the fake recorder *granted* the microphone rather than against a
   * fixed number of milliseconds: the claim is "the stamp is not older than the audio", which is
   * true of a fast grant and a slow one alike.
   */
  it('stamps the capture when audio began, not when the microphone was asked for', async () => {
    const asked = Date.now();
    await configure({ permissionDelayMs: 60 });
    const [session] = await db.captures.toArray();

    const stampOf = async () =>
      Date.parse((await db.captures.get(session.entryId))?.capturedAt ?? '');
    await waitUntil(async () => (await stampOf()) >= (recorder.grantedAt ?? Infinity), {
      onTick: () => fixture.detectChanges(),
      describe: 'the capture to be stamped no earlier than the audio',
    });

    // The sheet really was up for a measurable time, so a stamp taken before `start()` would have
    // been demonstrably older than the audio rather than merely a millisecond out.
    expect((recorder.grantedAt ?? 0) - asked).toBeGreaterThanOrEqual(60);
    // Nothing else moved: the chunks recorded on the way are still there.
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

  it('will not discard a take that is being saved — the reflex tap after Stop', async () => {
    /*
     * The window is real and it is the ordinary one. He presses Stop; assembling the blob and
     * writing the entry takes a second or two on a phone; his thumb is already on its way to the
     * button directly underneath. Cancel used to call `discardCapture` unconditionally, so a take
     * he had just decided to keep was deleted — with the chunks — one or two seconds after he
     * decided to keep it. Pre-existing since B2.
     *
     * The recorder's argument for leaving cancel live during `stopping` was about a recorder that
     * has hung. A *saving* take is not in that state: the audio is on disk and the screen is about
     * to navigate away by itself.
     */
    const element = await configure();
    const entryId = (await db.captures.toArray())[0].entryId;

    // Hold the save open, which is exactly what a slow phone does.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const finishCapture = store.finishCapture.bind(store);
    vi.spyOn(store, 'finishCapture').mockImplementationOnce(async (id, options) => {
      await held;
      return finishCapture(id, options);
    });

    element.querySelector<HTMLButtonElement>('.stop')?.click();
    await flushLiveQueries(2);
    fixture.detectChanges();

    const cancel = element.querySelector<HTMLButtonElement>('.actions__cancel')!;
    expect(cancel.disabled, 'cancel is live while the take is being written').toBe(true);
    cancel.click();
    await flushLiveQueries(2);

    // Nothing was thrown away, and the recorder was never told to abandon the take.
    expect(recorder.cancelled).toBe(false);
    expect(await db.chunks.count()).toBe(2);

    release();
    await waitUntil(async () => (await db.entries.get(entryId))?.status === 'draft', {
      onTick: () => fixture.detectChanges(),
      describe: 'the take to finish saving',
    });
    expect((await db.entries.get(entryId))?.status).toBe('draft');
  });

  it('gives the way out back the moment saving fails, which is when it is a real choice', async () => {
    // A failed save is the one state where abandoning still means something: the screen offers a
    // retry, the chunks are on disk, and he may legitimately decide the take is not worth it.
    const element = await configure();
    vi.spyOn(store, 'finishCapture').mockRejectedValueOnce(new Error('quota exceeded'));

    element.querySelector<HTMLButtonElement>('.stop')?.click();
    await flushLiveQueries(5);
    fixture.detectChanges();

    expect(element.querySelector<HTMLButtonElement>('.actions__cancel')!.disabled).toBe(false);
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

  /**
   * Where a recording actually ends up.
   *
   * All three exits from this screen navigate to the saved screen, and the expected URL is built
   * from the route table by the component it renders — never from a path string retyped here. If
   * `app.routes.ts` renames that route and this component is not updated with it, the real router
   * falls through to `'**' → redirectTo: ''`, `router.url` becomes `/`, and these fail. That is
   * the whole point: on main the foreman was silently bounced to Home after every take, could not
   * add a single photo, and nothing — no build error, no failing spec, no message on screen —
   * said so.
   */
  describe('lands the take on the saved screen', () => {
    async function expectSavedScreen(entryId: string): Promise<void> {
      const expected = await entryUrlFor(CaptureSavedPage, entryId);
      await waitUntil(() => router.url === expected, {
        onTick: () => fixture.detectChanges(),
        describe: `navigation to ${expected} (was ${router.url})`,
      });
      expect(router.url).toBe(expected);
    }

    it('after the foreman stops the recording himself', async () => {
      const element = await configure();
      const entryId = (await db.captures.toArray())[0].entryId;

      element.querySelector<HTMLButtonElement>('.stop')?.click();

      await expectSavedScreen(entryId);
    });

    it('after a failed save is retried', async () => {
      const element = await configure();
      const entryId = (await db.captures.toArray())[0].entryId;

      vi.spyOn(store, 'finishCapture').mockRejectedValueOnce(new Error('quota exceeded'));
      element.querySelector<HTMLButtonElement>('.stop')?.click();
      await waitUntil(() => text(element).includes('Sačuvaj ponovo'), {
        onTick: () => fixture.detectChanges(),
        describe: 'the retry offer',
      });

      element.querySelector<HTMLButtonElement>('.btn--solid')?.click();

      await expectSavedScreen(entryId);
    });

    it('after a take the OS interrupted is salvaged and opened', async () => {
      const element = await configure();
      const entryId = (await db.captures.toArray())[0].entryId;

      recorder.interrupt();
      fixture.detectChanges();
      await waitUntil(() => text(element).includes('Otvori sačuvani snimak'), {
        onTick: () => fixture.detectChanges(),
        describe: 'the salvaged take to be offered',
      });

      element.querySelector<HTMLButtonElement>('.problem__actions .btn--primary')?.click();

      await expectSavedScreen(entryId);
    });
  });

  /**
   * What this screen tells the action log (D5).
   *
   * Three of the four moments here cannot be expressed by a click. "He pressed record" is not the
   * fact worth having — the fact is whether the microphone opened, and why it did not; "he pressed
   * stop" is not the fact either — the fact is how long the take was and whether it survived. Only
   * the discard is a plain press, and that one declares itself on the control.
   */
  describe('the action log', () => {
    /**
     * Spied on the prototype, not on an instance: `begin()` runs from the constructor, so the very
     * first thing this screen records happens before `TestBed.createComponent` has returned and
     * there is nothing to hold a reference to yet.
     */
    function spyOnRecord() {
      return vi.spyOn(ActionLogService.prototype, 'record');
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('names the discard button on the control itself', async () => {
      const element = await configure();

      expect(describeClick(element.querySelector('.actions__cancel'))).toBe(
        ACTIONS.captureRecordDiscard,
      );
    });

    it('records a start that opened the microphone, against the entry it opened', async () => {
      const record = spyOnRecord();

      await configure();
      const entryId = (await db.captures.toArray())[0].entryId;

      expect(record).toHaveBeenCalledWith(ACTIONS.captureRecordStart, {
        outcome: 'ok',
        entryId,
      });
    });

    it('records a start with no site as blocked, and says which blocker', async () => {
      const record = spyOnRecord();

      await configure({ projects: false });

      expect(record).toHaveBeenCalledWith(ACTIONS.captureRecordStart, {
        outcome: 'blocked',
        detail: { reason: 'no-project' },
      });
    });

    it('records a refused microphone as a failure, with the recorder state as the reason', async () => {
      const record = spyOnRecord();

      await configure({ outcome: 'denied' });

      expect(record).toHaveBeenCalledWith(ACTIONS.captureRecordStart, {
        outcome: 'fail',
        detail: { reason: 'denied' },
      });
    });

    it('records the stop with how long the take was and that it survived', async () => {
      const element = await configure();
      const entryId = (await db.captures.toArray())[0].entryId;
      const record = spyOnRecord();

      element.querySelector<HTMLButtonElement>('.stop')?.click();
      await waitUntil(async () => (await db.entries.get(entryId))?.status === 'draft', {
        onTick: () => fixture.detectChanges(),
        describe: 'the take to be saved',
      });

      expect(record).toHaveBeenCalledWith(ACTIONS.captureRecordStop, {
        outcome: 'ok',
        durationMs: 41_000,
        entryId,
      });
    });

    /**
     * A save that threw is not a stop that worked, and the difference is the whole reason this one
     * is recorded by hand: the chunks are still on disk and the foreman is looking at a retry.
     */
    it('records a stop whose save failed as a failure', async () => {
      const element = await configure();
      const entryId = (await db.captures.toArray())[0].entryId;
      const record = spyOnRecord();

      vi.spyOn(store, 'finishCapture').mockRejectedValueOnce(new Error('quota exceeded'));
      element.querySelector<HTMLButtonElement>('.stop')?.click();
      await waitUntil(() => text(element).includes('Sačuvaj ponovo'), {
        onTick: () => fixture.detectChanges(),
        describe: 'the retry offer',
      });

      expect(record).toHaveBeenCalledWith(ACTIONS.captureRecordStop, {
        outcome: 'fail',
        entryId,
      });
    });
  });
});

/*
 * ---- Recording a correction (2026-09-03) ------------------------------------------------------
 *
 * `?supersedes=<entry id>` turns this screen into *record a correction of that day*. It is the
 * ordinary capture path — same microphone, same per-second persistence, same outbox, same gate —
 * with one field on the entry and one rule about the site.
 */
describe('CaptureRecordingPage recording a correction', () => {
  let db: TerenDb;
  let store: EntryStore;
  let fixture: ComponentFixture<CaptureRecordingPage>;

  /** The day being corrected, recorded on a site the foreman is **not** standing on. */
  const TARGET_SITE = DEMO_PROJECTS[1];

  let remote: RemoteEntry;

  async function configure(
    options: { correction: string; seedTarget?: boolean; expectSilence?: boolean },
  ): Promise<HTMLElement> {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        token: 'trn_d_a-real-device-token',
        deviceId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
        username: 'zoran.jovanovic',
        displayName: 'Zoran Jovanović',
        companyId: '33333333-3333-3333-3333-333333333333',
        companyName: 'Gradnja d.o.o.',
        activatedAt: '2026-08-30T08:00:00.000Z',
      }),
    );

    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    remote = { status: 'offline', entry: null, missing: false };

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
        provideRouter(routes),
        { provide: TEREN_DB, useValue: db },
        { provide: GeolocationService, useValue: { currentFix: async () => null } },
        {
          provide: ArchiveService,
          useValue: { getEntry: async (): Promise<RemoteEntry> => remote } as unknown as ArchiveService,
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap({ [CORRECTION_PARAM]: options.correction }),
            },
          },
        },
        {
          provide: AudioRecorderService,
          useFactory: () => new FakeRecorder(inject(EntryStore)),
        },
      ],
    });

    store = TestBed.inject(EntryStore);
    const projects = TestBed.inject(ProjectService);
    await projects.load();
    // The foreman is standing on the *first* demo site. The day he is correcting was recorded on
    // the second, which is the one case where the selected site and the correct one differ.
    projects.select(DEMO_PROJECTS[0].id);

    if (options.seedTarget !== false) {
      await db.entries.put({
        id: options.correction,
        projectId: TARGET_SITE.id,
        projectName: TARGET_SITE.name,
        capturedAt: '2026-09-01T14:12:00.000Z',
        localDay: '2026-09-01',
        status: 'confirmed_by_server',
        serverStatus: 'reported',
        geo: null,
        audioDurationMs: 41_000,
        photoCount: 0,
        confirmedByServerAt: '2026-09-01T14:13:00.000Z',
        createdAt: '2026-09-01T14:12:00.000Z',
        updatedAt: '2026-09-01T14:12:00.000Z',
      });
    }

    fixture = TestBed.createComponent(CaptureRecordingPage);
    await fixture.whenStable();

    if (options.expectSilence) {
      await flushLiveQueries(10);
    } else {
      await waitUntil(async () => (await db.chunks.count()) === 2, {
        onTick: () => fixture.detectChanges(),
        describe: 'the recorded chunks to reach the store',
      });
    }
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(async () => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    db.close();
    await db.delete();
  });

  /**
   * **The site is the target's, and the selected one is not a fallback.**
   *
   * `POST /api/entries` accepts `supersedes_entry_id` only for an entry of the same project;
   * anything else is a `404`, which is **terminal** in the outbox. So a correction filed against
   * the site the foreman happens to have picked would not bounce and heal — it would sit blocked,
   * and a day of his work would never leave the phone.
   */
  it('opens the session on the target’s site, not the selected one', async () => {
    const element = await configure({ correction: 'the-day-being-replaced' });

    const [session] = await db.captures.toArray();
    expect(session.projectId).toBe(TARGET_SITE.id);
    expect(session.projectId).not.toBe(DEMO_PROJECTS[0].id);
    expect(session.supersedesEntryId).toBe('the-day-being-replaced');

    // …and the screen says so before he speaks, naming the target's site and the day.
    expect(text(element)).toContain(TARGET_SITE.name);
    expect(text(element)).toContain('Menja unos od');
    expect(text(element)).toContain(sr.archive.correction.chip);
  });

  /** The finished take carries the link, so the outbox has something to send. */
  it('writes the link onto the entry the take produces', async () => {
    await configure({ correction: 'the-day-being-replaced' });

    const [session] = await db.captures.toArray();
    const entry = await store.finishCapture(session.entryId, { durationMs: 41_000 });

    expect(entry?.supersedesEntryId).toBe('the-day-being-replaced');
    expect(entry?.projectId).toBe(TARGET_SITE.id);
  });

  /**
   * **Nothing is recorded when the site cannot be established** — and that is the whole point of
   * the blocker rather than a fallback.
   *
   * The target is not on this phone and the server cannot be reached. Recording against the
   * selected site would produce an entry the server answers with a `404`, terminal, so the take
   * would never leave the phone. Refusing costs him a retry; guessing costs him the day.
   */
  it('refuses to record when it cannot say which site the day belongs to', async () => {
    const element = await configure({
      correction: 'a-day-on-another-phone',
      seedTarget: false,
      expectSilence: true,
    });

    expect(await db.captures.count()).toBe(0);
    expect(await db.chunks.count()).toBe(0);
    expect(await db.entries.count()).toBe(0);

    // And it says which of the app's problems this is — not "no site selected", which would be the
    // wrong sentence: he never selected one, the entry did.
    expect(text(element)).toContain(sr.capture.blocked.correction.title);
    expect(text(element)).not.toContain(sr.capture.blocked.project.title);
    // Nothing has been lost, and the copy says so.
    expect(text(element)).toContain('ništa nije izgubljeno');
  });

  /**
   * …and the retry is offered, which is the one blocker where it makes sense.
   *
   * The lookup fails when the server cannot be reached about a day this phone does not hold, and a
   * signal that comes back is exactly what makes another attempt succeed. `no-project` and
   * `no-storage` are conditions of the app, not of the moment.
   */
  it('offers another attempt, because a signal coming back is what fixes it', async () => {
    const element = await configure({
      correction: 'a-day-on-another-phone',
      seedTarget: false,
      expectSilence: true,
    });

    const retry = [...element.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes(sr.capture.record.retry),
    );
    expect(retry, 'no way to try again once the signal is back').toBeTruthy();

    // The server answers this time, on the target's own site.
    remote = {
      status: 'ok',
      entry: {
        id: 'a-day-on-another-phone',
        project_id: TARGET_SITE.id,
        entry_date: '2026-08-20',
        status: 'reported',
        created_at: '2026-08-20T13:40:00.000Z',
        received_at: '2026-08-20T13:41:00.000Z',
        reported_at: '2026-08-20T14:06:00.000Z',
      } as never,
      missing: false,
    };

    retry!.click();
    await waitUntil(async () => (await db.chunks.count()) === 2, {
      onTick: () => fixture.detectChanges(),
      describe: 'the retried take to reach the store',
    });

    const [session] = await db.captures.toArray();
    expect(session.projectId).toBe(TARGET_SITE.id);
    expect(session.supersedesEntryId).toBe('a-day-on-another-phone');
  });
});
