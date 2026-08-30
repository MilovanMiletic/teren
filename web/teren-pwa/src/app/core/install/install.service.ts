import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { INSTALL_PROMPT_SOURCE } from './install-prompt';

/**
 * What, if anything, the app should say about installing itself.
 *
 * `prompt` — Chromium has an install offer in hand and one tap can take it.
 * `ios`    — Safari on iOS, which never fires that event and never offers anything: the gesture
 *            has to be named, or an iPhone foreman simply never installs.
 */
export type InstallInvitation = 'prompt' | 'ios';

/** Where a refusal is remembered. */
const DISMISSED_KEY = 'teren.install.dismissed';

/**
 * How long a "not now" lasts.
 *
 * Half a year. The failure mode being designed against is not "he never sees it again" — it is a
 * tool that asks a man the same question every morning until he stops opening it. He will change
 * phones before this window is up, and a new phone starts the whole story over anyway.
 */
const DISMISSAL_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The display modes an installed app can be running in.
 *
 * The manifest asks for `standalone`, but a browser may honour an install in `minimal-ui` or
 * `fullscreen`, and in every one of them the app is already installed. This list is what stops
 * the app from telling a foreman to install the app he is standing inside.
 */
const INSTALLED_DISPLAY_MODES = ['standalone', 'fullscreen', 'minimal-ui'] as const;

/**
 * Whether the app can still be installed here, and how.
 *
 * The reason this exists at all: without installing, there is no home-screen icon and no offline
 * cold start, and PROJECT.md §8 measures Phase 1 as *one foreman using it for three weeks without
 * being reminded*. A tab he has to find in a browser loses that bet. Nothing in the app said so
 * before this.
 */
@Injectable({ providedIn: 'root' })
export class InstallService {
  private readonly source = inject(INSTALL_PROMPT_SOURCE);

  private readonly installedSignal = signal(runningInstalled());
  private readonly availableSignal = signal(false);
  private readonly dismissedSignal = signal(dismissed());
  private readonly iosSignal = signal(isIosSafari());

  /** True when this page is already running as an installed app. */
  readonly installed = this.installedSignal.asReadonly();

  /**
   * The invitation to show, or null for silence — which is the answer on a desktop browser with
   * no offer, inside an installed app, and for anyone who has already said no.
   */
  readonly invitation = computed<InstallInvitation | null>(() => {
    if (this.installedSignal() || this.dismissedSignal()) {
      return null;
    }
    if (this.availableSignal()) {
      return 'prompt';
    }
    return this.iosSignal() ? 'ios' : null;
  });

  constructor() {
    this.readSource();
    const unsubscribe = this.source.subscribe(() => this.readSource());
    inject(DestroyRef).onDestroy(unsubscribe);
  }

  /**
   * Take the browser up on its offer.
   *
   * Returns what the user told the browser, or `unavailable` when there was no offer left to
   * make — a second tap on a stale card, or a browser that withdrew the event.
   */
  async install(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const event = this.source.take();
    // Either way the card is done: the offer is spent, and a card still reading "Install" while
    // the browser's own dialog is open is the app claiming something it no longer knows.
    this.availableSignal.set(false);
    if (!event) {
      return 'unavailable';
    }

    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'dismissed') {
        // He said no to the real dialog. That is the same no as the card's own, and asking again
        // tomorrow because the refusal happened one layer down would be exactly the nagging this
        // is written to prevent.
        this.dismiss();
      }
      return outcome;
    } catch {
      // A spent or rejected event. Nothing was installed and nothing was refused.
      return 'unavailable';
    }
  }

  /** "Not now" — remembered for {@link DISMISSAL_WINDOW_MS}. */
  dismiss(): void {
    this.dismissedSignal.set(true);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // Private mode: the refusal holds for this session and no longer. Still better than a
      // failed write taking the screen down.
    }
  }

  private readSource(): void {
    this.availableSignal.set(this.source.available());
    if (this.source.installed()) {
      this.installedSignal.set(true);
    }
  }
}

/** Whether this page is being shown by an installed app rather than by a browser tab. */
function runningInstalled(): boolean {
  if (typeof navigator !== 'undefined' && navigator.standalone === true) {
    return true;
  }
  // Guarded rather than assumed, as `ViewportService` does: a bare test environment has no
  // `matchMedia`, and a banner is not worth a boot failure.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return INSTALLED_DISPLAY_MODES.some(
    (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
  );
}

/**
 * Safari on iOS, where "Add to Home Screen" exists but nothing ever offers it.
 *
 * Deliberately narrow. Other iOS browsers and in-app webviews either bury the gesture somewhere
 * else or cannot install at all, and an instruction naming a Share button that is not on screen
 * is worse than no instruction: it is the app claiming to know something about a device it does
 * not know.
 */
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const agent = navigator.userAgent ?? '';
  // iPadOS 13+ reports itself as a Mac; the touch points are what give it away.
  const iPad = /Macintosh/.test(agent) && navigator.maxTouchPoints > 1;
  if (!/iPad|iPhone|iPod/.test(agent) && !iPad) {
    return false;
  }
  if (/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram/.test(agent)) {
    return false;
  }
  return /Safari/.test(agent);
}

/** Whether a refusal is still standing. */
function dismissed(now = Date.now()): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(DISMISSED_KEY);
  } catch {
    // No storage, no memory of a refusal. Nothing better is available.
    return false;
  }
  if (stored === null) {
    return false;
  }

  const at = Number(stored);
  // Something wrote a value here, so someone refused. If it cannot be read as a time, stay quiet
  // forever rather than risk asking again — silence is the safe direction for a guard on a nag.
  if (!Number.isFinite(at)) {
    return true;
  }
  return now - at < DISMISSAL_WINDOW_MS;
}
