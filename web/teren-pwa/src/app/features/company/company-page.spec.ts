import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { COMPANY_GATEWAY, CompanyGateway } from '../../core/company/company-gateway';
import {
  ActivationCodeResponse,
  CreateWorkerRequest,
  CreateWorkerResponse,
  DeviceListResponse,
  DeviceResponse,
  ShareTextResponse,
  WorkerListResponse,
} from '../../core/company/company-types';
import { MockCompanyGateway } from '../../core/company/mock-company-gateway';
import {
  ADMIN_SESSION_STORAGE_KEY,
  AdminSession,
  readStoredAdminSession,
} from '../../core/session/admin-session';
import { waitUntil } from '../../testing/flush';
import { routeUrlFor } from '../../testing/route-table';
import { LoginPage } from '../auth/login-page';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { CompanyPage } from './company-page';

/** A signed-in company admin, as `POST /auth/login` left him in this browser. */
const ADMIN: AdminSession = {
  token: 'trn_s_a-real-admin-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'company_admin',
  userId: '99999999-9999-9999-9999-999999999999',
  displayName: 'Milan Gradnja',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Vodoinstal Petrović d.o.o.',
  signedInAt: '2026-08-31T08:00:00.000Z',
};

function httpError(status: number, body: unknown = { detail: 'no' }): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'x', error: body });
}

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Deferred {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * `MockCompanyGateway` with knobs.
 *
 * The mock already models the backend the screen was written against — one company, two foremen,
 * three phones, one live code, and issuing that really supersedes — so the happy paths run through
 * it untouched and a spec can assert on what was actually asked for. What it cannot do is refuse,
 * because the endpoint it models does not refuse; these knobs supply the verdicts the screen has
 * to be honest about, and the gates let a spec look at the screen *while* a call is in flight.
 *
 * Hand-written, with plain fields, for the reason the house style has settled on: a `vi.mock` of
 * the whole module would replace the narrowing between the wire and the glass, which on this
 * screen is half of what is under test.
 */
class KnobbedGateway implements CompanyGateway {
  readonly real = new MockCompanyGateway();

  workersError: unknown = null;
  devicesError: unknown = null;
  readError: unknown = null;
  issueError: unknown = null;
  addError: unknown = null;
  revokeError: unknown = null;

  revokeGate: Deferred | null = null;
  issueGate: Deferred | null = null;

  /** How many times each list was actually asked for, so a reload can be told from a repaint. */
  workerListings = 0;
  deviceListings = 0;

  get reads(): string[] {
    return this.real.reads;
  }
  get issues(): string[] {
    return this.real.issues;
  }
  get revokes(): string[] {
    return this.real.revokes;
  }
  get added(): CreateWorkerRequest[] {
    return this.real.added;
  }

  async listWorkers(): Promise<WorkerListResponse> {
    this.workerListings += 1;
    this.refuse(this.workersError);
    return this.real.listWorkers();
  }

  async listDevices(): Promise<DeviceListResponse> {
    this.deviceListings += 1;
    this.refuse(this.devicesError);
    return this.real.listDevices();
  }

  async shareText(workerId: string): Promise<ShareTextResponse> {
    this.refuse(this.readError);
    return this.real.shareText(workerId);
  }

  async issueCode(workerId: string): Promise<ActivationCodeResponse> {
    await this.issueGate?.promise;
    this.refuse(this.issueError);
    return this.real.issueCode(workerId);
  }

  async addWorker(request: CreateWorkerRequest): Promise<CreateWorkerResponse> {
    this.refuse(this.addError);
    return this.real.addWorker(request);
  }

  async revokeDevice(deviceId: string): Promise<DeviceResponse> {
    await this.revokeGate?.promise;
    this.refuse(this.revokeError);
    return this.real.revokeDevice(deviceId);
  }

  private refuse(error: unknown): void {
    if (error) {
      throw error;
    }
  }
}

describe('CompanyPage', () => {
  let fixture: ComponentFixture<CompanyPage>;
  let element: HTMLElement;
  let router: Router;
  let gateway: KnobbedGateway;
  let writeText: ReturnType<typeof vi.fn>;

  /** Resolved from the shipped route table once, before any test — see `profile-page.spec.ts`. */
  let login: string;

  beforeAll(async () => {
    login = await routeUrlFor(LoginPage);
  });

  /**
   * Boot the screen against the knobbed backend.
   *
   * The **real** `CompanyService` and the **real** `AdminSessionService` are used, seeded through
   * `localStorage`: the narrowing between a wire response and a row on the glass, and the "is
   * anybody signed in" question that decides whether a request is sent at all, are both part of
   * what this screen has to get right. A stubbed service would prove nothing about either.
   */
  async function render(signedIn = true): Promise<void> {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(ADMIN));
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        CompanyPage,
        // The real dictionaries: a spec shipping its own copies would pass while the shipped
        // Serbian was missing a key.
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
      providers: [provideRouter([]), { provide: COMPANY_GATEWAY, useValue: gateway }],
    });

    fixture = TestBed.createComponent(CompanyPage);
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await settle();
  }

  /**
   * Drive change detection until the promise chains the screen started have all landed.
   *
   * The macrotask yield is what makes this reliable rather than lucky: the app is zoneless, so
   * `whenStable()` knows nothing about an un-tracked `void this.load()`, and this screen chains
   * three and four deep — add a foreman, reload both lists, then fetch his message. A yield to the
   * timer queue drains the whole microtask queue each turn, so the depth of the chain stops
   * mattering.
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 4; turn += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  }

  function text(): string {
    return element.textContent ?? '';
  }

  function buttons(): HTMLButtonElement[] {
    return [...element.querySelectorAll<HTMLButtonElement>('button')];
  }

  function button(label: string): HTMLButtonElement {
    const found = buttons().find((candidate) => candidate.textContent?.includes(label));
    if (!found) {
      throw new Error(
        `no button reading "${label}" on screen; there are: ` +
          buttons()
            .map((candidate) => `"${candidate.textContent?.trim()}"`)
            .join(', '),
      );
    }
    return found;
  }

  async function press(label: string): Promise<void> {
    button(label).click();
    await settle();
  }

  /** Open one man's card, the way an admin does: by tapping his row. */
  async function openWorker(name: string): Promise<void> {
    const summary = [...element.querySelectorAll<HTMLButtonElement>('.worker__summary')].find(
      (candidate) => candidate.textContent?.includes(name),
    );
    if (!summary) {
      throw new Error(`no worker row for ${name}`);
    }
    summary.click();
    await settle();
  }

  /** One phone's row, so an assertion about *this* handset cannot be answered by another. */
  function phoneRow(name: string): string {
    const row = [...element.querySelectorAll('.phone')].find((candidate) =>
      candidate.textContent?.includes(name),
    );
    if (!row) {
      throw new Error(`no phone row for ${name}`);
    }
    return row.textContent ?? '';
  }

  function stubClipboard(impl: () => Promise<void> = () => Promise.resolve()): void {
    writeText = vi.fn(impl);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  }

  async function type(selector: string, value: string): Promise<void> {
    const input = element.querySelector<HTMLInputElement>(selector);
    if (!input) {
      throw new Error(`no input matching ${selector}`);
    }
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    gateway = new KnobbedGateway();
    stubClipboard();
  });

  afterEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  // ---- Loading the office -------------------------------------------------------------------

  describe('loading', () => {
    it('resolves the loading state into his men and their phones', async () => {
      await render();

      expect(text()).not.toContain('Učitavanje radnika…');
      expect(text()).toContain('Zoran Jovanović');
      expect(text()).toContain('Marko Marković');
      // The chips that decide the admin's next move, read off the two lists together.
      expect(text()).toContain('Telefon aktivan');
      expect(text()).toContain('Nema telefon');
      expect(text()).toContain('Kod ga čeka');
      // Live phones across the company: two of the three, the third being withdrawn.
      expect(element.querySelector('.summary__row:last-child .summary__value')?.textContent).toBe(
        '2',
      );
    });

    it('renders Serbian by default — this screen hands out credentials in the owner’s language', async () => {
      await render();

      expect(text()).toContain('Firma');
      expect(text()).toContain('POSLOVOĐE');
      expect(text()).not.toContain('FOREMEN');
    });

    it('names the company, and the man whose session the way out would end', async () => {
      await render();

      expect(text()).toContain('Vodoinstal Petrović d.o.o.');
      // His own name is no longer a sentence in the rail. F7 moved the session into the chrome,
      // and "Prijavljeni ste kao …" went with it: it was content *about* chrome, and it is worth
      // more as the accessible name of the control that acts on it — which is where a man on a
      // shared office tablet needs to be told whom he is about to sign out.
      expect(text()).not.toContain('Prijavljeni ste kao');
      expect(
        element.querySelector<HTMLButtonElement>('.session')?.getAttribute('aria-label'),
      ).toBe('Odjavi se — Milan Gradnja');
    });

    /**
     * The constraint that decides where the session control may live.
     *
     * The app header is `display: none` below 768, and decision 9 puts this screen on every device
     * — so an admin doing the rounds on his phone can reach `/company`. A header-only sign-out
     * would strand him there with no way to end a password-backed session on the device most
     * likely to be lost. The screen therefore carries it twice, in the two pieces of chrome that
     * are never both visible.
     */
    it('keeps a way out on a phone, where the header does not exist', async () => {
      await render();

      expect(element.querySelectorAll('.session').length).toBe(2);
      expect(element.querySelector('.bar--compact app-session-link')).not.toBeNull();
      expect(element.querySelector('app-header app-session-link')).not.toBeNull();
    });

    /**
     * A list of men that is short because a request failed and a list that is short because the
     * company is small look identical unless one of them says which it is. This screen must say.
     */
    it('renders a sentence rather than an empty screen when the company could not be read', async () => {
      gateway.workersError = httpError(500);
      await render();

      expect(text()).toContain('Nije provereno na serveru');
      expect(text()).toContain('Server trenutno ne odgovara.');
      // …and never the empty-company story, which would be a claim it has no grounds for.
      expect(text()).not.toContain('Dodajte prvog i dajte mu kod.');
    });

    /**
     * 401 and 403 are the split `CompanyStatus` exists for. Signing in again fixes one and cannot
     * fix the other, and offering the wrong remedy is a screen lying about what it knows.
     */
    it('tells an expired sign-in from a role that may not do this', async () => {
      gateway.workersError = httpError(401);
      await render();
      expect(text()).toContain('Server više ne prihvata ovu prijavu.');

      gateway = new KnobbedGateway();
      gateway.workersError = httpError(403);
      await render();
      expect(text()).toContain('Ovaj nalog to ne sme.');
      expect(text()).not.toContain('Server više ne prihvata ovu prijavu.');
    });

    it('says there is no internet rather than that the company is empty', async () => {
      gateway.workersError = httpError(0);
      await render();

      expect(text()).toContain('Nema interneta, pa ništa nije moglo da se proveri na serveru.');
    });

    /**
     * The men are the screen; the phones decorate it. A devices call that failed on its own must
     * not turn a readable list of foremen into an error page.
     */
    it('keeps the men readable when only the phones could not be listed', async () => {
      gateway.devicesError = httpError(500);
      await render();

      expect(text()).toContain('Zoran Jovanović');
      expect(text()).not.toContain('Nije provereno na serveru');
    });

    it('sends nothing at all when this browser holds no admin credential', async () => {
      await render(false);

      expect(text()).toContain('Niste prijavljeni, pa ništa nije moglo da se pročita.');
      expect(gateway.reads).toEqual([]);
    });
  });

  // ---- Reading a code -----------------------------------------------------------------------

  describe('revealing a code', () => {
    /**
     * §5, and the reversal that put the plaintext back in the database: **looking at a code never
     * spends it**. The admin sends it by Viber and taps back an hour later to read it aloud; if
     * looking re-issued, it would kill the code the man is at that moment typing.
     */
    it('shows the live code without minting a new one', async () => {
      await render();

      await openWorker('Zoran Jovanović');

      expect(element.querySelector('[data-code]')?.textContent?.trim()).toBe(
        MockCompanyGateway.LIVE_CODE,
      );
      expect(text()).toContain('KOD ZA PRIDRUŽIVANJE');
      expect(text()).toContain('Važi do');
      // No relay exists in any environment today, and the admin has to know he is the channel.
      expect(text()).toContain('Ništa nije poslato imejlom.');

      expect(gateway.reads).toEqual([MockCompanyGateway.ZORAN_ID]);
      expect(gateway.issues).toEqual([]);
    });

    /**
     * Decision 13, as a property of the screen rather than of a comment: there is no state in
     * which two workers' codes are visible, because there is only one place a code can be.
     */
    it('never holds two men’s codes at once', async () => {
      await render();

      await openWorker('Zoran Jovanović');
      expect(text()).toContain(MockCompanyGateway.LIVE_CODE);

      await openWorker('Marko Marković');

      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(element.querySelectorAll('[data-code]')).toHaveLength(0);
    });

    it('closes the card again on a second tap', async () => {
      await render();

      await openWorker('Zoran Jovanović');
      await openWorker('Zoran Jovanović');

      expect(element.querySelector('[data-code]')).toBeNull();
    });

    /**
     * `409 no_live_activation_code` is the server stating a fact, not refusing. The screen offers
     * the remedy instead of an apology — and issuing here destroys nothing, so it acts on the
     * first tap rather than asking.
     */
    it('offers to make one for a man who has none, and acts on the first tap', async () => {
      await render();

      await openWorker('Marko Marković');

      expect(text()).toContain('Trenutno nema kod koji bi mogao da ukuca.');
      expect(text()).not.toContain('Kod nije mogao da se pročita');

      await press('Napravi kod');

      expect(gateway.issues).toEqual([MockCompanyGateway.MARKO_ID]);
      expect(element.querySelector('[data-code]')?.textContent).toContain('NEW');
    });

    it('says why a code could not be read, and shows no code at all', async () => {
      gateway.readError = httpError(403);
      await render();

      await openWorker('Zoran Jovanović');

      expect(text()).toContain('Kod nije mogao da se pročita');
      expect(text()).toContain('Ovaj nalog to ne sme.');
      expect(element.querySelector('[data-code]')).toBeNull();
    });
  });

  // ---- Re-issuing ---------------------------------------------------------------------------

  describe('re-issuing a code', () => {
    it('asks before superseding a code the man may already be holding', async () => {
      await render();
      await openWorker('Zoran Jovanović');

      await press('Napravi novi kod');

      // The question names the consequence rather than saying "are you sure".
      expect(text()).toContain('Kod iznad prestaje da važi čim se napravi novi.');
      // Nothing has been spent yet, and the code he holds is still the one on screen.
      expect(gateway.issues).toEqual([]);
      expect(text()).toContain(MockCompanyGateway.LIVE_CODE);
    });

    it('leaves the live code alone when the question is declined', async () => {
      await render();
      await openWorker('Zoran Jovanović');
      await press('Napravi novi kod');

      await press('Otkaži');

      expect(gateway.issues).toEqual([]);
      expect(element.querySelector('[data-code]')?.textContent?.trim()).toBe(
        MockCompanyGateway.LIVE_CODE,
      );
    });

    /**
     * **The property this feature exists to enforce.**
     *
     * Issuing supersedes: the previous code stops working the instant a new one exists. A screen
     * that still showed the old string would have an owner reading a dead code down the phone
     * while a foreman typed it at a locked door — the exact failure the plan reversed its
     * "hash only" design to make impossible.
     */
    it('replaces the superseded code on screen, and never shows it again', async () => {
      await render();
      await openWorker('Zoran Jovanović');
      await press('Napravi novi kod');

      await press('Da, napravi novi');

      const shown = element.querySelector('[data-code]')?.textContent?.trim();
      expect(gateway.issues).toEqual([MockCompanyGateway.ZORAN_ID]);
      expect(shown).toBeTruthy();
      expect(shown).not.toBe(MockCompanyGateway.LIVE_CODE);
      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);

      // And the message that carries it carries the *new* code, not the dead one.
      await press('Kopiraj poruku');
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining(shown ?? 'nothing'));
      expect(writeText).not.toHaveBeenCalledWith(
        expect.stringContaining(MockCompanyGateway.LIVE_CODE),
      );
    });

    it('shows the work in progress instead of an idle button', async () => {
      await render();
      await openWorker('Zoran Jovanović');
      await press('Napravi novi kod');

      gateway.issueGate = deferred();
      button('Da, napravi novi').click();
      await settle();

      expect(text()).toContain('Pravljenje koda…');
      expect(button('Pravljenje koda…').disabled).toBe(true);

      gateway.issueGate.release();
      await waitUntil(() => !text().includes('Pravljenje koda…'), {
        onTick: () => fixture.detectChanges(),
        describe: 'the code to arrive',
      });
      expect(element.querySelector('[data-code]')).not.toBeNull();
    });

    /**
     * The distinction `serverAnswered` exists for, on the more dangerous of the two mutations.
     *
     * A refused issue changed nothing. An issue that never got a verdict **may well have
     * superseded the code the man is holding** — so the screen must not call it a failure and
     * invite another press, because a second press would supersede a code that already exists.
     */
    it('does not call an unanswered issue a failure', async () => {
      gateway.issueError = httpError(500);
      await render();
      await openWorker('Zoran Jovanović');
      await press('Napravi novi kod');

      await press('Da, napravi novi');

      expect(text()).toContain(
        'Server nije odgovorio, pa se ne zna da li je napravljen novi kod.',
      );
      // Never the read-failure sentence: nobody was reading, and the previous code may be dead.
      expect(text()).not.toContain('Kod nije mogao da se pročita');
      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);
    });

    it('says plainly when the server refused the issue, because nothing changed', async () => {
      gateway.issueError = httpError(403);
      await render();
      await openWorker('Zoran Jovanović');
      await press('Napravi novi kod');

      await press('Da, napravi novi');

      expect(text()).toContain('Ovaj nalog to ne sme.');
      expect(text()).not.toContain('Server nije odgovorio, pa se ne zna');
    });
  });

  // ---- The share text -----------------------------------------------------------------------

  describe('sharing a code', () => {
    /**
     * Decision 13 made easy rather than merely required: **one worker's ready-made message, for
     * one chat**. A message carrying six codes and six names in a site group lets any man in that
     * chat activate a phone under another man's name, and every entry he then records is signed
     * with it.
     */
    it('copies one man’s message, naming him and nobody else', async () => {
      await render();
      await openWorker('Zoran Jovanović');

      await press('Kopiraj poruku');

      expect(writeText).toHaveBeenCalledTimes(1);
      const message = writeText.mock.calls[0][0] as string;
      expect(message).toContain('Zoran Jovanović');
      expect(message).toContain(MockCompanyGateway.LIVE_CODE);
      expect(message).not.toContain('Marko Marković');
      expect(text()).toContain('Poruka je kopirana. Pošaljite je samo njemu.');
    });

    it('copies the bare code for reading down a telephone', async () => {
      await render();
      await openWorker('Zoran Jovanović');

      await press('Kopiraj kod');

      expect(writeText).toHaveBeenCalledWith(MockCompanyGateway.LIVE_CODE);
      expect(text()).toContain('Kod je kopiran.');
    });

    it('says out loud that a code goes to one man and not into a group', async () => {
      await render();
      await openWorker('Zoran Jovanović');

      expect(text()).toContain('Jedan čovek, jedna poruka.');
      // There is no bulk export anywhere on the screen — the whole point of decision 13.
      expect(buttons().some((candidate) => /svi|sve kod/i.test(candidate.textContent ?? ''))).toBe(
        false,
      );
    });

    /**
     * `navigator.clipboard` is absent in an insecure context and rejects when the document is not
     * focused — both entirely ordinary on an office tablet. The code is selectable text either
     * way, so this is a hint and never an error, and it must not claim a copy that did not happen.
     */
    it('falls back to a hint when the clipboard refuses', async () => {
      stubClipboard(() => Promise.reject(new Error('not focused')));
      await render();
      await openWorker('Zoran Jovanović');

      await press('Kopiraj kod');

      expect(text()).toContain('Aplikacija nije uspela da koristi ostavu.');
      expect(text()).not.toContain('Kod je kopiran.');
      // The value itself never leaves the glass.
      expect(element.querySelector('[data-code]')?.textContent?.trim()).toBe(
        MockCompanyGateway.LIVE_CODE,
      );
    });

    it('survives a browser with no clipboard API at all', async () => {
      Reflect.deleteProperty(navigator, 'clipboard');
      await render();
      await openWorker('Zoran Jovanović');

      await press('Kopiraj kod');

      expect(text()).toContain('Aplikacija nije uspela da koristi ostavu.');
    });
  });

  // ---- Revoking a phone ---------------------------------------------------------------------

  describe('revoking a phone', () => {
    it('asks first, naming which phone and whose', async () => {
      await render();
      await openWorker('Zoran Jovanović');

      await press('Opozovi');

      expect(text()).toContain('Opozvati Zoranov telefon — Zoran Jovanović?');
      expect(gateway.revokes).toEqual([]);
    });

    /**
     * The copy `DeviceEndpoints.cs` demands, pinned as a property rather than as a string.
     *
     * Under the shipped client a revoked phone's outbox stops getting through until the man
     * re-activates. An owner pressing this must be told that a day of unsent evidence is about to
     * stop going anywhere — and equally that nothing on the phone is deleted, because the
     * opposite fear is what would stop him revoking a phone that walked off site.
     */
    it('warns what revoking actually costs before he presses it', async () => {
      await render();
      await openWorker('Zoran Jovanović');

      await press('Opozovi');

      const warning = element.querySelector('.confirm')?.textContent ?? '';
      // It stops the phone *sending*, not recording…
      expect(warning).toMatch(/prestaje da se šalje/i);
      // …nothing local is destroyed…
      expect(warning).toMatch(/ništa se sa telefona ne briše/i);
      // …and the way back is a new code.
      expect(warning).toMatch(/novim kodom/i);
    });

    it('withdraws the phone and shows it withdrawn', async () => {
      await render();
      await openWorker('Zoran Jovanović');
      await press('Opozovi');

      await press('Opozovi telefon');

      expect(gateway.revokes).toEqual([MockCompanyGateway.ZORAN_PHONE_ID]);
      const phones = element.querySelector('.phones')?.textContent ?? '';
      expect(phones).toContain('Opozvan');
      // The row survives — a stamp, never a delete, because it is provenance on evidence.
      expect(phones).toContain('Zoranov telefon');
      // And the company-wide count of phones that can still record drops.
      expect(element.querySelector('.summary__row:last-child .summary__value')?.textContent).toBe(
        '1',
      );
    });

    it('leaves the phone alone when the question is declined', async () => {
      await render();
      await openWorker('Zoran Jovanović');
      await press('Opozovi');

      await press('Otkaži');

      expect(gateway.revokes).toEqual([]);
      expect(text()).not.toContain('Opozvati Zoranov telefon');
    });

    it('shows the work in progress, and refuses a second tap while it runs', async () => {
      await render();
      await openWorker('Zoran Jovanović');
      await press('Opozovi');

      gateway.revokeGate = deferred();
      button('Opozovi telefon').click();
      await settle();

      expect(button('Opozivanje…').disabled).toBe(true);
      button('Opozivanje…').click();
      await settle();

      gateway.revokeGate.release();
      await waitUntil(() => gateway.revokes.length > 0, {
        onTick: () => fixture.detectChanges(),
        describe: 'the revoke to reach the wire',
      });
      // One request, however many times a thumb landed on the button.
      expect(gateway.revokes).toEqual([MockCompanyGateway.ZORAN_PHONE_ID]);
    });

    it('says why a refused revoke was refused, and keeps the phone live', async () => {
      gateway.revokeError = httpError(403);
      await render();
      await openWorker('Zoran Jovanović');
      await press('Opozovi');

      await press('Opozovi telefon');

      expect(text()).toContain('Ovaj nalog to ne sme.');
      // Scoped to *his* live phone: the man's older handset is legitimately withdrawn already,
      // and a whole-list assertion would read that stamp as this revoke succeeding.
      expect(phoneRow('Zoranov telefon')).not.toContain('Opozvan');
      expect(phoneRow('Zoranov telefon')).toContain('Opozovi');
    });

    /**
     * A revoke that timed out may well have revoked. Telling an owner "it did not work" would
     * leave him believing a phone he has taken away can still record — which is the one belief
     * this screen must never produce.
     */
    it('never reports a revoke as failed when the server gave no verdict', async () => {
      gateway.revokeError = httpError(500);
      await render();
      await openWorker('Zoran Jovanović');
      await press('Opozovi');

      await press('Opozovi telefon');

      expect(text()).toContain('Server nije odgovorio, pa se ne zna da li je telefon opozvan.');
      expect(text()).not.toContain('Server trenutno ne odgovara.');
    });

    it('offers no withdraw button on a phone that is already withdrawn', async () => {
      await render();
      await openWorker('Zoran Jovanović');

      const revoked = [...element.querySelectorAll('.phone')].find((row) =>
        row.textContent?.includes('Stari telefon'),
      );
      expect(revoked?.textContent).toContain('Opozvan');
      expect(revoked?.querySelector('button')).toBeNull();
    });
  });

  // ---- Adding a foreman ---------------------------------------------------------------------

  describe('adding a foreman', () => {
    async function openForm(): Promise<void> {
      await press('Dodaj poslovođu');
    }

    it('will not send a nameless man, and says so by refusing the button', async () => {
      await render();
      await openForm();

      expect(button('Dodaj i napravi kod').disabled).toBe(true);

      element.querySelector('form')?.dispatchEvent(new Event('submit'));
      await settle();

      expect(gateway.added).toEqual([]);
    });

    /**
     * Adding a man you cannot then activate is not a finished action. The endpoint returns the
     * worker and his first code together, so the screen ends on the code — the only code on
     * screen, exactly as every other reveal is.
     */
    it('adds him and shows his first code straight away', async () => {
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');
      await type('input[type="email"]', 'Petar@Firma.RS');

      await press('Dodaj i napravi kod');

      expect(gateway.added).toEqual([
        { display_name: 'Petar Petrović', email: 'petar@firma.rs' },
      ]);
      expect(text()).toContain('Petar Petrović');
      expect(element.querySelectorAll('[data-code]')).toHaveLength(1);
      expect(element.querySelector('[data-code]')?.textContent).toContain('NEW');
    });

    it('sends no address at all rather than an empty one', async () => {
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(gateway.added).toEqual([{ display_name: 'Petar Petrović' }]);
    });

    /**
     * The two conflicts have different remedies and must not share a sentence: a taken address is
     * his to change, a lost username race is the server's and the answer is to press again.
     */
    it('names a taken email address', async () => {
      gateway.addError = httpError(409, { code: 'email_taken' });
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');
      await type('input[type="email"]', 'zauzeto@firma.rs');

      await press('Dodaj i napravi kod');

      expect(text()).toContain('Ta imejl adresa je već na jednom Teren nalogu.');
      expect(text()).not.toContain('To ime je zauzeto');
    });

    it('names a lost username race separately', async () => {
      gateway.addError = httpError(409, { code: 'username_taken' });
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(text()).toContain('To ime je zauzeto dok je dodavan.');
      expect(text()).not.toContain('Ta imejl adresa');
    });

    it('falls back to the plain reason for a conflict it cannot name', async () => {
      gateway.addError = httpError(500);
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');

      await press('Dodaj i napravi kod');

      expect(text()).toContain('Server trenutno ne odgovara.');
      expect(gateway.added).toEqual([]);
    });

    it('clears the complaint as soon as he edits the field', async () => {
      gateway.addError = httpError(409, { code: 'email_taken' });
      await render();
      await openForm();
      await type('input[type="text"]', 'Petar Petrović');
      await type('input[type="email"]', 'zauzeto@firma.rs');
      await press('Dodaj i napravi kod');

      await type('input[type="email"]', 'drugo@firma.rs');

      expect(text()).not.toContain('Ta imejl adresa je već na jednom Teren nalogu.');
    });
  });

  // ---- Chrome -------------------------------------------------------------------------------

  describe('the screen itself', () => {
    it('offers no way to a screen an admin may not open', async () => {
      await render();

      // An admin holds no device session, so every screen behind the profile control is one the
      // gate would turn him away from.
      expect(element.querySelector('app-profile-link')).toBeNull();
      expect(element.querySelector('app-header')).not.toBeNull();
    });

    it('signs out of the office and leaves for the login screen', async () => {
      await render();

      await press('Odjavi se');

      expect(readStoredAdminSession()).toBeNull();
      // Derived from the route table, never spelled out: a rename of `/login` must fail here.
      expect(router.navigate).toHaveBeenCalledWith([login]);
    });

    /**
     * **Signing out deletes a credential and not one row of evidence.**
     *
     * Asserted against the shipped source rather than the DOM, because what is being ruled out is
     * a *future* edit — someone tidying the outbox away on the path out of the office. An admin
     * session guards nothing local; a foreman's phone may be holding a day of unsent work in the
     * very same browser.
     */
    it('holds no way to reach the evidence store', () => {
      const source = readFileSync(
        join(process.cwd(), 'src', 'app', 'features', 'company', 'company-page.ts'),
        'utf8',
      )
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');

      for (const forbidden of ['core/db', 'EntryStore', 'TEREN_DB', 'TerenDb', 'indexedDB']) {
        expect(source, `the company screen must not reach for ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    });

    it('reloads both lists on demand, and spends nothing doing it', async () => {
      await render();
      expect(gateway.workerListings).toBe(1);

      element.querySelector<HTMLButtonElement>('.head__reload')?.click();
      await settle();

      expect(gateway.workerListings).toBe(2);
      expect(gateway.deviceListings).toBe(2);
      expect(text()).toContain('Zoran Jovanović');
      // Refreshing is a read of the office, never a mint or a revoke.
      expect(gateway.issues).toEqual([]);
      expect(gateway.revokes).toEqual([]);
    });
  });

  /**
   * Decision 9, and the founder rule behind it: every screen ships a deliberate layout for all
   * three device classes. The plan singles this one out — a worker list with per-row actions at
   * 390 px — as one of the two hardest in the project, so the answer is asserted rather than
   * assumed. Read off the shipped stylesheet, because a media query has no DOM to interrogate
   * under jsdom.
   */
  describe('three device classes', () => {
    const css = readFileSync(
      join(process.cwd(), 'src', 'app', 'features', 'company', 'company-page.css'),
      'utf8',
    );
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

    it('gives a phone chrome of its own, since the app header starts at 768', async () => {
      await render();

      // Both exist in the markup; the stylesheet is what hides the compact bar on a tablet.
      expect(element.querySelector('.bar--compact')).not.toBeNull();
      expect(element.querySelector('.bar--compact app-language-switcher')).not.toBeNull();
      expect(rules).toMatch(/@media \(min-width: 768px\)\s*\{\s*\.bar--compact\s*\{\s*display: none/);
    });

    /**
     * The crew is two-up from 768 **upward**, not only through the tablet band.
     *
     * It was bounded at 1023 until F7, which meant a desktop got the arrangement a phone gets: one
     * card per row. A worker card is a name, a username and two chips — stretched across a 780 px
     * desktop column it is a 72 px sliver with half a metre of white beside it, and eight of them
     * scroll a laptop for no reason. That was the founder's *"use the space"* note, and the fix is
     * to stop the two-up arrangement expiring at the breakpoint above the one he had approved it
     * at. So this asserts the block's header, not merely its contents: re-bound it to the tablet
     * band and this goes red rather than silently returning a desktop to single file.
     */
    it('designs the medium class and carries it up, rather than stretching the phone through it', () => {
      const crew = rules.split('@media ').find((block) => block.includes('repeat(2, minmax(0, 1fr))'));

      expect(crew?.startsWith('(min-width: 768px) {')).toBe(true);
      // The open card spans both columns: a code, a message and a list of phones inside half a
      // 640 column is a column of wrapped fragments.
      expect(crew).toContain('.worker--open');
      expect(crew).toContain('grid-column: 1 / -1');
    });

    it('gives the expanded class a real application layout, not a centred phone column', () => {
      const expanded = rules.split('@media (min-width: 1024px)')[1] ?? '';
      expect(expanded).toContain('grid-template-columns: repeat(12, 1fr)');
      expect(expanded).toContain('.pane--workers');
      expect(expanded).toContain('.pane--aside');
    });

    it('takes every colour from the design tokens', () => {
      // `design/tokens.md` is binding, and a raw hex is how a screen drifts out of the system.
      expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
  });
});
