import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { INSTALL_PROMPT_SOURCE, InstallPromptSource } from '../core/install/install-prompt';
import en from '../../../public/i18n/en.json';
import sr from '../../../public/i18n/sr.json';
import { InstallInvitation } from './install-invitation';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/125.0.0.0 Mobile Safari/537.36';

class FakeSource implements InstallPromptSource {
  event: BeforeInstallPromptEvent | null = null;
  prompts = 0;
  private readonly listeners = new Set<() => void>();

  constructor(offered = false) {
    if (offered) {
      this.event = {
        platforms: ['web'],
        userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
        prompt: () => {
          this.prompts += 1;
          return Promise.resolve();
        },
      } as unknown as BeforeInstallPromptEvent;
    }
  }

  available(): boolean {
    return this.event !== null;
  }

  installed(): boolean {
    return false;
  }

  take(): BeforeInstallPromptEvent | null {
    const event = this.event;
    this.event = null;
    return event;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('InstallInvitation', () => {
  let fixture: ComponentFixture<InstallInvitation>;
  const realMatchMedia = window.matchMedia;

  function userAgent(agent: string): void {
    Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true });
  }

  function runningInstalled(installed: boolean): void {
    window.matchMedia = ((query: string) =>
      ({
        matches: installed && query.includes('display-mode: standalone'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  function render(source: FakeSource): HTMLElement {
    TestBed.configureTestingModule({
      imports: [
        InstallInvitation,
        // The shipped dictionaries, not copies: a spec carrying its own strings would pass
        // happily while the Serbian a foreman actually reads was missing.
        TranslocoTestingModule.forRoot({
          langs: { sr, en },
          translocoConfig: {
            availableLangs: ['sr', 'en'],
            defaultLang: 'sr',
            reRenderOnLangChange: true,
          },
          preloadLangs: true,
        }),
      ],
      providers: [{ provide: INSTALL_PROMPT_SOURCE, useValue: source }],
    });
    fixture = TestBed.createComponent(InstallInvitation);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function click(element: HTMLElement, selector: string): void {
    element.querySelector<HTMLButtonElement>(selector)!.click();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.clear();
    runningInstalled(false);
    userAgent(ANDROID_CHROME);
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    delete (navigator as { userAgent?: string }).userAgent;
    delete (navigator as { standalone?: boolean }).standalone;
    localStorage.clear();
  });

  it('renders nothing at all when there is nothing to offer', () => {
    const element = render(new FakeSource());

    // Not merely hidden: the host is `display: contents`, so an empty render must leave no box
    // behind that would open a gap under the last row on Home.
    expect(element.querySelector('.install')).toBeNull();
    expect(element.textContent?.trim()).toBe('');
  });

  it('offers the install in Serbian, with one button, once Chromium has an offer', () => {
    const element = render(new FakeSource(true));

    expect(element.textContent).toContain('Dodajte Teren na početni ekran');
    expect(element.textContent).toContain('radi i tamo gde nema signala');
    expect(element.querySelector('.install__accept')).not.toBeNull();
  });

  it('takes the browser up on the offer and stops offering it', () => {
    const source = new FakeSource(true);
    const element = render(source);

    click(element, '.install__accept');

    expect(source.prompts).toBe(1);
    expect(element.querySelector('.install')).toBeNull();
  });

  it('names the Safari gesture on iOS, and offers no button it cannot honour', () => {
    userAgent(IPHONE_SAFARI);
    const element = render(new FakeSource());

    expect(element.textContent).toContain('Podeli');
    expect(element.textContent).toContain('Dodaj na početni ekran');
    // Safari never fires the install event, so a button promising to do it would be a lie.
    expect(element.querySelector('.install__accept')).toBeNull();
    expect(element.querySelector('.install__dismiss')).not.toBeNull();
  });

  it('remembers "not now" so the same question is not put again tomorrow', () => {
    userAgent(IPHONE_SAFARI);
    const element = render(new FakeSource());

    click(element, '.install__dismiss');

    expect(element.querySelector('.install')).toBeNull();
    expect(localStorage.getItem('teren.install.dismissed')).not.toBeNull();
  });

  it('shows nothing inside the installed app, offer or no offer', () => {
    runningInstalled(true);
    const element = render(new FakeSource(true));

    expect(element.querySelector('.install')).toBeNull();
  });
});
