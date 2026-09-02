import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { EntryListItemResponse, EntryListResponse } from '../../core/api/api-types';
import { TerenApiClient } from '../../core/api/teren-api.client';
import { ARCHIVE_ENTRY_PARAM } from '../../core/archive/archive-route';
import { STALLED_AFTER_ATTEMPTS } from '../../core/api/api-failure';
import { EntryStore } from '../../core/db/entry-store';
import { captureEntry } from '../../testing/capture-fixture';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import { ProjectService } from '../../core/projects/project.service';
import { SESSION_STORAGE_KEY } from '../../core/session/session';
import { describeClick } from '../../core/telemetry/action-descriptor';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { routeUrlFor } from '../../testing/route-table';
import { ProfilePage } from '../profile/profile-page';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { HomePage } from './home-page';

/**
 * The server, as far as Home is concerned: one list call, carrying the live status of every entry
 * this project has. Everything else Home does is local.
 */
class FakeApi {
  configured = true;
  entries: EntryListItemResponse[] = [];
  listCalls = 0;
  fail: unknown = null;

  async listEntries(): Promise<EntryListResponse> {
    this.listCalls += 1;
    if (this.fail) {
      throw this.fail;
    }
    return { entries: this.entries, count: this.entries.length };
  }
}

describe('HomePage', () => {
  let db: TerenDb;
  /**
   * The profile screen's URL, out of the real route table, resolved once before any test.
   *
   * In `beforeAll` on purpose: `routeUrlFor` runs a real dynamic `import()`, and doing that inside
   * a 5 s test is how a suite gains a timeout unrelated to the behaviour under test
   * (`device.guard.spec.ts` records the same reasoning).
   */
  let profileUrl: string;

  beforeAll(async () => {
    profileUrl = await routeUrlFor(ProfilePage);
  });

  let fixture: ComponentFixture<HomePage>;
  let store: EntryStore;
  let api: FakeApi;

  async function render(): Promise<HTMLElement> {
    await TestBed.inject(ProjectService).load();
    fixture = TestBed.createComponent(HomePage);
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();
    // The recent list is a Dexie live query, so the screen paints a **skeleton** until the store
    // answers (`home-page.ts`) — an unread list and an empty one are not the same claim, and Home
    // used to print "no entries yet" for the frames in between. Every assertion below is about the
    // settled screen, and a fixed number of ticks is a guess that is right on an idle machine and
    // wrong on a loaded one (see `waitUntil`).
    await waitUntil(() => !(fixture.nativeElement as HTMLElement).querySelector('.card--loading'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the recent list to answer',
    });
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    localStorage.clear();
    api = new FakeApi();
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    TestBed.configureTestingModule({
      imports: [
        HomePage,
        // The real dictionaries: a spec that ships its own copies would happily pass while the
        // shipped Serbian is missing a key.
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
      providers: [
        provideRouter([]),
        { provide: TEREN_DB, useValue: db },
        // Home now re-reads the server's view of this project's entries (B5). The real
        // `ArchiveService` runs on top of this, so the status refresh is exercised rather than
        // stubbed out one layer too high.
        { provide: TerenApiClient, useValue: api as unknown as TerenApiClient },
      ],
    });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  async function captureToday(): Promise<string> {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
    return entry.id;
  }

  it('renders Serbian by default — no English leaks onto a site phone', async () => {
    const element = await render();
    expect(element.textContent).toContain('Snimi izveštaj');
    expect(element.textContent).toContain('Današnji unos');
  });

  it('says today has not been recorded when the store is empty', async () => {
    const element = await render();
    expect(element.textContent).toContain('Još nije unet');
    expect(element.textContent).toContain('Za ovo gradilište još nema unosa');
  });

  it('reports today as recorded once an entry exists locally, with no network involved', async () => {
    await captureToday();
    const element = await render();

    expect(element.textContent).toContain('Unet u');
    expect(element.textContent).not.toContain('Još nije unet');
  });

  /**
   * The founder's *"when some new entry was added"*, pinned where it can actually be seen.
   *
   * The set logic has its own spec (`ui/arrival.spec.ts`); this is about the wiring — that the
   * class lands on the row that arrived and on no other, and, the half that matters more, **that a
   * list does not animate on its first paint.** Twelve rows bouncing in every time he opens Home is
   * decoration, and it would destroy the meaning of the one gesture that says *this is the new one*.
   */
  it('draws only the row that arrived while he was looking at the screen', async () => {
    // Explicit timestamps, because the list is ordered by `capturedAt` and two captures a
    // millisecond apart would leave which row is "first" up to the clock.
    const project = DEMO_PROJECTS[0];
    const now = Date.now();
    await captureEntry(store, { project, capturedAt: new Date(now - 60_000).toISOString() });

    const element = await render();
    await waitUntil(() => element.querySelectorAll('.recent__row').length === 1, {
      onTick: () => fixture.detectChanges(),
      describe: 'the first recent row',
    });

    // First paint: the screen was opened, nothing arrived.
    expect(element.querySelectorAll('.row-arriving').length).toBe(0);

    await captureEntry(store, { project, capturedAt: new Date(now).toISOString() });
    await waitUntil(() => element.querySelectorAll('.recent__row').length === 2, {
      onTick: () => fixture.detectChanges(),
      describe: 'the second recent row',
    });

    const arriving = element.querySelectorAll('.row-arriving');
    expect(arriving.length, 'exactly the new row animates, not the list').toBe(1);
    // The newest entry is first in the list, which is the row that should be moving.
    expect(element.querySelectorAll('.recent__row')[0].classList).toContain('row-arriving');
  });

  it('shows a truthful pending count, read from the store', async () => {
    const element = await render();
    expect(element.textContent).toContain('Sve poslato');

    const id = await captureToday();
    await flushLiveQueries();
    fixture.detectChanges();

    // A draft nobody has queued yet is still unsent: "Sve poslato" over one would be a lie.
    expect(element.textContent).toContain('Čekaju slanje: 1');

    await store.queue(id);
    await flushLiveQueries();
    fixture.detectChanges();

    // And queueing it must not double-count the same entry.
    expect(element.textContent).toContain('Čekaju slanje: 1');
  });

  it('stops saying "waiting to upload" over an entry that is not getting through', async () => {
    const id = await captureToday();
    await store.queue(id);
    const element = await render();
    await waitUntil(() => element.textContent!.includes('Čekaju slanje: 1'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the pending count to appear',
    });

    // The server refused it. The count is still 1 and still true, but "waiting to upload" now
    // describes something that will never happen, and this is the screen he actually looks at.
    await store.setOutboxState(id, 'blocked', { failureKind: 'rejected' });
    await waitUntil(() => element.textContent!.includes('Ne prolazi: 1'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the sync row to report the stuck entry',
    });

    expect(element.textContent).not.toContain('Čekaju slanje');
    expect(element.querySelector('.sync__icon--err')).not.toBeNull();
  });

  it('says the same thing on a recent row as the sync row does', async () => {
    const id = await captureToday();
    await store.queue(id);
    await store.setOutboxState(id, 'blocked', { failureKind: 'unauthorized' });
    const element = await render();
    await waitUntil(() => element.textContent!.includes('Ne može da se pošalje'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the recent row to report the blocked entry',
    });

    // A recent row reading "Čeka mrežu" beside a sync row reading "Ne prolazi" would leave the
    // foreman to work out which of his own screens to believe.
    expect(element.querySelector('.chip--err')).not.toBeNull();
  });

  // ---------------------------------------------------------- the confirmation gate (B5)

  /** An entry as the upload path leaves it: the server has it, and nobody has re-read it since. */
  async function givenUploadedEntry(serverStatus = 'received'): Promise<string> {
    const id = await captureToday();
    await store.markConfirmedByServer(id, { serverStatus });
    return id;
  }

  function serverSays(id: string, status: string): EntryListItemResponse {
    return {
      id,
      project_id: DEMO_PROJECTS[0].id,
      entry_date: '2026-08-29',
      status,
      created_at: '2026-08-29T10:00:00.000Z',
      received_at: '2026-08-29T10:05:00.000Z',
      reported_at: null,
      photo_count: 0,
      has_audio: true,
    };
  }

  it('stops calling an entry "Primljen" once the server is waiting for the foreman', async () => {
    // The defect B5 had to fix. `serverStatus` was written once, at upload time, and never
    // refreshed — so Home said "Primljen" over entries parked in `needs_review`. "Primljen"
    // reads as *done, nothing to do*, so the entry that needed him was the one he never opened,
    // and the day's evidence never became a report.
    const id = await givenUploadedEntry();
    api.entries = [serverSays(id, 'needs_review')];

    const element = await render();
    await waitUntil(() => element.textContent!.includes('Potrebna provera'), {
      onTick: () => fixture.detectChanges(),
      describe: 'Home to pick up the live status',
    });

    expect(element.textContent).not.toContain('Primljen');
  });

  it('says out loud how many entries are waiting for him', async () => {
    const id = await givenUploadedEntry();
    api.entries = [serverSays(id, 'awaiting_confirmation')];

    const element = await render();
    await waitUntil(() => element.querySelector('.notice--action') !== null, {
      onTick: () => fixture.detectChanges(),
      describe: 'the attention row to appear',
    });

    expect(element.textContent).toContain('1 unos čeka na vas');
    expect(element.textContent).toContain('Proverite šta je sistem razumeo');
  });

  it('keeps the attention row off the screen when nothing is waiting', async () => {
    const id = await givenUploadedEntry();
    api.entries = [serverSays(id, 'confirmed')];

    const element = await render();
    await waitUntil(() => element.textContent!.includes('Potvrđen'), {
      onTick: () => fixture.detectChanges(),
      describe: 'Home to pick up the live status',
    });

    expect(element.querySelector('.notice--action')).toBeNull();
  });

  it('sends a recent row that needs a person to the gate, and every other row to the record', async () => {
    const waiting = await givenUploadedEntry('needs_review');
    const done = await givenUploadedEntry('reported');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate');
    const element = await render();
    await waitUntil(() => element.querySelectorAll('.recent__row').length === 2, {
      onTick: () => fixture.detectChanges(),
      describe: 'both recent rows to render',
    });

    const rows = [...element.querySelectorAll<HTMLButtonElement>('.recent__row')];
    // Newest first, and `done` was captured second.
    rows[0].click();
    expect(navigate).toHaveBeenCalledWith(['/diary'], {
      queryParams: { [ARCHIVE_ENTRY_PARAM]: done },
    });

    rows[1].click();
    // The archive is a read-only record: sending him there over an entry that is waiting for him
    // would show the problem and hide the only control that fixes it.
    expect(navigate).toHaveBeenCalledWith(['/confirm', waiting]);
  });

  /**
   * The way to his own account, and — on a phone — the only one there is.
   *
   * F5 put an account pill in Home's centre column. The founder took it out on 2026-08-31: the
   * centre column is about entries and reports, and the profile belongs in the header beside the
   * language switcher. But `app-header.ts` is hidden below 768, so a header-only icon would leave
   * the foreman with no route to his own account at all — which
   * `plans/profile-and-identity.md` decision 9 (*every screen is visible on every device*) does
   * not allow.
   *
   * So the compact affordance sits at the foot of the scroll beside the language switcher, which
   * is the placement that component already uses for the same reason. **Delete it and this spec
   * goes red** — that is its whole job. Asserted inside `.home-footer` specifically, because the
   * header renders in jsdom regardless of the media query that hides it, and a query across the
   * whole screen would find the header's copy and pass on a phone that had lost it.
   */
  it('keeps a way to his own account on a phone, at the foot of the scroll', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate');
    const element = await render();

    const link = element.querySelector<HTMLButtonElement>('.home-footer .profile-link');
    expect(link, 'the phone has no way to reach the profile screen').not.toBeNull();
    // Beside the language switcher, not somewhere else in the footer.
    expect(element.querySelector('.home-footer app-language-switcher')).not.toBeNull();

    link?.click();
    // Resolved from the shipped route table, never spelled out here.
    expect(navigate).toHaveBeenCalledWith([profileUrl]);
  });

  /**
   * The other half of the founder's instruction: *"centered screen should only be about the
   * entries and reports"*.
   *
   * The F5 pill carried his name under the recent entries. Nothing in the content column may
   * carry the account any more — the icon in the chrome is the whole affordance.
   */
  it('no longer carries an account row in the content column', async () => {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        token: 'trn_d_token',
        deviceId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
        username: 'zoran.jovanovic',
        displayName: 'Zoran Jovanović',
        companyId: '33333333-3333-3333-3333-333333333333',
        companyName: 'Vodoinstal Petrović d.o.o.',
        activatedAt: '2026-08-30T08:00:00.000Z',
      }),
    );

    const element = await render();

    expect(element.querySelector('.account')).toBeNull();
    // The name it used to show is on the profile screen now, and nowhere on Home.
    expect(element.querySelector('.content')?.textContent).not.toContain('Zoran Jovanović');
  });

  it('keeps what it knew when the server cannot be reached', async () => {
    // A refresh reports; it never erases. Blanking a status because the wifi blipped would make
    // Home forget something it correctly knew.
    const id = await givenUploadedEntry('needs_review');
    api.fail = new HttpErrorResponse({ status: 0, statusText: 'offline' });

    const element = await render();
    await waitUntil(() => api.listCalls > 0, {
      onTick: () => fixture.detectChanges(),
      describe: 'the refresh to be attempted',
    });
    fixture.detectChanges();

    expect(element.textContent).toContain('Potrebna provera');
  });

  it('reaches the language switcher from Home, and the choice persists', async () => {
    const element = await render();

    // Home is the entry page: the switcher has to be reachable here, not only from Pending.
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.langs__button'));
    expect(buttons.length).toBeGreaterThan(0);

    buttons.find((button) => button.textContent?.includes('English'))?.click();
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();

    expect(element.textContent).toContain('Record report');
    expect(element.textContent).toContain("Today's entry");
    expect(localStorage.getItem('teren.language')).toBe('en');
  });

  it('renders the application header for the wide layouts', async () => {
    const element = await render();
    // Hidden by CSS below 768; present in the DOM so the wide layouts have their chrome.
    expect(element.querySelector('app-header')).not.toBeNull();
    expect(element.querySelector('app-header .header__project--pickable')).not.toBeNull();
  });

  it('groups the content into the two panes the expanded grid places', async () => {
    const element = await render();
    expect(element.querySelector('.pane--primary .today')).not.toBeNull();
    expect(element.querySelector('.pane--primary .record')).not.toBeNull();
    expect(element.querySelector('.pane--secondary .sync')).not.toBeNull();
    expect(element.querySelector('.pane--secondary .recent')).not.toBeNull();
  });

  /**
   * F8 — the revocation surface on the screen the foreman actually looks at.
   *
   * The property that matters most here is the one asserted last: **it is a notice, never a
   * gate.** A revoked phone keeps recording, and it must, because the phone is the source of truth
   * until the server confirms receipt (PROJECT.md principle 3). Locking the record button over a
   * credential problem would turn an administrative mistake at 4 p.m. into a lost afternoon of
   * evidence, which is the trade this product exists to refuse.
   */
  describe('when the server stops accepting this phone', () => {
    async function refusedTimes(attempts: number): Promise<string> {
      const id = await captureToday();
      await store.queue(id);
      // `in_flight` is the only thing that increments the counter, so a row refused eight times
      // is built the way the sync loop would really have built it.
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await store.setOutboxState(id, 'in_flight');
      }
      await store.setOutboxState(id, 'failed', {
        failureKind: 'unauthenticated',
        nextAttemptAt: new Date(Date.now() + 600_000).toISOString(),
      });
      return id;
    }

    it('says nothing over a single refused attempt', async () => {
      // One 401 is what a token being replaced looks like from here, and the queue heals itself
      // within the minute. A notice here would be the app crying wolf on its own front door.
      await refusedTimes(1);
      const element = await render();
      await flushLiveQueries();
      fixture.detectChanges();

      expect(element.textContent).not.toContain('Server ne prihvata ovaj telefon');
    });

    it('offers the way back in once being refused is the verdict', async () => {
      await refusedTimes(STALLED_AFTER_ATTEMPTS);
      const element = await render();
      await waitUntil(() => element.textContent!.includes('Server ne prihvata ovaj telefon'), {
        onTick: () => fixture.detectChanges(),
        describe: 'the reactivation notice to appear',
      });

      // Both halves, always: nothing is getting through, and nothing has been lost.
      expect(element.textContent).toContain('Unosi su bezbedni');

      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      element.querySelector<HTMLButtonElement>('.notice--err')?.click();

      expect(navigate).toHaveBeenCalledWith(['/activate'], { queryParams: { next: '/' } });
    });

    it('leaves the record button exactly where it was', async () => {
      await refusedTimes(STALLED_AFTER_ATTEMPTS);
      const element = await render();
      await waitUntil(() => element.textContent!.includes('Server ne prihvata ovaj telefon'), {
        onTick: () => fixture.detectChanges(),
        describe: 'the reactivation notice to appear',
      });

      // The door is never locked. He can go on capturing the day, and should: every entry he
      // records now goes out the moment the credential is good again.
      const record = element.querySelector<HTMLButtonElement>('.record__button');
      expect(record).not.toBeNull();
      expect(record?.disabled).toBe(false);
    });
  });

  it('offers every demo site in the picker', async () => {
    const element = await render();
    element.querySelector<HTMLButtonElement>('.picker')?.click();
    fixture.detectChanges();

    expect(element.querySelectorAll('.sheet__option')).toHaveLength(DEMO_PROJECTS.length);
    expect(element.textContent).toContain('Stambena zgrada Vojvode Stepe 212');
  });

  /**
   * The expanded layout, read off the shipped stylesheet — a media query has no DOM to interrogate
   * under jsdom, and `/company`'s own spec already sets this precedent.
   *
   * It exists because the founder looked at this screen on a 1920 and said *"use the space"*. The
   * layout was a 12-column grid that did not claim the window's **height**: the whole screen
   * finished in the top third and the rest was warm canvas. Both rules below are that fix, and
   * both are the kind that a later tidy-up deletes without noticing, because nothing renders
   * differently on the phone the change would be tested on.
   */
  describe('expanded layout', () => {
    const css = readFileSync(
      join(process.cwd(), 'src', 'app', 'features', 'home', 'home-page.css'),
      'utf8',
    );
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

    /**
     * Every block introduced by `header`, brace-matched.
     *
     * `split()` on the header is not enough and is the trap worth naming: a segment runs to the
     * *next* header, so it carries every rule that follows the block as well — and an assertion
     * over that is an assertion over most of the stylesheet, which passes for reasons that have
     * nothing to do with the block it claims to be about.
     */
    function mediaBlocks(header: string): string[] {
      const bodies: string[] = [];
      for (let at = rules.indexOf(header); at !== -1; at = rules.indexOf(header, at + 1)) {
        const open = rules.indexOf('{', at);
        let depth = 0;
        for (let i = open; i < rules.length; i++) {
          if (rules[i] === '{') {
            depth++;
          } else if (rules[i] === '}' && --depth === 0) {
            bodies.push(rules.slice(open + 1, i));
            break;
          }
        }
      }
      return bodies;
    }

    const expanded = mediaBlocks('@media (min-width: 1024px)');

    it('claims the height of the window, not just its width', () => {
      const layout = expanded.find((block) => block.includes('.content {')) ?? '';

      // `.screen` is a 100dvh flex column (styles.css), so these are the two declarations that
      // make the grid's second row reach the foot of a 1080 px window instead of stopping at its
      // content. Without them the panes are correctly placed and the page is still two-thirds
      // empty warm canvas, which is exactly what the founder photographed.
      expect(layout).toMatch(/\.content \{[^}]*flex-grow: 1/);
      expect(layout).toMatch(/\.content \{[^}]*align-items: stretch/);
    });

    it('gives the height it claimed to the one action the screen exists for', () => {
      const pane = expanded.find((block) => block.includes('.record {')) ?? '';

      // The capture card takes whatever the day card leaves, so the record button is the largest
      // object on a desktop rather than a phone button that happened to be centred.
      expect(pane).toMatch(/\.record \{[^}]*flex-grow: 1/);
      // A floor, so the card never collapses onto the mic on a 1280×720 laptop.
      expect(pane).toMatch(/\.record \{[^}]*min-height/);
      // And deliberately **no ceiling**, in either block: a capped card leaves warm canvas under a
      // white slab, which is the worst of both — the pane either reaches the foot of the window or
      // it should not have been a pane.
      expect(rules).not.toMatch(/\.record \{[^}]*max-height/);
    });
  });

  /**
   * What Home tells the action log (D5).
   *
   * The recent row is the one control in the app that is two actions: an entry the server has
   * handed back opens the confirmation gate and every other one opens the record. A `data-log`
   * would have to claim one of them and would be wrong about the other, so the branch records.
   * "Sve" is a plain press and declares itself.
   */
  describe('the action log', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('names the way into the archive on the control itself', async () => {
      const element = await render();

      expect(describeClick(element.querySelector('.recent__all'))).toBe(ACTIONS.archiveOpen);
    });

    it('records which of the two things a recent row did, and about which entry', async () => {
      const waiting = await givenUploadedEntry('needs_review');
      const done = await givenUploadedEntry('reported');
      vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const element = await render();
      await waitUntil(() => element.querySelectorAll('.recent__row').length === 2, {
        onTick: () => fixture.detectChanges(),
        describe: 'both recent rows to render',
      });
      const record = vi.spyOn(ActionLogService.prototype, 'record');

      const rows = [...element.querySelectorAll<HTMLButtonElement>('.recent__row')];
      // Newest first, and `done` was captured second.
      rows[0].click();
      expect(record).toHaveBeenCalledWith(ACTIONS.archiveEntryOpen, { entryId: done });

      rows[1].click();
      expect(record).toHaveBeenCalledWith(ACTIONS.confirmOpen, { entryId: waiting });
    });
  });
});
