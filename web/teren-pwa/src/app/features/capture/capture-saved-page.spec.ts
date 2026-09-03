import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { GeolocationService } from '../../core/media/geolocation.service';
import { IMAGE_COMPRESSOR } from '../../core/media/image-compression';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { describeClick } from '../../core/telemetry/action-descriptor';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { captureEntry } from '../../testing/capture-fixture';
import { flushLiveQueries } from '../../testing/flush';
import { CaptureSavedPage } from './capture-saved-page';

describe('CaptureSavedPage', () => {
  let db: TerenDb;
  let store: EntryStore;
  let fixture: ComponentFixture<CaptureSavedPage>;

  beforeEach(() => {
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    TestBed.configureTestingModule({
      imports: [
        CaptureSavedPage,
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
        { provide: GeolocationService, useValue: { currentFix: async () => null } },
        {
          provide: IMAGE_COMPRESSOR,
          useValue: async () => ({
            blob: new Blob([new Uint8Array([7, 7, 7])], { type: 'image/jpeg' }),
            mimeType: 'image/jpeg',
            width: 1600,
            height: 1200,
          }),
        },
      ],
    });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  async function render(entryId: string): Promise<HTMLElement> {
    fixture = TestBed.createComponent(CaptureSavedPage);
    fixture.componentRef.setInput('entryId', entryId);
    await fixture.whenStable();
    await flushLiveQueries(6);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function selectPhoto(element: HTMLElement): void {
    const input = element.querySelector<HTMLInputElement>('.photos__add input[type=file]');
    const file = new File([new Uint8Array(new Array(64).fill(1))], 'IMG_0042.jpg', {
      type: 'image/jpeg',
      lastModified: Date.parse('2026-08-29T14:05:30.000Z'),
    });
    // jsdom has no `DataTransfer`, and the component only ever reads `files` as an iterable.
    const files = {
      0: file,
      length: 1,
      item: () => file,
      [Symbol.iterator]: () => [file].values(),
    };
    Object.defineProperty(input, 'files', { value: files, configurable: true, writable: true });
    input?.dispatchEvent(new Event('change'));
  }

  it('shows the entry as saved on the phone, with no upload it cannot perform', async () => {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
    const element = await render(entry.id);

    expect(element.textContent).toContain('Unos sačuvan');
    expect(element.textContent).toContain('Sačuvano na telefonu');
    expect(element.textContent).toContain('Snimak 0:41');
  });

  it('adds a photo to a draft and counts it', async () => {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
    const element = await render(entry.id);

    selectPhoto(element);
    await flushLiveQueries(10);
    fixture.detectChanges();

    expect((await db.entries.get(entry.id))?.photoCount).toBe(1);
    expect(element.querySelectorAll('.photos__thumb')).toHaveLength(1);
  });

  it('refuses a photo for an entry already queued, and says which problem it was', async () => {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
    await store.queue(entry.id);
    const element = await render(entry.id);

    selectPhoto(element);
    await flushLiveQueries(10);
    fixture.detectChanges();

    expect(element.textContent).toContain('Unos je već poslat na red za slanje');
    // Not blamed on the camera, and nothing half-written.
    expect(element.textContent).not.toContain('nije mogla da se pripremi');
    expect(await db.media.where({ entryId: entry.id, kind: 'photo' }).count()).toBe(0);
    expect((await db.entries.get(entry.id))?.photoCount).toBe(0);
  });

  it('hands the entry to the outbox on "Gotovo"', async () => {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
    const element = await render(entry.id);

    element.querySelector<HTMLButtonElement>('.btn--primary')?.click();
    await flushLiveQueries(6);

    expect((await db.entries.get(entry.id))?.status).toBe('queued');
    expect(await db.outbox.count()).toBe(1);
  });

  it('keeps the draft out of the abandonment sweep while it is on screen', async () => {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
    await db.entries.update(entry.id, { updatedAt: '2020-01-01T00:00:00.000Z' });
    await render(entry.id);

    // The heartbeat marks it as still being worked on; a sweep must then leave it alone.
    await store.touchDraft(entry.id);
    await store.rescue();

    expect((await db.entries.get(entry.id))?.status).toBe('draft');
  });

  it('says so plainly when the entry is not on this phone', async () => {
    const element = await render(crypto.randomUUID());
    expect(element.textContent).toContain('Ovaj unos nije pronađen na telefonu');
  });

  /**
   * What this screen tells the action log (D5).
   *
   * "Gotovo" declares itself on the control, because it is the money path and an attribute puts no
   * code between the tap and `draft → queued`. The camera cannot: a file input fires the same event
   * whether three pictures were compressed and stored or the entry refused them, and those are
   * different facts.
   */
  describe('the action log', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('names the hand-over to the outbox on the control itself', async () => {
      const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
      const element = await render(entry.id);

      expect(describeClick(element.querySelector('.footer .btn--primary'))).toBe(
        ACTIONS.captureSend,
      );
    });

    it('records a stored photograph as a count, and never as a file name', async () => {
      const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
      const element = await render(entry.id);
      const record = vi.spyOn(ActionLogService.prototype, 'record');

      selectPhoto(element);
      await flushLiveQueries(10);
      fixture.detectChanges();

      expect(record).toHaveBeenCalledWith(ACTIONS.capturePhotoAdd, {
        outcome: 'ok',
        entryId: entry.id,
        detail: { count: 1 },
      });
      // The fixture's file is called `IMG_0042.jpg`, and nothing on the wire may know that.
      expect(JSON.stringify(record.mock.calls)).not.toContain('IMG_0042');
    });

    it('records an entry that would not take the photograph as blocked, not as a failure', async () => {
      const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });
      await store.queue(entry.id);
      const element = await render(entry.id);
      const record = vi.spyOn(ActionLogService.prototype, 'record');

      selectPhoto(element);
      await flushLiveQueries(10);
      fixture.detectChanges();

      expect(record).toHaveBeenCalledWith(ACTIONS.capturePhotoAdd, {
        outcome: 'blocked',
        entryId: entry.id,
        detail: { count: 1 },
      });
    });
  });

  /**
   * **The one screen between recording a correction and queueing it, so it says what it is.**
   *
   * "Gotovo" hands this entry to the outbox, and from there it is a record that replaces another
   * day. A man who tapped the wrong record in the archive has exactly this screen to notice on —
   * after the queue there is no undo, because nothing in this product deletes captured evidence
   * (PROJECT.md principle 3).
   */
  it('says a correction is a correction before it is queued', async () => {
    const entry = await captureEntry(store, {
      project: DEMO_PROJECTS[0],
      supersedesEntryId: 'the-day-being-replaced',
    });

    const element = await render(entry.id);

    expect(element.textContent).toContain(sr.archive.correction.chip);
    expect(element.textContent).toContain(sr.capture.correction.saved);
  });

  it('says nothing of the kind on an ordinary take', async () => {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0] });

    const element = await render(entry.id);

    expect(element.textContent).not.toContain(sr.capture.correction.saved);
  });
});
