import { InjectionToken } from '@angular/core';

/**
 * The browser's install offer, caught before Angular exists.
 *
 * `beforeinstallprompt` fires once, is not replayed, and Chromium fires it as soon as it has
 * evaluated the manifest and the service worker — which on a repeat visit can easily be *before*
 * this app has finished booting. Bootstrap here waits on `ProjectService.load()` (a network call)
 * and Home is a lazy route, so a service that only starts listening when Home renders would miss
 * the event on exactly the phone that has been here before: the one belonging to the foreman we
 * need to install it.
 *
 * So the listener is registered from `main.ts`, before `bootstrapApplication`, and holds the event
 * until something asks for it. `InstallService` is the thing that asks.
 */
export interface InstallPromptSource {
  /** Whether an unspent install prompt is in hand. */
  available(): boolean;
  /** Whether the browser has reported an install completing while this page was open. */
  installed(): boolean;
  /**
   * Hand over the prompt, clearing it.
   *
   * Taking rather than reading, because the event is single-use: `prompt()` may be called once
   * and calling it twice throws. An offer that has been made is gone.
   */
  take(): BeforeInstallPromptEvent | null;
  /** Called whenever `available()` or `installed()` changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export class InstallPromptCapture implements InstallPromptSource {
  private prompt: BeforeInstallPromptEvent | null = null;
  private wasInstalled = false;
  private watching = false;
  private readonly listeners = new Set<() => void>();

  /** Start listening. Idempotent — calling it twice must not double every notification. */
  watch(target: Window): void {
    if (this.watching) {
      return;
    }
    this.watching = true;

    target.addEventListener('beforeinstallprompt', (event) => {
      // Suppresses Chromium's own mini-infobar. Without this the browser shows its banner over
      // the record button, which is the one place on this screen nothing may cover.
      event.preventDefault();
      this.prompt = event;
      this.announce();
    });

    target.addEventListener('appinstalled', () => {
      this.wasInstalled = true;
      // A spent offer. Keeping it would let the app invite an install it has just completed.
      this.prompt = null;
      this.announce();
    });
  }

  available(): boolean {
    return this.prompt !== null;
  }

  installed(): boolean {
    return this.wasInstalled;
  }

  take(): BeforeInstallPromptEvent | null {
    const event = this.prompt;
    this.prompt = null;
    if (event) {
      this.announce();
    }
    return event;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** The one capture for the app, watched from `main.ts` before anything Angular runs. */
export const installPromptCapture = new InstallPromptCapture();

/**
 * How `InstallService` reaches the capture — a token rather than the singleton directly, so a
 * spec supplies its own source instead of dispatching browser events at a shared `window`.
 */
export const INSTALL_PROMPT_SOURCE = new InjectionToken<InstallPromptSource>(
  'install-prompt-source',
  { providedIn: 'root', factory: () => installPromptCapture },
);
