import { TestBed } from '@angular/core/testing';

import { INSTALL_PROMPT_SOURCE, InstallPromptSource } from './install-prompt';
import { InstallService } from './install.service';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) CriOS/125.0.0.0 Mobile/15E148 Safari/604.1';

const IPHONE_FACEBOOK =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 Safari/604.1 [FBAN/FBIOS;FBAV/470.0.0.0]';

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Mobile Safari/537.36';

const DISMISSED_KEY = 'teren.install.dismissed';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The browser's offer, as `InstallService` sees it. */
class FakeSource implements InstallPromptSource {
  event: BeforeInstallPromptEvent | null = null;
  wasInstalled = false;
  takes = 0;
  private readonly listeners = new Set<() => void>();

  available(): boolean {
    return this.event !== null;
  }

  installed(): boolean {
    return this.wasInstalled;
  }

  take(): BeforeInstallPromptEvent | null {
    this.takes += 1;
    const event = this.event;
    this.event = null;
    return event;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The browser deciding, at whatever moment it likes, that the app is installable. */
  offer(event: BeforeInstallPromptEvent): void {
    this.event = event;
    this.announce();
  }

  /** The `appinstalled` event, arriving after the user accepted. */
  complete(): void {
    this.wasInstalled = true;
    this.event = null;
    this.announce();
  }

  private announce(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function offerEvent(outcome: 'accepted' | 'dismissed'): {
  event: BeforeInstallPromptEvent;
  prompts: () => number;
} {
  let prompts = 0;
  const event = {
    platforms: ['web'],
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
    prompt: () => {
      prompts += 1;
      return Promise.resolve();
    },
  } as unknown as BeforeInstallPromptEvent;
  return { event, prompts: () => prompts };
}

describe('InstallService', () => {
  let source: FakeSource;
  const realMatchMedia = window.matchMedia;

  /** Answer `(display-mode: …)` the way a browser would for an app running in `mode`. */
  function runningAs(mode: string | null): void {
    window.matchMedia = ((query: string) =>
      ({
        matches: mode !== null && query.includes(`display-mode: ${mode}`),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  function userAgent(agent: string): void {
    Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true });
  }

  function create(): InstallService {
    TestBed.configureTestingModule({
      providers: [{ provide: INSTALL_PROMPT_SOURCE, useValue: source }],
    });
    return TestBed.inject(InstallService);
  }

  beforeEach(() => {
    localStorage.clear();
    source = new FakeSource();
    runningAs(null);
    userAgent(ANDROID_CHROME);
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    delete (navigator as { userAgent?: string }).userAgent;
    delete (navigator as { standalone?: boolean }).standalone;
    localStorage.clear();
  });

  it('says nothing on a browser that has made no offer', () => {
    expect(create().invitation()).toBeNull();
  });

  it('invites the Chromium install as soon as the browser offers one', () => {
    const service = create();
    expect(service.invitation()).toBeNull();

    source.offer(offerEvent('accepted').event);

    // The offer can arrive long after this screen rendered; the invitation has to follow it.
    expect(service.invitation()).toBe('prompt');
  });

  it('names the iOS gesture, because Safari will never offer anything', () => {
    userAgent(IPHONE_SAFARI);
    expect(create().invitation()).toBe('ios');
  });

  it('stays silent in an iOS browser that is not Safari, whose gesture is not the one we name', () => {
    userAgent(IPHONE_CHROME);
    expect(create().invitation()).toBeNull();
  });

  it('stays silent in an in-app webview, which cannot add to the home screen at all', () => {
    userAgent(IPHONE_FACEBOOK);
    expect(create().invitation()).toBeNull();
  });

  it('says nothing inside the installed iOS app', () => {
    userAgent(IPHONE_SAFARI);
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });

    const service = create();

    expect(service.installed()).toBe(true);
    expect(service.invitation()).toBeNull();
  });

  it.each(['standalone', 'fullscreen', 'minimal-ui'])(
    'says nothing when the app is already running in %s, even with an offer in hand',
    (mode) => {
      runningAs(mode);
      const service = create();
      source.offer(offerEvent('accepted').event);

      // An installed app suggesting you install it is a screen claiming to know something false.
      expect(service.installed()).toBe(true);
      expect(service.invitation()).toBeNull();
    },
  );

  it('goes quiet the moment the browser reports the install finished', () => {
    const service = create();
    source.offer(offerEvent('accepted').event);
    expect(service.invitation()).toBe('prompt');

    source.complete();

    expect(service.invitation()).toBeNull();
  });

  it('prompts once and reports what the user told the browser', async () => {
    const service = create();
    const { event, prompts } = offerEvent('accepted');
    source.offer(event);

    await expect(service.install()).resolves.toBe('accepted');

    expect(prompts()).toBe(1);
    // The event is spent; the card must not be able to offer it a second time.
    expect(service.invitation()).toBeNull();
  });

  it('treats a no to the browser dialog as a no, and does not ask again tomorrow', async () => {
    const service = create();
    source.offer(offerEvent('dismissed').event);

    await expect(service.install()).resolves.toBe('dismissed');

    source.offer(offerEvent('accepted').event);
    expect(service.invitation()).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).not.toBeNull();
  });

  it('reports unavailable rather than throwing when the offer is already gone', async () => {
    const service = create();
    await expect(service.install()).resolves.toBe('unavailable');
  });

  it('reports unavailable when a spent event refuses to prompt', async () => {
    const service = create();
    source.offer({
      platforms: ['web'],
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
      prompt: () => Promise.reject(new Error('already used')),
    } as unknown as BeforeInstallPromptEvent);

    await expect(service.install()).resolves.toBe('unavailable');
    expect(service.invitation()).toBeNull();
  });

  it('remembers a refusal across restarts — a foreman is asked once, not every morning', () => {
    userAgent(IPHONE_SAFARI);
    create().dismiss();
    TestBed.resetTestingModule();

    expect(create().invitation()).toBeNull();
  });

  it('is willing to ask again once the refusal is half a year old', () => {
    userAgent(IPHONE_SAFARI);
    localStorage.setItem(DISMISSED_KEY, String(Date.now() - 200 * DAY_MS));

    expect(create().invitation()).toBe('ios');
  });

  it('still holds its tongue a month after the refusal', () => {
    userAgent(IPHONE_SAFARI);
    localStorage.setItem(DISMISSED_KEY, String(Date.now() - 30 * DAY_MS));

    expect(create().invitation()).toBeNull();
  });

  it('stays silent when the stored refusal cannot be read — silence is the safe direction', () => {
    userAgent(IPHONE_SAFARI);
    localStorage.setItem(DISMISSED_KEY, 'yes');

    expect(create().invitation()).toBeNull();
  });
});
