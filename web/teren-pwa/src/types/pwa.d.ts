/**
 * Install-related platform types that no TypeScript `lib` ships.
 *
 * `beforeinstallprompt` is a Chromium-only event and `navigator.standalone` is an ancient WebKit
 * property, so neither is in `lib.dom.d.ts` (checked against the TypeScript in this repo). The
 * alternative to declaring them is `as any` at every call site, which would let a typo in
 * `userChoice` or a missing `await` on `prompt()` through the compiler — on the one code path
 * nobody here can exercise locally, because it needs a real Android phone.
 *
 * A global script file on purpose: no top-level `import`/`export`, so the interface merges into
 * the DOM lib rather than shadowing it in a module of its own.
 */

/**
 * Chromium's offer to install the app, fired when it decides the site is installable.
 *
 * The event must be `preventDefault()`ed to suppress the browser's own mini-infobar, and it is
 * single-use: `prompt()` may be called once, after which the event is spent and a new one only
 * arrives on a later page load.
 */
interface BeforeInstallPromptEvent extends Event {
  /** The install surfaces the browser could offer, e.g. `['web']`. */
  readonly platforms: readonly string[];
  /** Settles once the user has answered the browser's own install dialog. */
  readonly userChoice: Promise<{
    readonly outcome: 'accepted' | 'dismissed';
    readonly platform: string;
  }>;
  /** Shows the browser's install dialog. Resolves when the dialog has been presented. */
  prompt(): Promise<void>;
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
  /** Fired after the app has actually been installed, in the tab that offered it. */
  appinstalled: Event;
}

interface Navigator {
  /**
   * iOS only: true when the page is running from the home screen. Safari has never implemented
   * `display-mode`'s `standalone` reliably on older versions, and this is the property Apple
   * documents, so both are checked.
   */
  readonly standalone?: boolean;
}
