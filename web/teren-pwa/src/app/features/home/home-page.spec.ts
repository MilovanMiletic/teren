import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { EntryListItemResponse, EntryListResponse } from '../../core/api/api-types';
import { TerenApiClient } from '../../core/api/teren-api.client';
import { ARCHIVE_ENTRY_PARAM } from '../../core/archive/archive-route';
import { EntryStore } from '../../core/db/entry-store';
import { captureEntry } from '../../testing/capture-fixture';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import { ProjectService } from '../../core/projects/project.service';
import { SESSION_STORAGE_KEY } from '../../core/session/session';
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

  it('offers every demo site in the picker', async () => {
    const element = await render();
    element.querySelector<HTMLButtonElement>('.picker')?.click();
    fixture.detectChanges();

    expect(element.querySelectorAll('.sheet__option')).toHaveLength(DEMO_PROJECTS.length);
    expect(element.textContent).toContain('Stambena zgrada Vojvode Stepe 212');
  });
});
