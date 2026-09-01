import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { COMPANY_GATEWAY } from '../../core/company/company-gateway';
import { MockCompanyGateway } from '../../core/company/mock-company-gateway';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../../core/session/admin-session';
import { KnobbedGateway, deferred, httpError } from '../../testing/company-gateway-double';
import { waitUntil } from '../../testing/flush';
import { routeUrlFor } from '../../testing/route-table';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { CompanyPage } from './company-page';
import { CodeState, WorkerPage } from './worker-page';

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

describe('WorkerPage', () => {
  let fixture: ComponentFixture<WorkerPage>;
  let element: HTMLElement;
  let router: Router;
  let gateway: KnobbedGateway;
  let writeText: ReturnType<typeof vi.fn>;

  /** The people list's own URL, resolved from the shipped route table rather than spelled out. */
  let people: string;

  beforeAll(async () => {
    people = await routeUrlFor(CompanyPage);
  });

  async function render(workerId = MockCompanyGateway.ZORAN_ID, signedIn = true): Promise<void> {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(ADMIN));
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        WorkerPage,
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

    fixture = TestBed.createComponent(WorkerPage);
    element = fixture.nativeElement as HTMLElement;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    // A required input, so it is set before the first change detection reads it.
    fixture.componentRef.setInput('workerId', workerId);
    await settle();
  }

  /** Move to another man on the same route, exactly as the router does: the input changes. */
  async function goTo(workerId: string): Promise<void> {
    fixture.componentRef.setInput('workerId', workerId);
    await settle();
  }

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

  function shownCode(): string | undefined {
    return element.querySelector('[data-code]')?.textContent?.trim();
  }

  function buttons(): HTMLButtonElement[] {
    return [...element.querySelectorAll<HTMLButtonElement>('button')];
  }

  /** By what it says, or by its accessible name: the head row's three controls are icons. */
  function button(label: string): HTMLButtonElement {
    const found = buttons().find(
      (candidate) =>
        candidate.textContent?.includes(label) ||
        candidate.getAttribute('aria-label')?.includes(label),
    );
    if (!found) {
      throw new Error(
        `no button reading "${label}" on screen; there are: ` +
          buttons()
            .map(
              (candidate) =>
                `"${candidate.textContent?.trim() || candidate.getAttribute('aria-label')}"`,
            )
            .join(', '),
      );
    }
    return found;
  }

  async function press(label: string): Promise<void> {
    button(label).click();
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

  // ---- The man, and his code -----------------------------------------------------------------

  describe('opening a foreman', () => {
    /**
     * §5, and the reversal that put the plaintext back in the database: **looking at a code never
     * spends it**. The admin sends it by Viber and comes back an hour later to read it aloud; if
     * looking re-issued, it would kill the code the man is at that moment typing.
     */
    it('shows the man, his username and his live code, without minting a new one', async () => {
      await render();

      expect(text()).toContain('Zoran Jovanović');
      expect(text()).toContain('zoran.jovanovic');
      expect(shownCode()).toBe(MockCompanyGateway.LIVE_CODE);
      expect(text()).toContain('KOD ZA PRIDRUŽIVANJE');
      expect(text()).toContain('Važi do');
      // No relay exists in any environment today, and the admin has to know he is the channel.
      expect(text()).toContain('Ništa nije poslato imejlom.');

      expect(gateway.reads).toEqual([MockCompanyGateway.ZORAN_ID]);
      expect(gateway.issues).toEqual([]);
    });

    it('renders Serbian by default — this screen hands out credentials in the owner’s language', async () => {
      await render();

      expect(text()).toContain('KOD ZA PRIDRUŽIVANJE');
      expect(text()).toContain('TELEFONI');
      expect(text()).not.toContain('JOIN CODE');
    });

    /**
     * His details are behind the head row's profile button since the rail went (founder,
     * 2026-09-01) — the same block, in a dialog. What it must not lose is the honesty: a man with no
     * address gets an em-dash and the sentence saying what that costs him, not a blank.
     */
    it('lists the facts about him behind the profile button, and is honest where there is nothing', async () => {
      await render(MockCompanyGateway.MARKO_ID);

      expect(text()).toContain('Marko Marković');
      // Not in the page body any more…
      expect(text()).not.toContain('Nema upisanu imejl adresu');

      await press('Podaci o poslovođi');

      const dialog = element.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.getAttribute('aria-label')).toBe('Podaci');
      expect(dialog?.textContent).toContain('marko.markovic');
      // No address on file: an em-dash and the sentence that says what it costs him.
      expect(dialog?.textContent).toContain('—');
      expect(dialog?.textContent).toContain('Nema upisanu imejl adresu');
      // He has never called home, and "never" is a word, not a blank.
      expect(dialog?.textContent).toContain('Nikad');
    });

    /**
     * Decision 13 on the second new surface. The dialog is facts this page already showed — and a
     * code is not one of them.
     */
    it('keeps the details dialog free of any code', async () => {
      await render();

      await press('Podaci o poslovođi');

      const dialog = element.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('zoran.jovanovic');
      expect(dialog?.textContent).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(dialog?.querySelector('[data-code]')).toBeNull();
      expect(
        [...(dialog?.querySelectorAll('button') ?? [])].some((b) =>
          /kopiraj|podeli/i.test(b.textContent ?? ''),
        ),
      ).toBe(false);
    });

    /** A dialog left open across a change of worker would describe the man he just left. */
    it('closes the details when he moves to another man', async () => {
      await render(MockCompanyGateway.ZORAN_ID);
      await press('Podaci o poslovođi');
      expect(element.querySelector('[role="dialog"]')?.textContent).toContain('zoran.jovanovic');

      await goTo(MockCompanyGateway.MARKO_ID);

      expect(element.querySelector('[role="dialog"]')).toBeNull();
    });

    it('opens the same code explanation this screen’s twin carries', async () => {
      await render();

      expect(text()).not.toContain('Kod važi jednom i traje sedam dana.');

      await press('Kako kodovi rade');

      expect(element.querySelector('.pop')?.textContent).toContain(
        'Kod važi jednom i traje sedam dana.',
      );
      expect(element.querySelector('.pop')?.textContent).not.toContain(
        MockCompanyGateway.LIVE_CODE,
      );
    });

    it('keeps the same chips the list showed about him', async () => {
      await render();

      expect(text()).toContain('Telefon aktivan');
      expect(text()).toContain('Kod ga čeka');
    });

    /**
     * The app header is `display: none` below 768 and a company admin can reach this screen on a
     * phone. A header-only sign-out would strand him with no way to end a password-backed session.
     */
    it('keeps a way out, and a way back, at every width', async () => {
      await render();

      expect(element.querySelectorAll('.session').length).toBe(2);
      expect(element.querySelector('.bar--compact app-session-link')).not.toBeNull();
      expect(element.querySelector('app-header app-session-link')).not.toBeNull();

      // The way back is in the head row, so it exists whether or not the header is visible.
      element.querySelector<HTMLButtonElement>('.head__back')?.click();
      await settle();
      expect(router.navigate).toHaveBeenCalledWith([people]);
    });

    /**
     * `409 no_live_activation_code` is the server stating a fact, not refusing. The screen offers
     * the remedy instead of an apology — and issuing here destroys nothing, so it acts on the first
     * tap rather than asking.
     */
    it('offers to make one for a man who has none, and acts on the first tap', async () => {
      await render(MockCompanyGateway.MARKO_ID);

      expect(text()).toContain('Trenutno nema kod koji bi mogao da ukuca.');
      expect(text()).not.toContain('Kod nije mogao da se pročita');

      await press('Napravi kod');

      expect(gateway.issues).toEqual([MockCompanyGateway.MARKO_ID]);
      expect(shownCode()).toContain('NEW');
    });

    it('says why a code could not be read, and shows no code at all', async () => {
      gateway.readError = httpError(403);
      await render();

      expect(text()).toContain('Kod nije mogao da se pročita');
      expect(text()).toContain('Ovaj nalog to ne sme.');
      expect(element.querySelector('[data-code]')).toBeNull();
    });
  });

  // ---- An id that is not his company's -------------------------------------------------------

  describe('an unknown or foreign worker', () => {
    /**
     * A rendered state, not an error — the way `ArchiveService.getEntry` models a 404. The server
     * refuses to tell "no such man" from "another company's man" (a foreign id is a 404 by
     * doctrine), so the screen must not invent the distinction either.
     */
    it('says he is not in this company, and offers the way back', async () => {
      await render('d3a0c1f0-5b8e-4f1a-9c62-00000000ffff');

      expect(text()).toContain('Taj poslovođa nije u vašoj firmi');
      expect(element.querySelector('[data-code]')).toBeNull();

      await press('Vrati se na ljude');
      expect(router.navigate).toHaveBeenCalledWith([people]);
    });

    /**
     * A read that did not answer is not a man who does not exist. On the screen that hands out
     * credentials, announcing that a foreman is not in the company because the wifi blipped is the
     * worst thing it can say.
     */
    it('never calls a failed read a missing man', async () => {
      gateway.workersError = httpError(500);
      await render();

      expect(text()).toContain('Poslovođa nije mogao da se pročita');
      expect(text()).toContain('Server trenutno ne odgovara.');
      expect(text()).not.toContain('Taj poslovođa nije u vašoj firmi');
    });

    it('sends nothing at all when this browser holds no admin credential', async () => {
      await render(MockCompanyGateway.ZORAN_ID, false);

      expect(text()).toContain('Niste prijavljeni, pa ništa nije moglo da se pročita.');
      expect(gateway.reads).toEqual([]);
      expect(gateway.workerListings).toBe(0);
    });
  });

  // ---- The freshness guard -------------------------------------------------------------------

  describe('one route, two men', () => {
    /**
     * **The defect this guard exists for, and it is worse here than on the archive.**
     *
     * `/company/worker/:workerId` is one route, so Angular reuses this component across workers: an
     * in-flight read for A can resolve after the admin has moved to B. On the archive that put one
     * day's header on another day's record (fixed 2026-09-01). Here it would put **one man's live
     * activation code under another man's name**, and the admin would paste it into that man's chat
     * — where it would activate a phone recording evidence signed with somebody else's name.
     *
     * Asserted on the code itself, which comes straight from the per-worker `GET /share-text`, and
     * on the answer that *should* be on screen. Remove the guard in `readCode` and the second
     * assertion goes red: the late state belongs to another man, so nothing paints at all.
     */
    it('never paints one man’s code onto another man’s page', async () => {
      gateway.readGate = deferred();
      gateway.readGateFor = MockCompanyGateway.ZORAN_ID;
      await render(MockCompanyGateway.ZORAN_ID);
      expect(element.querySelector('[data-code]')).toBeNull();

      // He goes back to the list and opens Marko, who has no code, while Zoran's read is in flight.
      await goTo(MockCompanyGateway.MARKO_ID);
      expect(text()).toContain('Trenutno nema kod koji bi mogao da ukuca.');

      gateway.readGate.release();
      await settle();

      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(element.querySelector('[data-code]')).toBeNull();
      // Marko's own answer is still the one on screen.
      expect(text()).toContain('Trenutno nema kod koji bi mogao da ukuca.');
      expect(text()).toContain('Marko Marković');
    });

    /** The same guard on the read that paints the name, the chips and the facts. */
    it('never puts the name of the man you left on the man you are looking at', async () => {
      gateway.workersGate = deferred();
      await render(MockCompanyGateway.ZORAN_ID);

      const late = gateway.workersGate;
      gateway.workersGate = null;
      await goTo(MockCompanyGateway.MARKO_ID);
      expect(text()).toContain('Marko Marković');

      late.release();
      await settle();

      expect(element.querySelector('.head__title')?.textContent).toContain('Marko Marković');
      expect(text()).not.toContain('Zoran Jovanović');
    });

    /**
     * **The gating hole the reviewer found: the destructive path had no witness.**
     *
     * The two *read* guards were pinned by the specs above. The guard on `issue()` was not, and
     * neither was the filter below — both could be deleted with the whole suite still green, on the
     * one screen in the product that hands out working credentials.
     *
     * The sequence is entirely ordinary: confirm "Da, napravi novi" for A, go back to the people and
     * open B while the POST is still in flight. Without the guard A's freshly minted code and A's
     * share message — which names A — paint under B's name, and the admin pastes them into B's
     * chat. The code then activates a phone that signs every entry it records with A's name.
     */
    it('never paints a code minted for one man onto another man’s page', async () => {
      gateway.issueGate = deferred();
      await render(MockCompanyGateway.ZORAN_ID);
      await press('Napravi novi kod');
      button('Da, napravi novi').click();
      await settle();

      // He goes back to the list and opens Marko while Zoran's POST is in flight.
      await goTo(MockCompanyGateway.MARKO_ID);
      expect(text()).toContain('Trenutno nema kod koji bi mogao da ukuca.');

      gateway.issueGate.release();
      await settle();

      // The code really was issued — for Zoran, on the server. None of it is on Marko's page.
      expect(gateway.issues).toEqual([MockCompanyGateway.ZORAN_ID]);
      expect(element.querySelector('[data-code]')).toBeNull();
      expect(text()).not.toMatch(/NEW\d-CODE/);
      expect(text()).not.toContain('Zoran Jovanović');
      // …and Marko's own answer is still the one on screen, rather than an empty card.
      expect(text()).toContain('Trenutno nema kod koji bi mogao da ukuca.');
      expect(text()).toContain('Marko Marković');
    });

    /**
     * The second line of defence, given the witness it did not have.
     *
     * {@link WorkerPage.code} refuses to paint a state that names another man. With both async
     * guards in place no code path can write one, which is exactly why this reaches inside and
     * performs that write by hand: **the fault this filter exists for is a future edit that loses a
     * guard**, or a third code path added without one, and neither can be simulated from outside.
     * Delete the filter and this goes red with one man's live code under another man's name.
     */
    it('refuses to paint a code state that names another man, whatever wrote it', async () => {
      await render(MockCompanyGateway.MARKO_ID);
      expect(text()).toContain('Trenutno nema kod koji bi mogao da ukuca.');

      const internals = fixture.componentInstance as unknown as {
        codeState: WritableSignal<CodeState | null>;
      };
      internals.codeState.set({
        workerId: MockCompanyGateway.ZORAN_ID,
        loading: false,
        status: 'ok',
        code: { code: MockCompanyGateway.LIVE_CODE, expiresAt: null, emailDelivery: null },
        shareText: `Zdravo Zoran Jovanović, kod: ${MockCompanyGateway.LIVE_CODE}`,
        noLiveCode: false,
        afterIssue: true,
      });
      await settle();

      // Nothing of the other man reaches the glass: not the code, not the message that names him.
      // (There is no positive assertion about Marko's own code state here on purpose — the write
      // above *replaced* it, so this spec can only be about what the filter refuses. The state
      // surviving a late write is what the issue-guard spec above proves.)
      expect(element.querySelector('[data-code]')).toBeNull();
      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(text()).not.toContain('Zoran Jovanović');
      expect(buttons().some((b) => /Kopiraj/i.test(b.textContent ?? ''))).toBe(false);
      // …and the man on screen is still the man in the URL.
      expect(text()).toContain('Marko Marković');
    });

    /**
     * The busy flags describe a call, and a call is about one man.
     *
     * Navigate away mid-issue and, before `reset()` cleared them, the next man's page rendered
     * "Pravljenje koda…" over a disabled button describing a request that was never about him — and
     * a request that hangs left him dead-buttoned until a reload.
     */
    it('does not describe the man you left as busy on the man you arrive at', async () => {
      gateway.issueGate = deferred();
      await render(MockCompanyGateway.ZORAN_ID);
      await press('Napravi novi kod');
      button('Da, napravi novi').click();
      await settle();
      expect(text()).toContain('Pravljenje koda…');

      await goTo(MockCompanyGateway.MARKO_ID);

      expect(text()).not.toContain('Pravljenje koda…');
      expect(button('Napravi kod').disabled).toBe(false);

      gateway.issueGate.release();
      await settle();

      // And the late answer neither unlocks nor re-locks anything on the man now on screen.
      expect(button('Napravi kod').disabled).toBe(false);
      expect(text()).not.toContain('Pravljenje koda…');
    });

    it('drops everything belonging to the man being left', async () => {
      await render(MockCompanyGateway.ZORAN_ID);
      expect(shownCode()).toBe(MockCompanyGateway.LIVE_CODE);

      await goTo(MockCompanyGateway.MARKO_ID);

      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);
      expect(text()).not.toContain('Zoranov telefon');
      // …and the phone list is re-filtered rather than carried over: Marko's own handset is there.
      expect(text()).toContain('Markov telefon');
    });
  });

  // ---- Re-issuing ---------------------------------------------------------------------------

  describe('re-issuing a code', () => {
    it('asks before superseding a code the man may already be holding', async () => {
      await render();

      await press('Napravi novi kod');

      // The question names the consequence rather than saying "are you sure".
      expect(text()).toContain('Kod iznad prestaje da važi čim se napravi novi.');
      expect(gateway.issues).toEqual([]);
      expect(shownCode()).toBe(MockCompanyGateway.LIVE_CODE);
    });

    it('leaves the live code alone when the question is declined', async () => {
      await render();
      await press('Napravi novi kod');

      await press('Otkaži');

      expect(gateway.issues).toEqual([]);
      expect(shownCode()).toBe(MockCompanyGateway.LIVE_CODE);
    });

    /**
     * **The property this feature exists to enforce.**
     *
     * Issuing supersedes: the previous code stops working the instant a new one exists. A screen
     * that still showed the old string would have an owner reading a dead code down the phone while
     * a foreman typed it at a locked door.
     */
    it('replaces the superseded code on screen, and never shows it again', async () => {
      await render();
      await press('Napravi novi kod');

      await press('Da, napravi novi');

      const shown = shownCode();
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
     * A refused issue changed nothing. An issue that never got a verdict **may well have superseded
     * the code the man is holding** — so the screen must not call it a failure and invite another
     * press, because a second press would supersede a code that already exists.
     */
    it('does not call an unanswered issue a failure', async () => {
      gateway.issueError = httpError(500);
      await render();
      await press('Napravi novi kod');

      await press('Da, napravi novi');

      expect(text()).toContain('Server nije odgovorio, pa se ne zna da li je napravljen novi kod.');
      expect(text()).not.toContain('Kod nije mogao da se pročita');
      expect(text()).not.toContain(MockCompanyGateway.LIVE_CODE);
    });

    it('says plainly when the server refused the issue, because nothing changed', async () => {
      gateway.issueError = httpError(403);
      await render();
      await press('Napravi novi kod');

      await press('Da, napravi novi');

      expect(text()).toContain('Ovaj nalog to ne sme.');
      expect(text()).not.toContain('Server nije odgovorio, pa se ne zna');
    });

    it('refreshes what the list said about him, since a new code changes it', async () => {
      await render();
      const before = gateway.workerListings;

      await press('Napravi novi kod');
      await press('Da, napravi novi');

      expect(gateway.workerListings).toBe(before + 1);
    });
  });

  describe('a read that fails after a mutation', () => {
    /**
     * **The code the admin has just minted is the only copy of it he will ever see.**
     *
     * Issuing supersedes: the man's previous code is dead the instant this one exists. So a
     * background re-read of the man — which is only there to refresh his chips and his phone count
     * — must never be able to turn the page into an error and take that value off the screen.
     */
    it('never takes a freshly minted code off the screen', async () => {
      await render(MockCompanyGateway.MARKO_ID);

      // The refresh after the issue is the call that fails, not the issue itself.
      gateway.workersError = httpError(500);
      await press('Napravi kod');

      expect(shownCode()).toContain('NEW');
      expect(text()).not.toContain('Poslovođa nije mogao da se pročitaju');
      expect(text()).toContain('Marko Marković');
    });

    /**
     * "He has no phone joined yet" and "the phone list could not be read" are opposite claims about
     * the same empty card — and the second one decides whether an owner believes a handset that
     * walked off site can still record.
     */
    it('says the phones could not be read instead of saying he has none', async () => {
      gateway.devicesError = httpError(500);
      await render();

      expect(text()).toContain('Telefoni nisu mogli da se pročitaju.');
      expect(text()).toContain('Server trenutno ne odgovara.');
      expect(text()).not.toContain('Nijedan telefon nije još pridružen');
      // …and the man himself is still readable, with his code: the phone list decorates this page.
      expect(shownCode()).toBe(MockCompanyGateway.LIVE_CODE);
    });
  });

  // ---- The share text -----------------------------------------------------------------------

  describe('sharing a code', () => {
    /**
     * Decision 13 made easy rather than merely required: **one worker's ready-made message, for one
     * chat**. A message carrying six codes and six names in a site group lets any man in that chat
     * activate a phone under another man's name.
     */
    it('copies one man’s message, naming him and nobody else', async () => {
      await render();

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

      await press('Kopiraj kod');

      expect(writeText).toHaveBeenCalledWith(MockCompanyGateway.LIVE_CODE);
      expect(text()).toContain('Kod je kopiran.');
    });

    it('says out loud that a code goes to one man and not into a group', async () => {
      await render();

      expect(text()).toContain('Jedan čovek, jedna poruka.');
      expect(buttons().some((candidate) => /svi|sve kod/i.test(candidate.textContent ?? ''))).toBe(
        false,
      );
    });

    /**
     * `navigator.clipboard` is absent in an insecure context and rejects when the document is not
     * focused — both entirely ordinary on an office tablet. The code is selectable text either way,
     * so this is a hint and never an error, and it must not claim a copy that did not happen.
     */
    it('falls back to a hint when the clipboard refuses', async () => {
      stubClipboard(() => Promise.reject(new Error('not focused')));
      await render();

      await press('Kopiraj kod');

      expect(text()).toContain('Aplikacija nije uspela da koristi ostavu.');
      expect(text()).not.toContain('Kod je kopiran.');
      expect(shownCode()).toBe(MockCompanyGateway.LIVE_CODE);
    });

    it('survives a browser with no clipboard API at all', async () => {
      Reflect.deleteProperty(navigator, 'clipboard');
      await render();

      await press('Kopiraj kod');

      expect(text()).toContain('Aplikacija nije uspela da koristi ostavu.');
    });
  });

  // ---- Revoking a phone ---------------------------------------------------------------------

  describe('revoking a phone', () => {
    it('asks first, naming which phone and whose', async () => {
      await render();

      await press('Opozovi');

      expect(text()).toContain('Opozvati Zoranov telefon — Zoran Jovanović?');
      expect(gateway.revokes).toEqual([]);
    });

    /**
     * The copy `DeviceEndpoints.cs` demands, pinned as a property rather than as a string.
     *
     * Under the shipped client a revoked phone's outbox stops getting through until the man
     * re-activates. An owner pressing this must be told that a day of unsent evidence is about to
     * stop going anywhere — and equally that nothing on the phone is deleted, because the opposite
     * fear is what would stop him revoking a phone that walked off site.
     */
    it('warns what revoking actually costs before he presses it', async () => {
      await render();

      await press('Opozovi');

      const warning = element.querySelector('.confirm')?.textContent ?? '';
      expect(warning).toMatch(/prestaje da se šalje/i);
      expect(warning).toMatch(/ništa se sa telefona ne briše/i);
      expect(warning).toMatch(/novim kodom/i);
    });

    it('withdraws the phone and shows it withdrawn', async () => {
      await render();
      await press('Opozovi');

      await press('Opozovi telefon');

      expect(gateway.revokes).toEqual([MockCompanyGateway.ZORAN_PHONE_ID]);
      const phones = element.querySelector('.phones')?.textContent ?? '';
      expect(phones).toContain('Opozvan');
      // The row survives — a stamp, never a delete, because it is provenance on evidence.
      expect(phones).toContain('Zoranov telefon');
    });

    it('leaves the phone alone when the question is declined', async () => {
      await render();
      await press('Opozovi');

      await press('Otkaži');

      expect(gateway.revokes).toEqual([]);
      expect(text()).not.toContain('Opozvati Zoranov telefon');
    });

    it('shows the work in progress, and refuses a second tap while it runs', async () => {
      await render();
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
      await press('Opozovi');

      await press('Opozovi telefon');

      expect(text()).toContain('Ovaj nalog to ne sme.');
      // Scoped to *his* live phone: the man's older handset is legitimately withdrawn already, and
      // a whole-list assertion would read that stamp as this revoke succeeding.
      expect(phoneRow('Zoranov telefon')).not.toContain('Opozvan');
      expect(phoneRow('Zoranov telefon')).toContain('Opozovi');
    });

    /**
     * A revoke that timed out may well have revoked. Telling an owner "it did not work" would leave
     * him believing a phone he has taken away can still record — which is the one belief this screen
     * must never produce.
     */
    it('never reports a revoke as failed when the server gave no verdict', async () => {
      gateway.revokeError = httpError(500);
      await render();
      await press('Opozovi');

      await press('Opozovi telefon');

      expect(text()).toContain('Server nije odgovorio, pa se ne zna da li je telefon opozvan.');
      expect(text()).not.toContain('Server trenutno ne odgovara.');
    });

    it('offers no withdraw button on a phone that is already withdrawn', async () => {
      await render();

      const revoked = [...element.querySelectorAll('.phone')].find((row) =>
        row.textContent?.includes('Stari telefon'),
      );
      expect(revoked?.textContent).toContain('Opozvan');
      expect(revoked?.querySelector('button')).toBeNull();
    });

    /** Another man's phone is not on this man's page, whatever the company list happens to hold. */
    it('lists only his own phones', async () => {
      await render();

      expect(text()).toContain('Zoranov telefon');
      expect(text()).not.toContain('Markov telefon');
    });

    /**
     * The code is not re-read after a revoke, deliberately: it did not change, and blinking it away
     * while an admin is in the middle of reading it out is a screen fighting the person using it.
     */
    it('leaves the code on screen while it re-reads the man and his phones', async () => {
      await render();
      const reads = gateway.reads.length;

      await press('Opozovi');
      await press('Opozovi telefon');

      expect(shownCode()).toBe(MockCompanyGateway.LIVE_CODE);
      expect(gateway.reads.length).toBe(reads);
    });
  });

  /**
   * Decision 9: every screen ships a deliberate layout for all three device classes. Read off the
   * shipped stylesheet, because a media query has no DOM to interrogate under jsdom — the widths
   * themselves were checked in a browser at 375, 768, 834, 1280 and 1920.
   */
  describe('three device classes', () => {
    const rules = readFileSync(
      join(process.cwd(), 'src', 'app', 'features', 'company', 'worker-page.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, ' ');

    it('gives a phone chrome of its own, since the app header starts at 768', () => {
      expect(rules).toMatch(
        /@media \(min-width: 768px\)\s*\{\s*\.bar--compact\s*\{\s*display: none/,
      );
    });

    /**
     * Designed by subtraction since the rail went: one column of the two things an admin came here
     * to do. Nothing in the sheet keeps a second column alive at any width.
     */
    it('designs the medium class instead of stretching the phone through it', () => {
      expect(rules).not.toContain('pane--aside');
      expect(rules).not.toContain('pane--primary');
      expect(rules).toContain('.code-block');
      expect(rules).toContain('.phones-block');
    });

    it('gives the expanded class a real application layout, not a centred phone column', () => {
      const expanded = rules.split('@media (min-width: 1024px)')[1] ?? '';
      expect(expanded).toContain('grid-template-columns: repeat(12, 1fr)');
      // The two things he came here to do, side by side, with no rail taking a fifth of the width.
      expect(expanded).toMatch(/\.code-block\s*\{[^}]*span 7/);
      expect(expanded).toMatch(/\.phones-block\s*\{[^}]*span 5/);
    });

    it('takes every colour from the design tokens', () => {
      expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
  });
});
