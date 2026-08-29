import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/**
 * Whether the OS reports a network.
 *
 * `navigator.onLine` only ever proves the *absence* of a connection reliably — a phone on a site
 * Wi-Fi with no uplink still reports `true`. That is enough for what the UI needs it for: showing
 * the "no internet" card honestly. The sync loop (B3) decides whether to attempt an upload by
 * attempting it, not by trusting this flag.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly onlineSignal = signal(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  readonly online = this.onlineSignal.asReadonly();

  constructor() {
    if (typeof window === 'undefined') {
      return;
    }
    const goOnline = () => this.onlineSignal.set(true);
    const goOffline = () => this.onlineSignal.set(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    });
  }
}
