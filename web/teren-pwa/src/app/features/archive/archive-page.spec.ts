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
import { describeClick } from '../../core/telemetry/action-descriptor';
import { ACTIONS } from '../../core/telemetry/actions';
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
    failure_reason: null,
    supersedes_entry_id: null,
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

  /**
   * The trap the arrival fold was written around.
   *
   * This list is a **merge**: the phone’s rows paint first and the server’s land a moment later. A
   * naive "animate anything that was not in the previous render" would therefore treat the server’s
   * whole archive as newly arrived and bounce every row of it, on every single load — the exact
   * noise the mechanism exists to prevent, delivered by the mechanism itself. So the first
   * *complete* list is adopted silently (`archive-page.ts`, `ui/arrival.ts`).
   *
   * **The server answer is held open on purpose, and the first cut of this spec did not do that.**
   * A `mockResolvedValue` settles in a microtask — before Dexie has answered — so the merge was
   * already complete on the first fold and the `remoteLoaded()` half of the guard was never needed:
   * deleting it left this green (found in review). Here the phone’s row is on screen *first*, with
   * the server still owing an answer, so the fold genuinely has to wait for the second half.
   */
  it('does not animate the server’s rows landing behind the phone’s', async () => {
    await captureEntry(store, { project: PROJECT });

    let answer!: (value: unknown) => void;
    archive.listEntries.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const element = await render();
    // The phone’s one row, painted while the server is still owing its list.
    await waitForRows(element, 1);

    answer({
      status: 'ok',
      items: [listItem({ id: 'srv-1' }), listItem({ id: 'srv-2', entry_date: '2026-08-19' })],
    });
    await waitForRows(element, 3);

    expect(element.querySelectorAll('.row-arriving')).toHaveLength(0);
  });

  /**
   * **Below 1024 the list is removed when a record is opened**, and coming back rebuilds every row.
   * Ids still sitting in the fold would animate a second time, on rows the reader has already seen
   * — the same noise from the other direction. A list that stops being drawn has been seen or
   * missed; either way it is no longer arriving (`settle`, ui/arrival.ts).
   */
  it('does not replay an arrival when the compact list is rebuilt', async () => {
    await captureEntry(store, { project: PROJECT });
    const element = await render();
    await waitForRows(element, 1);

    // A second day lands while he is looking at the list: that row is arriving.
    await captureEntry(store, { project: PROJECT, capturedAt: '2026-08-19T08:00:00.000Z' });
    await waitForRows(element, 2);
    expect(element.querySelectorAll('.row-arriving').length).toBe(1);

    // He opens a record — on a phone that removes the list entirely — and comes back.
    await router.navigate(['/diary'], { queryParams: { [ARCHIVE_ENTRY_PARAM]: 'x' } });
    fixture.detectChanges();
    await router.navigate(['/diary']);
    fixture.detectChanges();
    await waitForRows(element, 2);

    expect(
      element.querySelectorAll('.row-arriving').length,
      'a row he has already seen animates again on the way back from a record',
    ).toBe(0);
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
    expect(element.querySelector('.partial')!.textContent).not.toContain(
      'samo ono što je na ovom telefonu',
    );
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

  /*
   * ---- The wasted tap, and both ends of a correction (2026-09-03) -----------------------------
   *
   * `GET /api/entries` carries `failure_reason` and `supersedes_entry_id` on every row now, so the
   * list can finally tell a day that is merely waiting from a day that is stuck, and a replaced day
   * from the record that replaced it.
   */

  /**
   * **The wasted tap, removed.**
   *
   * `superseded_after_send` leaves the entry `confirmed` with `reported_at` still null — the exact
   * two facts `canRevise` reads as "he may still change his mind" — so this row used to offer
   * "Ispravi" on the one record whose gate can only say no. Pressing it confirmed successfully, the
   * report pass wrote the same terminal reason back, and the foreman went round again.
   */
  it('stops offering the gate on a record the server refused to seal', async () => {
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [
        listItem({
          id: 'srv-stuck',
          status: 'confirmed',
          reported_at: null,
          failure_reason: 'superseded_after_send',
        }),
      ],
    });

    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.revise__action')).toBeNull();
  });

  /**
   * **The guard bites on one value.** A diagnostic reason the server adds later must not withdraw
   * a correction the foreman is still allowed to make in place — which would be this row silently
   * sealing an entry the server has not.
   */
  it('keeps offering the gate on a confirmed entry carrying some other reason', async () => {
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [
        listItem({
          id: 'srv-open',
          status: 'confirmed',
          reported_at: null,
          failure_reason: 'report_interrupted',
        }),
      ],
    });

    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.revise__action')).not.toBeNull();
  });

  /**
   * **A null reason is silence, not an answer** — and this is the case that has to keep behaving
   * exactly as it did before the field existed.
   *
   * Three situations produce it: a row this phone captured that the server has not listed, a page
   * from a server that predates the field, and a day with nothing wrong. A client that read a
   * missing field as "nothing is wrong" would be right by accident; one that read it as "something
   * is wrong" would withdraw the cheap remedy from every confirmed day in the product.
   */
  it('treats an explicit null reason as silence and leaves the row exactly as it was', async () => {
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [listItem({ id: 'srv-open', status: 'confirmed', reported_at: null })],
    });

    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.revise__action')).not.toBeNull();
  });

  /** …and an older server that does not send the field at all. Two spellings of one silence. */
  it('treats an older server’s missing field as silence too', async () => {
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [
        {
          ...listItem({ id: 'srv-open', status: 'confirmed', reported_at: null }),
          failure_reason: undefined,
        },
      ],
    });

    const element = await render();
    await waitForRows(element, 1);

    expect(element.querySelector('.revise__action')).not.toBeNull();
  });

  /**
   * **Both ends are marked**, because a list where a replaced day and the day that replaced it look
   * identical is a list that produces the wrong record in a dispute.
   *
   * The chips sit beside the status rather than replacing it: what the pipeline is doing with a day
   * and whether that day is still the record are two different facts.
   */
  it('marks the correction and the day it replaced, and does not confuse the two', async () => {
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [
        listItem({ id: 'new', entry_date: '2026-08-30', supersedes_entry_id: 'old' }),
        listItem({ id: 'old', entry_date: '2026-08-27' }),
      ],
    });

    const element = await render();
    await waitForRows(element, 2);

    const rows = [...element.querySelectorAll('.row')];
    expect(rows).toHaveLength(2);
    const chipsOf = (row: Element) =>
      [...row.querySelectorAll('.chip')].map((chip) => chip.textContent?.trim());

    // Newest first, so the correction is the first row.
    expect(chipsOf(rows[0])).toContain(sr.archive.correction.chip);
    expect(chipsOf(rows[0])).not.toContain(sr.archive.correction.replacedChip);
    expect(chipsOf(rows[1])).toContain(sr.archive.correction.replacedChip);
    expect(chipsOf(rows[1])).not.toContain(sr.archive.correction.chip);
  });

  /**
   * …and the replaced day carries the way to the record that replaced it.
   *
   * A correction is very often filed on a *later* day than the one it replaces — `entry_date` is
   * the day it was recorded — so the two rows are usually in different day groups and scrolling to
   * it is not an option. It goes through the archive's own `?entry=` parameter, so at expanded
   * width the record swaps in its pane and the list beside it does not move.
   */
  it('offers the way to the correction from the day it replaced', async () => {
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [
        listItem({ id: 'new', entry_date: '2026-08-30', supersedes_entry_id: 'old' }),
        listItem({ id: 'old', entry_date: '2026-08-27' }),
      ],
    });

    const element = await render();
    await waitForRows(element, 2);
    // `mockResolvedValue`, not a bare spy: this screen *is* `/diary`, so letting the navigation
    // through re-enters the component and leaves a Dexie read running past the teardown that
    // closes the database. What this screen owes is the destination.
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const rows = [...element.querySelectorAll('.row')];
    const control = [...rows[1].parentElement!.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.includes(sr.archive.correction.openReplacement),
    );
    expect(control, 'no way to the correction from the day it replaced').toBeTruthy();

    control!.click();
    expect(navigate).toHaveBeenCalledWith(['/diary'], { queryParams: { entry: 'new' } });
  });

  /**
   * **"Of the days shown here", and the limit is the data's rather than the screen's.**
   *
   * The server sends the forward link on a correction and no reverse link on the original, so the
   * older end is marked by finding the correction beside it. A correction recorded on another
   * foreman's phone leaves the day it replaced unmarked until this device has fetched it — so the
   * absence of the chip is never a claim that a day is the current record.
   */
  it('leaves a day unmarked when the correction is not on the page', async () => {
    archive.listEntries.mockResolvedValue({
      status: 'ok',
      items: [listItem({ id: 'old', entry_date: '2026-08-27' })],
    });

    const element = await render();
    await waitForRows(element, 1);

    const chips = [...element.querySelectorAll('.chip')].map((chip) => chip.textContent?.trim());
    expect(chips).not.toContain(sr.archive.correction.replacedChip);
    expect(element.textContent).not.toContain(sr.archive.correction.openReplacement);
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

  /**
   * What the archive tells the action log (D5).
   *
   * Both are plain presses with nothing to say beyond which control was pressed, so both declare
   * themselves on the element — no component change, and no code between the tap and the
   * navigation. The assertions go through `describeClick` rather than reading the attribute back,
   * because an attribute the descriptor cannot reach is an attribute that records nothing: a slug
   * on a wrapper, or more than eight levels above the button, would pass a `getAttribute` check
   * and still leave the log saying `ui.button.row-button`.
   */
  describe('the action log', () => {
    it('names the row that opens a day', async () => {
      archive.listEntries.mockResolvedValue({ status: 'ok', items: [listItem({ id: 'srv-1' })] });
      const element = await render();
      await waitForRows(element, 1);

      expect(describeClick(element.querySelector('.row'))).toBe(ACTIONS.archiveEntryOpen);
      // …and from the deepest thing under a muddy thumb, not only from the button itself.
      expect(describeClick(element.querySelector('.row__title'))).toBe(ACTIONS.archiveEntryOpen);
    });

    it('names the way back into the gate on the row that offers it', async () => {
      archive.listEntries.mockResolvedValue({
        status: 'ok',
        items: [listItem({ id: 'srv-open', status: 'confirmed', reported_at: null })],
      });
      const element = await render();
      await waitForRows(element, 1);

      expect(describeClick(element.querySelector('.revise__action'))).toBe(ACTIONS.confirmOpen);
    });
  });
});
