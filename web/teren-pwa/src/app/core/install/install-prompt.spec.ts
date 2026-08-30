import { InstallPromptCapture } from './install-prompt';

/**
 * A `beforeinstallprompt` as the browser would fire it: a real, cancellable DOM event carrying
 * the two extras Chromium adds. Cancellable matters — `defaultPrevented` is the only way to prove
 * from a spec that the mini-infobar was actually suppressed.
 */
function installPromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): {
  event: BeforeInstallPromptEvent;
  prompts: () => number;
} {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
  let prompts = 0;
  Object.assign(event, {
    platforms: ['web'],
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
    prompt: () => {
      prompts += 1;
      return Promise.resolve();
    },
  });
  return { event, prompts: () => prompts };
}

describe('InstallPromptCapture', () => {
  it('suppresses the browser mini-infobar and keeps the offer', () => {
    const capture = new InstallPromptCapture();
    capture.watch(window);
    expect(capture.available()).toBe(false);

    const { event } = installPromptEvent();
    window.dispatchEvent(event);

    // The mini-infobar would otherwise cover the record button, which is the one thing on Home
    // nothing may sit on top of.
    expect(event.defaultPrevented).toBe(true);
    expect(capture.available()).toBe(true);
  });

  it('hands the offer over exactly once — the event is single-use', () => {
    const capture = new InstallPromptCapture();
    capture.watch(window);
    const { event } = installPromptEvent();
    window.dispatchEvent(event);

    expect(capture.take()).toBe(event);
    expect(capture.take()).toBeNull();
    expect(capture.available()).toBe(false);
  });

  it('tells subscribers when an offer arrives, is taken, or is completed', () => {
    const capture = new InstallPromptCapture();
    capture.watch(window);
    let calls = 0;
    const unsubscribe = capture.subscribe(() => (calls += 1));

    window.dispatchEvent(installPromptEvent().event);
    expect(calls).toBe(1);

    capture.take();
    expect(calls).toBe(2);

    window.dispatchEvent(new Event('appinstalled'));
    expect(calls).toBe(3);
    expect(capture.installed()).toBe(true);

    unsubscribe();
    window.dispatchEvent(installPromptEvent().event);
    expect(calls).toBe(3);
  });

  it('drops a pending offer once the app is installed', () => {
    const capture = new InstallPromptCapture();
    capture.watch(window);
    window.dispatchEvent(installPromptEvent().event);

    window.dispatchEvent(new Event('appinstalled'));

    // An app that has just been installed must not still be inviting an install.
    expect(capture.available()).toBe(false);
    expect(capture.installed()).toBe(true);
  });

  it('is idempotent — watching twice does not double every notification', () => {
    const capture = new InstallPromptCapture();
    capture.watch(window);
    capture.watch(window);
    let calls = 0;
    capture.subscribe(() => (calls += 1));

    window.dispatchEvent(installPromptEvent().event);

    expect(calls).toBe(1);
  });
});
