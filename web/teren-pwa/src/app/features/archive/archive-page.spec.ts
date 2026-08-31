import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { EntryListItemResponse } from '../../core/api/api-types';
import { ARCHIVE_ENTRY_PARAM } from '../../core/archive/archive-route';
import { ArchiveService } from '../../core/archive/archive.service';
import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { ProjectService } from '../../core/projects/project.service';
import { ViewportService } from '../../ui/viewport.service';
import { captureEntry } from '../../testing/capture-fixture';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { ArchivePage } from './archive-page';

const PROJECT = DEMO_PROJECTS[0];

function listItem(overrides: Partial<EntryListItemResponse> & Pick<EntryListItemResponse, 'id'>) {
  return {
    project_id: PROJECT.id,
    entry_date: '2026-08-20',
    status: 'reported',
    created_at: '2026-08-20T13:40:00.000Z',
    received_at: '2026-08-20T13:41:00.000Z',
    reported_at: '2026-08-20T14:00:00.000Z',
    photo_count: 4,
    has_audio: true,
    ...overrides,
  } satisfies EntryListItemResponse;
}

describe('ArchivePage', () => {
  let db: TerenDb;
  let store: EntryStore;
  let router: Router;
  let fixture: ComponentFixture<ArchivePage>;
  let archive: { listEntries: ReturnType<typeof vi.fn>; getEntry: ReturnType<typeof vi.fn> };
  const viewport = { expanded: () => false };
  /** Real, so a spec can blip the network the way the OS does and re-fire the refresh effect. */
  let online: WritableSignal<boolean>;

  async function render(): Promise<HTMLElement> {
    // The archive is scoped to the selected site, so the picker's list has to exist first.
    await TestBed.inject(ProjectService).load();
    fixture = TestBed.createComponent(ArchivePage);
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  async function waitForRows(element: HTMLElement, count: number): Promise<void> {
    await waitUntil(() => element.querySelectorAll('.row').length === count, {
      onTick: () => fixture.detectChanges(),
      describe: `${count} archive row(s)`,
    });
  }

  beforeEach(() => {
    localStorage.clear();
    online = signal(true);
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    archive = {
      listEntries: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
      getEntry: vi.fn().mockResolvedValue({ status: 'ok', entry: null, missing: true }),
    };

    TestBed.configureTestingModule({
      imports: [
        ArchivePage,
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
        provideRouter([{ path: 'diary', component: ArchivePage }]),
        { provide: TEREN_DB, useValue: db },
        { provide: ArchiveService, useValue: archive as unknown as ArchiveService },
        { provide: ConnectivityService, useValue: { online } },
        { provide: ViewportService, useValue: viewport as unknown as ViewportService },
      ],
    });
    store = TestBed.inject(EntryStore);
    router = TestBed.inject(Router);
  });

  afterEach(async () => {
    viewport.expanded = () => false;
    db.close();
    await db.delete();
  });

  it('lists what the phone holds before the server has answered anything', async () => {
    // The archive paints from Dexie. It is readable on a site with no signal, which is where it
    // is read (principle 3).
    await captureEntry(store, { project: PROJECT, photoCount: 2 });
    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.day__label')!.textContent).toContain('Danas');
  });

  it('merges the server’s days with the phone’s, and groups both by day', async () => {
    await captureEntry(store, { project: PROJECT });
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [listItem({ id: 'srv-1' }), listItem({ id: 'srv-2', entry_date: '2026-08-19' })],
    });

    const element = await render();
    await waitForRows(element, 3);

    // Three entries across three days — the phone's today, and the two the server knows.
    expect(element.querySelectorAll('.day')).toHaveLength(3);
  });

  it('says the list is partial rather than letting it look short', async () => {
    // "This site has one entry" and "this is the one entry your phone holds" are different
    // claims, and only one of them is true when the server could not be asked.
    await captureEntry(store, { project: PROJECT });
    archive.listEntries.mockResolvedValue({ status: 'offline', items: [] });

    const element = await render();
    await waitUntil(() => element.querySelector('.partial') !== null, {
      onTick: () => fixture.detectChanges(),
      describe: 'the partial-archive note',
    });

    expect(element.querySelector('.partial')!.textContent).toContain('Nema interneta');
  });

  it('explains an empty archive that is empty only because the server is unreachable', async () => {
    archive.listEntries.mockResolvedValue({ status: 'unavailable', items: [] });

    const element = await render();
    await waitUntil(() => element.textContent!.includes('Server trenutno ne odgovara'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the offline empty state',
    });
  });

  it('opens a record as a query parameter, so the desktop rail is not rebuilt', async () => {
    const entry = await captureEntry(store, { project: PROJECT });
    const element = await render();
    await waitForRows(element, 1);

    element.querySelector<HTMLButtonElement>('.row')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(router.url).toBe(`/diary?${ARCHIVE_ENTRY_PARAM}=${entry.id}`);
  });

  it('replaces the list with the record on a phone', async () => {
    const entry = await captureEntry(store, { project: PROJECT });
    await router.navigate(['/diary'], { queryParams: { [ARCHIVE_ENTRY_PARAM]: entry.id } });

    const element = await render();
    await waitUntil(() => element.querySelector('app-entry-detail') !== null, {
      onTick: () => fixture.detectChanges(),
      describe: 'the record to open',
    });

    // Compact has room for a list or a record, not both.
    expect(element.querySelector('.day__list')).toBeNull();
  });

  it('keeps both panes on a desktop, and marks the open row in the rail', async () => {
    // The founder rule: a desktop layout is designed, not inherited. Here that means master and
    // detail together, because the person going through an archive is comparing days.
    viewport.expanded = () => true;
    const entry = await captureEntry(store, { project: PROJECT });
    await router.navigate(['/diary'], { queryParams: { [ARCHIVE_ENTRY_PARAM]: entry.id } });

    const element = await render();
    await waitUntil(() => element.querySelector('app-entry-detail') !== null, {
      onTick: () => fixture.detectChanges(),
      describe: 'the record to open',
    });

    expect(element.querySelector('.day__list')).not.toBeNull();
    expect(element.querySelector('.row--selected')).not.toBeNull();
  });

  it('tells a desktop user which record to open instead of showing a blank pane', async () => {
    viewport.expanded = () => true;
    await captureEntry(store, { project: PROJECT });

    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.prompt')!.textContent).toContain('Izaberite dan');
  });

  it('says the site has no entries when it genuinely has none', async () => {
    const element = await render();
    await waitUntil(() => element.textContent!.includes('Nema unosa'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the empty state',
    });

    expect(element.textContent).toContain('Snimljeni izveštaji se ovde čuvaju po danima');
  });

  it('keeps server rows already on screen when a refresh fails', async () => {
    // G2. A desktop user is comparing days across the server’s entries, the wifi blips, the
    // effect re-fires and the fetch fails. Rows fetched successfully a second ago must not
    // vanish mid-scroll — that is throwing away something true.
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [listItem({ id: 'srv-1' }), listItem({ id: 'srv-2', entry_date: '2026-08-19' })],
    });

    const element = await render();
    await waitForRows(element, 2);

    // The refresh fails and returns nothing, as a failure does.
    archive.listEntries.mockResolvedValue({ status: 'offline', items: [] });
    online.set(false);
    await waitUntil(() => element.querySelector('.partial') !== null, {
      onTick: () => fixture.detectChanges(),
      describe: 'the partial-archive note',
    });

    // Still both.
    expect(element.querySelectorAll('.row')).toHaveLength(2);
    // And the banner no longer claims this is only what the phone holds, because it is not.
    expect(element.querySelector('.partial')!.textContent).toContain('prikaz možda nije potpun');
    expect(element.querySelector('.partial')!.textContent).not.toContain('samo ono što je na ovom telefonu');
  });

  // ------------------------------------------------- the way back, while the window is open

  it('offers a confirmed entry a way back into the gate, and sends the tap straight there', async () => {
    // The window between `confirmed` and `reported` is the last cheap chance to fix a mistake:
    // afterwards the row is sealed for ever and the only remedy is a whole new correction entry.
    // Before this the way back existed only by typing the URL.
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [listItem({ id: 'srv-open', status: 'confirmed', reported_at: null })],
    });

    const element = await render();
    await waitForRows(element, 1);
    // Spied rather than routed: `/confirm/:entryId` is a lazy route of its own, and what this
    // screen owes is the correct destination.
    const navigate = vi.spyOn(router, 'navigate');

    const action = element.querySelector<HTMLButtonElement>('.revise__action')!;
    expect(action).not.toBeNull();
    // Worded as a second chance at an answer already given, never as an outstanding task.
    expect(action.textContent).toContain('Ispravi');
    expect(element.textContent).not.toContain('Proverite i potvrdite');

    action.click();

    // Straight to the gate, not to the read-only record first.
    expect(navigate).toHaveBeenCalledWith(['/confirm', 'srv-open']);
  });

  it('offers nothing at all on a reported entry, which the server has sealed', async () => {
    archive.listEntries.mockResolvedValue({ status: 'ok', items: [listItem({ id: 'srv-sent' })] });

    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.revise__action')).toBeNull();
  });

  it('withdraws the offer the moment the server stamps a report, whatever the status says', async () => {
    // Two things at once, and both are how this goes wrong in the field. The phone stores a
    // status and never a `reported_at`, so a stale local `confirmed` would keep offering a
    // correction on an entry that can no longer take one. And `reported_at` — not the status —
    // is the field that seals the row: it is stamped by the report pass, it is what the trigger
    // fires on, and it is what `ConfirmService` re-reads to judge a 409. A row that waited for
    // the status to catch up would offer an edit the server has already refused.
    const entry = await captureEntry(store, { project: PROJECT });
    await store.setServerStatus(entry.id, 'confirmed');
    archive.listEntries.mockResolvedValue({ status: 'ok', items: [] });

    const element = await render();
    await waitUntil(() => element.querySelector('.revise__action') !== null, {
      onTick: () => fixture.detectChanges(),
      describe: 'the way back on a locally confirmed entry',
    });

    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [
        listItem({
          id: entry.id,
          entry_date: entry.localDay,
          // Deliberately still `confirmed`: the stamp is what counts, not the label.
          status: 'confirmed',
          reported_at: '2026-08-29T18:00:00.000Z',
        }),
      ],
    });
    online.set(false);

    await waitUntil(() => element.querySelector('.revise__action') === null, {
      onTick: () => fixture.detectChanges(),
      describe: 'the way back to be withdrawn',
    });
  });

  it('never nests the way back inside the row button, which would make it unreachable', async () => {
    // A `<button>` inside a `<button>` is invalid HTML: browsers hoist it out of the row and the
    // keyboard can never reach it, which is precisely the "no discoverable way back" this fixes.
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [listItem({ id: 'srv-open', status: 'confirmed', reported_at: null })],
    });

    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.row')!.querySelector('button')).toBeNull();
  });

  it('names itself in Serbian, the default runtime locale', async () => {
    const element = await render();

    expect(element.querySelector('.head__title')!.textContent).toContain('Dnevnik');
  });
});
