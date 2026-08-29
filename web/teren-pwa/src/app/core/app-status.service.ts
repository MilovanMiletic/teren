import { Injectable, signal } from '@angular/core';

/**
 * Whether the app can do its job on this device.
 *
 * The one thing Teren cannot work without is somewhere to put the evidence. IndexedDB can be
 * absent or refuse to open — a private window, an exhausted quota, a locked-down WebView — and
 * when it does, the honest answer is to boot anyway and say so, never to record into a void or
 * to show a blank screen because bootstrap threw.
 */
@Injectable({ providedIn: 'root' })
export class AppStatus {
  private readonly storage = signal(true);

  /** False when the local store could not be opened. */
  readonly storageAvailable = this.storage.asReadonly();

  reportStorageFailure(): void {
    this.storage.set(false);
  }
}
