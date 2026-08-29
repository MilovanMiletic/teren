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
  /** The capture currently on disk, if any. */
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
    const durationMs = Math.round(performance.now() - this.startedAt);
    // Read from the recorder instance: it reports what it is really producing, which is not
    // necessarily what we asked for.
    const mimeType = recorder.mimeType || 'application/octet-stream';

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      // A recorder that never fires `onstop` must not hang the screen forever; the chunks are on
      // disk either way.
      setTimeout(resolve, 2000);
    });
    try {
      recorder.stop();
    } catch {
      // Already inactive — the awaited timeout below releases us.
    }
    await finished;
    await this.pendingWrites;

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
   */
  private interrupt(): void {
    if (this.stateSignal() !== 'recording' && this.stateSignal() !== 'starting') {
      return;
    }
    this.frozenDurationMs = this.startedAt ? Math.round(performance.now() - this.startedAt) : 0;
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        // The device is already gone; the chunks it produced are not.
      }
    }
    this.teardown();
    this.stateSignal.set('interrupted');
  }

  private teardown(): void {
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
