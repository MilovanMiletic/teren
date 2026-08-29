import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { EntryStore } from '../../core/db/entry-store';
import { captureEntry } from '../../testing/capture-fixture';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import { ProjectService } from '../../core/projects/project.service';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { HomePage } from './home-page';

describe('HomePage', () => {
  let db: TerenDb;
  let fixture: ComponentFixture<HomePage>;
  let store: EntryStore;

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
      providers: [provideRouter([]), { provide: TEREN_DB, useValue: db }],
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
