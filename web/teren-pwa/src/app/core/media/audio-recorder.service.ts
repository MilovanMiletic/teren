import { Injectable, inject, signal } from '@angular/core';

import { EntryStore } from '../db/entry-store';
import { negotiateAudioMimeType } from './audio-mime';

export type RecorderState =
  | 'idle'
  /** Waiting for the microphone permission prompt. */
  | 'starting'
  | 'recording'
  | 'stopping'
  /** The user (or the OS) refused the microphone. Recoverable: they can try again. */
  | 'denied'
  /** There is no microphone, or it is taken by another app. */
  | 'unavailable'
  /** The browser has no MediaRecorder — an old WebView, or a page served over plain HTTP. */
  | 'unsupported'
  /**
   * The recording was cut short by something outside the app: an incoming call taking the
   * microphone, the device revoking the track, the recorder itself erroring. Whatever was
   * captured up to that moment is already on disk.
   */
  | 'interrupted'
  | 'error';

/** How many bars the level meter keeps; matches the waveform in `design/CaptureRecording`. */
export const LEVEL_BAR_COUNT = 14;

/** One second of audio per chunk: the most a crash can cost. */
export const CHUNK_INTERVAL_MS = 1000;

/**
 * How long either stop path waits for the recorder's final `dataavailable` before giving up on it.
 *
 * `MediaRecorder.stop()` emits the tail of the recording — everything since the last timeslice —
 * on a later task, so both `stop()` and an interruption have to wait for it or lose it. A
 * recorder that never fires `onstop` (it happens on old WebViews) must not hold the screen for
 * ever, and every chunk before the last one is already on disk, so the wait is bounded and
 * failing it costs at most one timeslice.
 */
export const STOP_TIMEOUT_MS = 2000;

/** What a finished recording turned out to be. The bytes are already in the store. */
export interface FinishedRecording {
  durationMs: number;
  mimeType: string;
}

/**
 * Voice recording.
 *
 * Three things this service refuses to do:
 *
 * - **Hold evidence in memory.** Every chunk `MediaRecorder` hands over is written to Dexie as it
 *   arrives, under the entry id minted before recording started. A tab discarded at minute three
 *   loses at most the last second, and the start-up sweep assembles the rest into a draft. An
 *   in-memory array would have lost all three minutes.
 * - **Assume a container.** The MIME type is negotiated per device and stored with the audio
 *   (ARCHITECTURE.md §5).
 * - **Fail silently.** Denial, a missing microphone and an interruption are all states the screen
 *   can render, never exceptions swallowed into an empty screen.
 *
 * Provided in root so a recording survives navigation: the microphone is a device resource, not a
 * property of whichever screen is on top.
 */
@Injectable({ providedIn: 'root' })
export class AudioRecorderService {
  private readonly entries = inject(EntryStore);

  private readonly stateSignal = signal<RecorderState>('idle');
  private readonly elapsedSignal = signal(0);
  private readonly levelsSignal = signal<number[]>(new Array(LEVEL_BAR_COUNT).fill(0.12));
  private readonly entryIdSignal = signal<string | null>(null);

  /** What the recorder is doing right now. */
  readonly state = this.stateSignal.asReadonly();
  /** Milliseconds recorded so far, for the timer. */
  readonly elapsedMs = this.elapsedSignal.asReadonly();
  /** Normalised 0..1 levels, newest last — the live waveform. */
  readonly levels = this.levelsSignal.asReadonly();
  /**
   * The capture the microphone is filling right now, or null.
   *
   * **`RescueService` reads this to decide what it may not sweep**, so the null matters as much as
   * the value. It is set before the first chunk can arrive and cleared in {@link teardown}, once
   * the device is released and every chunk handed over is on disk — a window that deliberately
   * covers `stop()`'s wait for the final `dataavailable`, which is the two seconds in which a
   * sweep would do the most damage.
   *
   * It must not linger after that. The same list goes to the abandoned-draft sweep, and an id
   * still named there an hour later is a forgotten draft that never reaches the queue.
   */
  readonly entryId = this.entryIdSignal.asReadonly();

  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private startedAt = 0;
  private frozenDurationMs = 0;
  private chunkCount = 0;
  private pendingWrites: Promise<unknown> = Promise.resolve();
  private tick: ReturnType<typeof setInterval> | null = null;
  private meter: LevelMeter | null = null;

  /**
   * Which take owns the microphone. Bumped when one is adopted ({@link start}) and when one is
   * released ({@link teardown}), so no two takes ever wear the same number.
   *
   * **Both release paths await, and an await is where a take can stop being the current one.**
   * `stop()` and `finishInterruption()` each wait up to {@link STOP_TIMEOUT_MS} for the recorder's
   * final `dataavailable`, and the screen offers "Otkaži" throughout: cancel tears the take down,
   * the foreman starts another, and *then* the first recorder's `onstop` arrives. Without a number
   * to check, that stale continuation resumes and calls `teardown()` — which stops the **new**
   * take's tracks, nulls its handlers, empties its `entryId` and (from the interruption path) sets
   * `interrupted` over a recording that is running. A dead microphone under a live timer, caused
   * by the take before it.
   *
   * So both continuations capture this on entry and compare after every wait. A take that is no
   * longer current writes nothing at all: whatever it was going to release has already been
   * released by whoever took over.
   */
  private take = 0;

  /**
   * Ask for the microphone and start recording into the capture session already opened for
   * `entryId`. Resolves `true` when audio is being captured; on `false` the reason is in
   * `state()`.
   */
  async start(entryId: string, mimeType: string | null): Promise<boolean> {
    const state = this.stateSignal();
    // Starting while the previous take is still being flushed would attach a second recorder to
    // the same session and interleave its chunks.
    if (state === 'recording' || state === 'starting' || state === 'stopping') {
      return state === 'recording';
    }

    if (
      typeof MediaRecorder === 'undefined' ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      this.stateSignal.set('unsupported');
      return false;
    }

    this.stateSignal.set('starting');
    // This take's number, from here until something releases it. Any continuation still holding
    // an older one has been superseded and must keep its hands off the device.
    this.take += 1;
    this.entryIdSignal.set(entryId);
    this.chunkCount = 0;
    this.frozenDurationMs = 0;
    this.pendingWrites = Promise.resolve();
    this.elapsedSignal.set(0);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Mono at 16 kHz is what the STT providers want; both are hints the platform may ignore,
        // which is fine — the server normalises.
        audio: {
          channelCount: 1,
          sampleRate: 16_000,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      // Nothing was ever recorded into this session, so it is not the live capture and must not
      // read as one: the caller discards it, and until it does the sweep may have it.
      this.entryIdSignal.set(null);
      this.stateSignal.set(classifyGetUserMediaError(error));
      return false;
    }

    try {
      this.recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        // Opus is efficient enough that 32 kbps mono is comfortably intelligible speech
        // (~240 KB/minute). Other containers keep the platform default rather than being
        // starved at a bitrate meant for Opus.
        ...(mimeType?.includes('opus') ? { audioBitsPerSecond: 32_000 } : {}),
      });
    } catch {
      // A device that reported the type as supported but refuses it in the constructor: fall
      // back to whatever it wants to give us rather than losing the recording entirely.
      try {
        this.recorder = new MediaRecorder(stream);
      } catch {
        stopTracks(stream);
        this.entryIdSignal.set(null);
        this.stateSignal.set('error');
        return false;
      }
    }

    this.stream = stream;

    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunkCount += 1;
        // Serialised, so chunks reach the store in the order the recorder produced them, and
        // tracked so `stop()` can wait for the last write instead of racing it.
        this.pendingWrites = this.pendingWrites
          .then(() => this.entries.appendChunk(entryId, event.data))
          .catch(() => {
            // A failed chunk write must not stop the recording: the rest of the take is still
            // worth having, and the assembled blob is simply that much shorter.
          });
      }
    };

    // The recorder giving up is not the same as the user stopping, and must never look like it.
    this.recorder.onerror = () => this.interrupt();
    // An incoming call, or the OS handing the microphone to another app, ends the track.
    for (const track of stream.getAudioTracks()) {
      track.onended = () => this.interrupt();
    }

    this.recorder.start(CHUNK_INTERVAL_MS);
    this.startedAt = performance.now();
    this.stateSignal.set('recording');

    this.tick = setInterval(() => {
      this.elapsedSignal.set(Math.round(performance.now() - this.startedAt));
    }, 100);

    this.meter = LevelMeter.attach(stream, (levels) => this.levelsSignal.set(levels));

    return true;
  }

  /**
   * Finish the recording and report what was captured. The audio itself is already in the store,
   * chunk by chunk; this only stops the device and waits for the last write to land.
   */
  async stop(): Promise<FinishedRecording | null> {
    const recorder = this.recorder;
    if (!recorder || this.stateSignal() !== 'recording') {
      return null;
    }

    this.stateSignal.set('stopping');
    const take = this.take;
    const durationMs = Math.round(performance.now() - this.startedAt);
    // Read from the recorder instance: it reports what it is really producing, which is not
    // necessarily what we asked for.
    const mimeType = recorder.mimeType || 'application/octet-stream';

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      // A recorder that never fires `onstop` must not hang the screen forever; the chunks are on
      // disk either way.
      setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    try {
      recorder.stop();
    } catch {
      // Already inactive — the awaited timeout below releases us.
    }
    await finished;
    await this.pendingWrites;

    if (take !== this.take) {
      // Cancelled while we waited, and another take already owns the microphone. Releasing it
      // now would stop the recording that is running; and reporting a duration for a take the
      // caller has thrown away would have him assemble chunks that are no longer there. Null is
      // the honest answer: this take is no longer ours to finish.
      return null;
    }

    const chunkCount = this.chunkCount;
    this.teardown();
    this.stateSignal.set('idle');

    return chunkCount === 0 ? null : { durationMs, mimeType };
  }

  /**
   * Abandon the recording. The chunks written so far belong to a take the user explicitly
   * refused, so the caller discards the capture session with them; nothing that ever became an
   * entry is touched.
   */
  cancel(): void {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // Already stopping; the teardown below is what matters.
      }
    }
    this.teardown();
    this.stateSignal.set('idle');
  }

  /** How long the last take ran, for a stop the user did not perform. */
  lastDurationMs(): number {
    return this.frozenDurationMs;
  }

  /** Clear a `denied` / `error` / `interrupted` state so the screen can offer another attempt. */
  reset(): void {
    const state = this.stateSignal();
    if (state !== 'recording' && state !== 'starting' && state !== 'stopping') {
      this.stateSignal.set('idle');
    }
  }

  /** Wait for every chunk handed over so far to be on disk. */
  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  /**
   * Something outside the app ended the recording. Freeze the timer at the truth, release the
   * device, and let the screen say so — a timer still climbing over a dead microphone is the
   * worst possible lie here.
   *
   * ## Why this is two methods, and why the second one waits
   *
   * `MediaRecorder.stop()` emits one last `dataavailable` — everything since the previous
   * timeslice — and it arrives on a later task, *after* this function's caller has returned. Until
   * 2026-09-02 this tore down synchronously, nulling `ondataavailable` on the way, so **every OS
   * interruption silently lost up to the last second of speech**: precisely the take a foreman
   * cares most about, because he did not end it and cannot repeat what he was saying. `stop()` has
   * waited for that event since B2; an interruption is the same problem and gets the same shape.
   *
   * What is claimed synchronously is the state — `stopping`, which neither {@link stop},
   * {@link start} nor a second `onended`/`onerror` will act on. That is the re-entrancy guard the
   * old state check gave for free and an awaited version would otherwise lose.
   *
   * **The entry check below is load-bearing, and the case that proves it is not the obvious one.**
   * A device ending its track and the recorder erroring do routinely fire together, but the fake
   * recorder in the specs short-circuits the second on its own `state === 'inactive'`, so that
   * pair alone leaves the guard untested. The path that genuinely needs it is `onerror` arriving
   * while a **user** `stop()` is already collecting the tail: state is `stopping`, the recorder is
   * already inactive, so without this check `finishInterruption` would skip the wait entirely,
   * `await pendingWrites` would resolve *before* the final `dataavailable`, and `teardown()` would
   * null `ondataavailable` and drop the tail — turning a clean stop into the very loss this pair
   * of methods exists to prevent, and ending on `interrupted` over a take the foreman finished
   * himself. `audio-recorder.service.spec.ts` pins exactly that sequence.
   */
  private interrupt(): void {
    const state = this.stateSignal();
    if (state !== 'recording' && state !== 'starting') {
      return;
    }
    this.frozenDurationMs = this.startedAt ? Math.round(performance.now() - this.startedAt) : 0;
    // The microphone is already dead, so the timer stops here rather than in `teardown()` — it
    // must not tick through the wait below, which is the whole point of freezing it at all.
    this.freezeTimer();
    this.stateSignal.set('stopping');
    void this.finishInterruption(this.take);
  }

  /** Collect the recorder's last words, then release it and say what happened. */
  private async finishInterruption(take: number): Promise<void> {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onerror = null;
      const finished = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        // A recorder that never fires `onstop` must not strand the screen in `stopping`; the same
        // bound wait `stop()` uses, for the same reason.
        setTimeout(resolve, STOP_TIMEOUT_MS);
      });
      try {
        recorder.stop();
      } catch {
        // The device is already gone; the chunks it produced are not.
      }
      await finished;
    }
    // Read after the wait, so the chain includes the write the final `dataavailable` queued.
    await this.pendingWrites;

    if (take !== this.take) {
      // "Otkaži" during the wait, then a fresh take. Tearing down here would stop the new take's
      // tracks and paint `interrupted` over a recording that is running — the worst lie this
      // service can tell, produced by the take before it. Everything this take held was released
      // by the cancel that superseded it.
      return;
    }

    this.teardown();
    this.stateSignal.set('interrupted');
  }

  /** Stop the elapsed timer where it stands, without releasing anything else. */
  private freezeTimer(): void {
    if (this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
    this.elapsedSignal.set(this.frozenDurationMs);
  }

  private teardown(): void {
    // The take that held this device is over, whoever ended it. Any release continuation still in
    // flight for it now holds a stale number and will write nothing — see {@link take}.
    this.take += 1;
    if (this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
    this.meter?.detach();
    this.meter = null;
    if (this.stream) {
      for (const track of this.stream.getAudioTracks()) {
        track.onended = null;
      }
      stopTracks(this.stream);
      this.stream = null;
    }
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onerror = null;
      this.recorder = null;
    }
    // Nothing is being recorded into any more, so nothing is exempt from the rescue sweep on this
    // account. See {@link entryId} for why leaving it set would cost a draft rather than a take.
    this.entryIdSignal.set(null);
    this.levelsSignal.set(new Array(LEVEL_BAR_COUNT).fill(0.12));
  }
}

function stopTracks(stream: MediaStream): void {
  // Leaving a track live keeps the OS recording indicator on and the microphone busy.
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function classifyGetUserMediaError(error: unknown): RecorderState {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'denied';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'NotReadableError') {
    return 'unavailable';
  }
  return 'error';
}

/**
 * The live level meter behind the waveform. Purely decorative — if the Web Audio API is missing
 * or blocked, the bars simply stay at rest and the recording is unaffected.
 */
class LevelMeter {
  static attach(stream: MediaStream, emit: (levels: number[]) => void): LevelMeter | null {
    const AudioCtx: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined' ? AudioContext : undefined;
    if (!AudioCtx || typeof requestAnimationFrame === 'undefined') {
      return null;
    }
    try {
      return new LevelMeter(new AudioCtx(), stream, emit);
    } catch {
      return null;
    }
  }

  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private readonly levels = new Array<number>(LEVEL_BAR_COUNT).fill(0.12);
  private frame: number | null = null;
  private lastEmit = 0;

  private constructor(
    private readonly context: AudioContext,
    stream: MediaStream,
    private readonly emit: (levels: number[]) => void,
  ) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  detach(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    try {
      this.source.disconnect();
      void this.context.close();
    } catch {
      // Nothing to recover: the meter is decoration.
    }
  }

  private loop(now: number): void {
    this.frame = requestAnimationFrame(this.loop);
    // ~12 fps is plenty for a bar meter and keeps the main thread free during capture.
    if (now - this.lastEmit < 80) {
      return;
    }
    this.lastEmit = now;

    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const sample of this.buffer) {
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / this.buffer.length);
    // Speech RMS sits around 0.05–0.2; the square root opens up that bottom end visually.
    const level = Math.min(1, Math.max(0.12, Math.sqrt(rms) * 1.8));

    this.levels.shift();
    this.levels.push(level);
    this.emit([...this.levels]);
  }
}
