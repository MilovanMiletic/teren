import { TestBed } from '@angular/core/testing';

import { TEST_PROJECT } from '../../testing/capture-fixture';
import { waitUntil } from '../../testing/flush';
import { EntryStore } from '../db/entry-store';
import { TEREN_DB, TerenDb } from '../db/teren-db';
import { AudioRecorderService, CHUNK_INTERVAL_MS, STOP_TIMEOUT_MS } from './audio-recorder.service';

const MIME = 'audio/ogg;codecs=opus';

/**
 * What `getUserMedia` rejects with, in the shape the classifier reads.
 *
 * A browser throws a `DOMException`, whose prototype chain includes `Error` — which is what
 * `classifyGetUserMediaError`'s `instanceof Error` check leans on. **jsdom's `DOMException` is not
 * an `Error` instance**, so building one here would exercise the fall-through branch on every row
 * and quietly assert nothing. The name is the only thing the classifier reads, so a named `Error`
 * is the faithful stand-in.
 */
function deviceError(name: string): Error {
  return Object.assign(new Error('the microphone said no'), { name });
}

/** One microphone track, with the two things this service does to it. */
class FakeTrack {
  readonly kind = 'audio';
  stopped = false;
  onended: (() => void) | null = null;

  stop(): void {
    this.stopped = true;
  }

  /** The OS taking the device away: an incoming call, another app claiming the microphone. */
  end(): void {
    this.onended?.();
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack()]) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

/**
 * A `MediaRecorder` that behaves like the real one in the one respect that has cost this product
 * audio: **`stop()` emits the tail of the recording on a later task.**
 *
 * Everything since the previous timeslice arrives as one final `dataavailable`, *after* the caller
 * of `stop()` has returned, and `onstop` follows it. A fake that emitted synchronously would agree
 * with a service that tears down immediately and prove nothing — which is exactly how a
 * synchronous `interrupt()` shipped and lost the last second of every interrupted take.
 */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  /** Set to make the constructor throw, as a device refusing a type it claimed to support does. */
  static refuseMimeType: string | null = null;

  static last(): FakeMediaRecorder {
    const instance = FakeMediaRecorder.instances.at(-1);
    if (!instance) {
      throw new Error('no MediaRecorder was constructed');
    }
    return instance;
  }

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** What `start()` was handed — the timeslice, which is the whole durability contract. */
  timeslice: number | null = null;
  stopCalls = 0;
  /** A recorder that never reports it stopped, for the bounded-wait path. */
  silent = false;
  /** What the final `dataavailable` carries, or null for a recorder that ends empty. */
  tail: Uint8Array<ArrayBuffer> | null = new Uint8Array([9, 9]);

  readonly mimeType: string;

  constructor(
    readonly stream: FakeStream,
    options: { mimeType?: string } = {},
  ) {
    if (options.mimeType && options.mimeType === FakeMediaRecorder.refuseMimeType) {
      throw new Error('NotSupportedError');
    }
    this.mimeType = options.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number): void {
    this.state = 'recording';
    this.timeslice = timeslice ?? null;
  }

  stop(): void {
    this.stopCalls += 1;
    if (this.state === 'inactive') {
      throw new Error('InvalidStateError');
    }
    this.state = 'inactive';
    if (this.silent) {
      return;
    }
    // A later task, on purpose. See the class comment.
    setTimeout(() => {
      if (this.tail) {
        this.ondataavailable?.({ data: new Blob([this.tail]) });
      }
      this.onstop?.();
    }, 0);
  }

  /** One timeslice boundary: the recorder handing over the second it just recorded. */
  emit(bytes: number[]): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }

  /** A timeslice that produced nothing — silence, or a device hiccup. */
  emitEmpty(): void {
    this.ondataavailable?.({ data: new Blob([]) });
  }

  /** The recorder giving up on its own. */
  fail(): void {
    this.onerror?.();
  }
}

describe('AudioRecorderService', () => {
  let db: TerenDb;
  let store: EntryStore;
  let service: AudioRecorderService;
  let stream: FakeStream;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let entryId: string;

  /** A capture session on disk, because a chunk with no session is dropped by design. */
  async function openSession(): Promise<string> {
    const id = crypto.randomUUID();
    await store.beginCapture({
      entryId: id,
      project: TEST_PROJECT,
      capturedAt: new Date().toISOString(),
      mimeType: MIME,
    });
    return id;
  }

  function chunkBytes(): Promise<Uint8Array[]> {
    return db.chunks
      .where('entryId')
      .equals(entryId)
      .toArray()
      .then((chunks) =>
        Promise.all(
          chunks
            .sort((a, b) => a.seq - b.seq)
            .map(async (chunk) => new Uint8Array(await chunk.blob.arrayBuffer())),
        ),
      );
  }

  beforeEach(async () => {
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.refuseMimeType = null;
    stream = new FakeStream();
    getUserMedia = vi.fn().mockResolvedValue(stream);

    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });

    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    TestBed.configureTestingModule({ providers: [{ provide: TEREN_DB, useValue: db }] });
    store = TestBed.inject(EntryStore);
    service = TestBed.inject(AudioRecorderService);
    entryId = await openSession();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    db.close();
    await db.delete();
  });

  describe('start', () => {
    it('asks for mono 16 kHz, records to the negotiated container, and says it is recording', async () => {
      await expect(service.start(entryId, MIME)).resolves.toBe(true);

      expect(service.state()).toBe('recording');
      expect(service.entryId()).toBe(entryId);
      // Mono at 16 kHz is what the STT providers want (ARCHITECTURE §5). Both are hints a
      // platform may ignore, which is why the server normalises — but asking is not optional.
      expect(getUserMedia.mock.calls[0][0].audio).toMatchObject({
        channelCount: 1,
        sampleRate: 16_000,
        noiseSuppression: true,
      });
      expect(FakeMediaRecorder.last().mimeType).toBe(MIME);
    });

    /**
     * **The durability contract, in one assertion.**
     *
     * `start(timeslice)` is what makes `MediaRecorder` hand over audio *while* it records rather
     * than only at stop. Called with no argument it keeps everything in memory until the end, so a
     * tab the OS discards at minute three loses all three minutes instead of one second.
     */
    it('starts the recorder on a timeslice, so a discarded tab loses one second at most', async () => {
      await service.start(entryId, MIME);

      expect(FakeMediaRecorder.last().timeslice).toBe(CHUNK_INTERVAL_MS);
    });

    it('reads a refused microphone as denied, and claims no capture', async () => {
      getUserMedia.mockRejectedValue(deviceError('NotAllowedError'));

      await expect(service.start(entryId, MIME)).resolves.toBe(false);

      expect(service.state()).toBe('denied');
      // Nothing was ever recorded into this session, so it must not read as the live capture —
      // `RescueService` exempts whatever this names, and an empty session held exempt for the
      // life of the tab is a session nothing ever cleans up.
      expect(service.entryId()).toBeNull();
    });

    it.each([
      ['NotFoundError', 'unavailable'],
      ['NotReadableError', 'unavailable'],
      ['SecurityError', 'denied'],
      ['AbortError', 'error'],
    ])('reads a %s from the device as %s', async (name, expected) => {
      getUserMedia.mockRejectedValue(deviceError(name));

      await expect(service.start(entryId, MIME)).resolves.toBe(false);
      expect(service.state()).toBe(expected);
    });

    it('reads a browser with no MediaRecorder as unsupported, without touching the device', async () => {
      // An old WebView, or a page served over plain HTTP.
      vi.stubGlobal('MediaRecorder', undefined);

      await expect(service.start(entryId, MIME)).resolves.toBe(false);

      expect(service.state()).toBe('unsupported');
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    /**
     * A device that reports a type as supported and then refuses it in the constructor is a real
     * Android behaviour. Falling back to whatever it will give us keeps the take; the actual
     * container is read off the instance at stop, so the server is never told the wrong thing.
     */
    it('falls back to the platform default when the negotiated type is refused', async () => {
      FakeMediaRecorder.refuseMimeType = MIME;

      await expect(service.start(entryId, MIME)).resolves.toBe(true);

      expect(FakeMediaRecorder.last().mimeType).toBe('audio/webm');
    });

    it('will not attach a second recorder to a take already running', async () => {
      await service.start(entryId, MIME);

      await expect(service.start(entryId, MIME)).resolves.toBe(true);

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(FakeMediaRecorder.instances).toHaveLength(1);
    });
  });

  describe('while recording', () => {
    it('writes every timeslice to the store in order, and counts them on the session', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();

      recorder.emit([1, 1]);
      recorder.emit([2, 2]);
      recorder.emit([3, 3]);
      await waitUntil(async () => (await db.chunks.count()) === 3, {
        describe: 'three timeslices to reach the store',
      });

      expect(await chunkBytes()).toEqual([
        new Uint8Array([1, 1]),
        new Uint8Array([2, 2]),
        new Uint8Array([3, 3]),
      ]);
      // `chunkCount` can never promise a chunk that is not there: it is bumped in the same
      // transaction that writes the blob.
      expect((await db.captures.get(entryId))?.chunkCount).toBe(3);
    });

    it('ignores a timeslice that produced no bytes', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();

      recorder.emitEmpty();
      recorder.emit([1, 1]);
      await waitUntil(async () => (await db.chunks.count()) === 1, {
        describe: 'the one real timeslice to reach the store',
      });

      expect(await chunkBytes()).toEqual([new Uint8Array([1, 1])]);
    });

    /**
     * A chunk that cannot be written must not stop the recording. The rest of the take is still
     * worth having, and the assembled blob is simply that much shorter — the alternative is
     * abandoning a man's whole afternoon because one IndexedDB write hit a quota.
     */
    it('keeps recording when a chunk cannot be written', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();
      const append = vi.spyOn(store, 'appendChunk');
      append.mockRejectedValueOnce(new Error('quota exceeded'));

      recorder.emit([1, 1]);
      recorder.emit([2, 2]);
      await service.flush();

      expect(service.state()).toBe('recording');
      expect(await chunkBytes()).toEqual([new Uint8Array([2, 2])]);
    });
  });

  describe('stop', () => {
    it('waits for the recorder to hand over its last words before releasing anything', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();
      recorder.emit([1, 1]);
      await service.flush();

      const finished = await service.stop();

      // The tail — everything since the last timeslice, delivered after `stop()` returned — is on
      // disk, and it is on disk *by the time stop() resolves*, which is what lets the screen
      // assemble the take on the very next line.
      expect(await chunkBytes()).toEqual([new Uint8Array([1, 1]), new Uint8Array([9, 9])]);
      // Read off the instance, not from what we asked for: the recorder reports what it is really
      // producing.
      expect(finished?.mimeType).toBe(MIME);
      expect(finished?.durationMs).toBeGreaterThanOrEqual(0);
      expect(service.state()).toBe('idle');
      // The device is released — a live track keeps the OS recording indicator on — and nothing
      // is exempt from the rescue sweep any more.
      expect(stream.tracks.every((track) => track.stopped)).toBe(true);
      expect(service.entryId()).toBeNull();
    });

    it('reports nothing at all when the take produced no audio', async () => {
      await service.start(entryId, MIME);
      FakeMediaRecorder.last().tail = null;

      await expect(service.stop()).resolves.toBeNull();

      // An empty recording is a mis-tap, not evidence: the caller discards the session rather
      // than writing an entry with nothing in it.
      expect(await db.chunks.count()).toBe(0);
    });

    it('answers null rather than throwing when nothing is recording', async () => {
      await expect(service.stop()).resolves.toBeNull();
    });

    /**
     * ## The case the re-entrancy guard is actually for
     *
     * `interrupt()`'s entry check reads as protection against the pair a dying device fires —
     * `track.onended` and `recorder.onerror` together — and against that pair it is untestable
     * here, because the fake recorder short-circuits the second on its own `state === 'inactive'`.
     * **This is the sequence that needs it:** the foreman presses stop, `stop()` is inside its wait
     * for the tail, and the recorder then errors. State is `stopping` and the recorder is already
     * inactive, so with the guard gone `finishInterruption` skips the wait, `pendingWrites`
     * resolves before the final `dataavailable` arrives, and `teardown()` nulls `ondataavailable` —
     * the tail is dropped and the screen ends on `interrupted` over a take the man finished
     * himself. Written by the reviewer; adopted verbatim in substance.
     */
    it('ignores a recorder error that arrives while stop() is already collecting the tail', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();
      recorder.emit([1, 1]);
      await service.flush();

      const stopping = service.stop();
      recorder.fail();
      const finished = await stopping;

      expect(finished).not.toBeNull();
      expect(service.state()).toBe('idle');
      expect(await chunkBytes()).toEqual([new Uint8Array([1, 1]), new Uint8Array([9, 9])]);
    });

    /**
     * The same staleness as the interruption case below, on the other release path.
     *
     * "Otkaži" is live throughout `stopping` (`capture-recording-page.html`), so a foreman who
     * presses stop, changes his mind and records again leaves this continuation resuming into a
     * take that is not his. It must release nothing and report nothing.
     */
    it('does not release the next take when a cancelled stop resumes late', async () => {
      // Opened before the clock is faked: `fake-indexeddb` needs real timers to settle a
      // transaction, so a Dexie write inside the fake-timer window never completes.
      const second = await openSession();
      await service.start(entryId, MIME);
      FakeMediaRecorder.last().silent = true;
      vi.useFakeTimers();

      const stopping = service.stop();
      service.cancel();
      const fresh = new FakeStream();
      getUserMedia.mockResolvedValue(fresh);
      await expect(service.start(second, MIME)).resolves.toBe(true);

      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS + 10);

      // Null, not a duration: the take it was reporting on was thrown away.
      await expect(stopping).resolves.toBeNull();
      expect(service.state()).toBe('recording');
      expect(service.entryId()).toBe(second);
      expect(fresh.tracks[0].stopped).toBe(false);
    });

    /**
     * A recorder that never fires `onstop` — it happens on old WebViews — must not hold the screen
     * for ever. Every chunk before the last one is already on disk, so giving up costs at most one
     * timeslice, and the foreman gets his saved screen.
     */
    it('gives up on a recorder that never reports it stopped, after the bounded wait', async () => {
      await service.start(entryId, MIME);
      FakeMediaRecorder.last().silent = true;
      vi.useFakeTimers();

      const stopping = service.stop();
      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS - 1);
      // Still waiting: the wait is real, not a formality.
      expect(service.state()).toBe('stopping');

      await vi.advanceTimersByTimeAsync(1);
      await expect(stopping).resolves.toBeNull();
      expect(service.state()).toBe('idle');
    });
  });

  describe('an interruption', () => {
    /**
     * ## The last second of the take a foreman cannot repeat
     *
     * `stop()` has waited for the recorder's final `dataavailable` since B2. `interrupt()` did
     * not: it called `stop()` and tore down synchronously, nulling `ondataavailable` before that
     * event could arrive, **so every OS interruption silently lost up to a whole timeslice**. And
     * an interruption is precisely the take where that hurts most — the foreman did not end it,
     * so he does not know where it stopped and cannot say the missing words again.
     */
    it('keeps the recorder’s last words when the OS takes the microphone away', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();
      recorder.emit([1, 1]);
      await service.flush();

      stream.tracks[0].end();
      await waitUntil(() => service.state() === 'interrupted', {
        describe: 'the interruption to resolve',
      });

      expect(await chunkBytes()).toEqual([new Uint8Array([1, 1]), new Uint8Array([9, 9])]);
      expect(stream.tracks[0].stopped).toBe(true);
    });

    /**
     * The state is claimed synchronously even though the release is not.
     *
     * `stopping` is a state neither `stop()`, `start()` nor a second `onended`/`onerror` will act
     * on, which is the re-entrancy guard the old synchronous state check gave for free. Losing it
     * would matter: a device ending a track and the recorder erroring are two events that
     * routinely fire together.
     */
    it('claims the interruption at once, and only once', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();

      stream.tracks[0].end();
      expect(service.state()).toBe('stopping');
      // The second event of the pair, and a stray `stop()` from a screen that has not re-rendered.
      recorder.fail();
      await expect(service.stop()).resolves.toBeNull();

      await waitUntil(() => service.state() === 'interrupted', {
        describe: 'the interruption to resolve',
      });
      expect(recorder.stopCalls).toBe(1);
      // One tail, not two: the second entry into the release path would have written it again.
      expect(await chunkBytes()).toEqual([new Uint8Array([9, 9])]);
    });

    it('freezes the timer at the truth instead of letting it climb over a dead microphone', async () => {
      await service.start(entryId, MIME);

      FakeMediaRecorder.last().fail();

      const frozen = service.lastDurationMs();
      expect(service.elapsedMs()).toBe(frozen);
      await waitUntil(() => service.state() === 'interrupted', {
        describe: 'the interruption to resolve',
      });
      // Unmoved across the whole wait for the recorder's last words.
      expect(service.elapsedMs()).toBe(frozen);
      expect(service.lastDurationMs()).toBe(frozen);
    });

    it('does not interrupt a take that has already finished', async () => {
      await service.start(entryId, MIME);
      await service.stop();

      stream.tracks[0].end();

      expect(service.state()).toBe('idle');
    });

    /**
     * ## A stale continuation must not tear down the take that replaced it
     *
     * The wait for the tail is up to {@link STOP_TIMEOUT_MS}, and "Otkaži" is live throughout —
     * `capture-recording-page.html` puts no `[disabled]` on it during `stopping`, deliberately, so
     * a foreman is never trapped behind a recorder that has stopped answering. So this is an
     * ordinary sequence, not a contrivance: interrupted → cancel → record again → **then** the
     * first recorder's `onstop` arrives.
     *
     * Without a take number to check, that continuation resumes and calls `teardown()`, which
     * stops the **new** take's tracks, nulls its handlers, empties its `entryId` — so the rescue
     * sweep stops exempting it — and paints `interrupted` over a recording that is running. A dead
     * microphone under a live timer, caused by the take before it. Written by the reviewer;
     * adopted verbatim in substance.
     */
    it('a cancelled interruption does not tear down the take started right after it', async () => {
      const second = await openSession();
      await service.start(entryId, MIME);
      const first = FakeMediaRecorder.last();

      stream.tracks[0].end();
      expect(service.state()).toBe('stopping');
      service.cancel();
      expect(service.state()).toBe('idle');

      const fresh = new FakeStream();
      getUserMedia.mockResolvedValue(fresh);
      await expect(service.start(second, MIME)).resolves.toBe(true);
      expect(service.state()).toBe('recording');
      expect(FakeMediaRecorder.last()).not.toBe(first);

      // Let the first recorder's later task (tail + onstop) arrive.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(service.state()).toBe('recording');
      expect(service.entryId()).toBe(second);
      expect(fresh.tracks[0].stopped).toBe(false);
    });

    /**
     * The same, with the recorder that never answers: the continuation is released by the bounded
     * timeout instead of by `onstop`, and must still find that it no longer owns anything.
     */
    it('holds its hands off the new take even when the wait ends in the timeout', async () => {
      // Before the clock is faked — see the sibling spec on the `stop()` path.
      const second = await openSession();
      await service.start(entryId, MIME);
      FakeMediaRecorder.last().silent = true;
      vi.useFakeTimers();
      stream.tracks[0].end();
      expect(service.state()).toBe('stopping');

      service.cancel();
      const fresh = new FakeStream();
      getUserMedia.mockResolvedValue(fresh);
      await expect(service.start(second, MIME)).resolves.toBe(true);

      await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS + 10);

      expect(service.state()).toBe('recording');
      expect(service.entryId()).toBe(second);
      expect(fresh.tracks[0].stopped).toBe(false);
    });
  });

  describe('cancel', () => {
    /**
     * The one path that throws captured audio away, and it is deliberately the *only* one that
     * does not wait for the recorder's last words: the take was explicitly refused, so a tail
     * chunk would be one more byte for the caller to delete. The chunks already on disk are left
     * exactly where they are — `EntryStore.discardCapture` removes them, in one transaction, and
     * nothing here decides that.
     */
    it('releases the device at once and leaves the chunks for the caller to discard', async () => {
      await service.start(entryId, MIME);
      const recorder = FakeMediaRecorder.last();
      recorder.emit([1, 1]);
      await service.flush();

      service.cancel();

      expect(service.state()).toBe('idle');
      expect(service.entryId()).toBeNull();
      expect(stream.tracks[0].stopped).toBe(true);
      // Give the recorder's later task the chance to arrive; it must find nothing listening.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await chunkBytes()).toEqual([new Uint8Array([1, 1])]);
    });

    it('is safe when there is nothing to cancel', () => {
      expect(() => service.cancel()).not.toThrow();
      expect(service.state()).toBe('idle');
    });
  });

  describe('reset', () => {
    it('clears a refusal so the screen can offer another attempt', async () => {
      getUserMedia.mockRejectedValue(deviceError('NotAllowedError'));
      await service.start(entryId, MIME);

      service.reset();

      expect(service.state()).toBe('idle');
    });

    it('refuses to clear a state a live take is in', async () => {
      await service.start(entryId, MIME);

      service.reset();

      expect(service.state()).toBe('recording');
    });
  });
});
