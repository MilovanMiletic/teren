import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate, VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';

import { AudioRecorderService, RecorderState } from '../media/audio-recorder.service';
import { AppUpdateService } from './app-update.service';

/**
 * A service worker, from this service's side: a stream of version events and an activation that
 * can be watched or made to fail.
 */
class FakeSwUpdate {
  readonly versionUpdates = new Subject<VersionEvent>();
  activations = 0;
  activationFails = false;

  async activateUpdate(): Promise<boolean> {
    this.activations += 1;
    if (this.activationFails) {
      throw new Error('the worker went away mid-swap');
    }
    return true;
  }

  ready(hash = 'v2'): void {
    this.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'v1' },
      latestVersion: { hash },
    } as VersionEvent);
  }
}

/**
 * Only the one signal this service reads — and it really is a **signal**.
 *
 * A plain method returning a field would make every assertion below pass for the wrong reason:
 * `offered()` is a `computed`, so it would cache the first answer and never see the recorder
 * change. The first version of this fake did exactly that, and the spec that caught it is the one
 * where a take *ends*.
 */
class FakeRecorder {
  private readonly current = signal<RecorderState>('idle');
  readonly state = this.current.asReadonly();
  set(state: RecorderState): void {
    this.current.set(state);
  }
}

describe('AppUpdateService', () => {
  let worker: FakeSwUpdate;
  let recorder: FakeRecorder;
  let service: AppUpdateService;
  let reload: ReturnType<typeof vi.spyOn>;

  function build(): void {
    worker = new FakeSwUpdate();
    recorder = new FakeRecorder();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SwUpdate, useValue: worker as unknown as SwUpdate },
        { provide: AudioRecorderService, useValue: recorder as unknown as AudioRecorderService },
      ],
    });
    service = TestBed.inject(AppUpdateService);
    // The one line in the app that throws the running page away. jsdom refuses to implement it,
    // which is exactly why it is a seam on the service rather than a call inlined into `apply`.
    reload = vi.spyOn(service as unknown as { reload(): void }, 'reload').mockImplementation(() => {
      /* the page would be gone */
    });
  }

  beforeEach(() => build());

  it('says nothing until a new version is actually installed and waiting', () => {
    expect(service.offered()).toBe(false);

    // A download starting is not news anybody can act on, and neither is one that failed.
    const detected = { type: 'VERSION_DETECTED', version: { hash: 'v2' } } as VersionEvent;
    worker.versionUpdates.next(detected);
    expect(service.offered()).toBe(false);
  });

  it('offers the new build once it is ready', () => {
    worker.ready();
    expect(service.offered()).toBe(true);
  });

  /**
   * **The rule the whole feature is built around.**
   *
   * Everything else this app holds is in Dexie before it is anywhere else, so a reload costs
   * nothing — the queue, the chunks, the draft all survive it. A live `MediaRecorder` is the one
   * thing that does not, and it is thirty seconds of a man's afternoon. So the card does not even
   * appear while the microphone is live, let alone reload anything.
   */
  it('stays off the screen entirely while a recording is running', () => {
    recorder.set('recording');
    worker.ready();

    expect(service.offered()).toBe(false);
  });

  it('waits through the permission sheet too, and comes back when the take is over', () => {
    // `starting` is the sheet a man with muddy hands is looking for the Allow button on.
    recorder.set('starting');
    worker.ready();
    expect(service.offered()).toBe(false);

    recorder.set('stopping');
    expect(service.offered()).toBe(false);

    recorder.set('idle');
    expect(service.offered()).toBe(true);
  });

  it('never reloads on its own — the reload is a press', async () => {
    worker.ready();
    expect(reload).not.toHaveBeenCalled();
    expect(worker.activations).toBe(0);

    await service.apply();

    expect(worker.activations).toBe(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when activation fails, because the button promised it would', async () => {
    // A blip mid-swap leaves the old build running and the new one still on the device. Reloading
    // is correct and safe either way; refusing would leave a pressed button doing nothing.
    worker.ready();
    worker.activationFails = true;

    await service.apply();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once however many times the button is pressed', async () => {
    worker.ready();

    await Promise.all([service.apply(), service.apply(), service.apply()]);

    expect(worker.activations).toBe(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('remembers a "not now" — until there is a newer version to ask about', () => {
    worker.ready('v2');
    service.decline();
    expect(service.offered()).toBe(false);

    // A card he has already declined re-appearing on every navigation is how an app gets deleted.
    worker.ready('v2');
    expect(service.offered()).toBe(true);
  });

  it('does not exist for a browser with no service worker at all', () => {
    // `provideServiceWorker` supplies SwUpdate even disabled, but a spec, or a bootstrap that
    // drops the worker, must not turn a missing provider into a blank app.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AudioRecorderService,
          useValue: new FakeRecorder() as unknown as AudioRecorderService,
        },
      ],
    });

    expect(() => TestBed.inject(AppUpdateService).offered()).not.toThrow();
    expect(TestBed.inject(AppUpdateService).offered()).toBe(false);
  });
});
