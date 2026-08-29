import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { captureEntry } from '../../testing/capture-fixture';
import { flushLiveQueries } from '../../testing/flush';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { PendingPage } from './pending-page';

describe('PendingPage', () => {
  let db: TerenDb;
  let store: EntryStore;
  let fixture: ComponentFixture<PendingPage>;
  const online = { online: () => true };

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(PendingPage);
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
        PendingPage,
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
        { provide: ConnectivityService, useValue: online },
      ],
    });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  async function queueOne(photoCount = 2): Promise<string> {
    const entry = await captureEntry(store, { project: DEMO_PROJECTS[0], photoCount });
    await store.queue(entry.id);
    return entry.id;
  }

  it('shows the empty state, and never claims a server confirmation it does not have', async () => {
    const element = await render();
    expect(element.textContent).toContain('Sve je poslato');
    expect(element.textContent).toContain('Nijedan unos ne čeka slanje');
    expect(element.querySelector('.head__count')?.textContent?.trim()).toBe('0');
  });

  it('lists a queued entry after it was handed to the outbox, with its real counts', async () => {
    await queueOne(2);
    const element = await render();

    expect(element.querySelectorAll('.row')).toHaveLength(1);
    expect(element.textContent).toContain('Čeka mrežu');
    expect(element.textContent).toContain('Snimak 0:41');
    // Serbian plural: two photos is the "few" form.
    expect(element.textContent).toContain('2 fotografije');
    expect(element.querySelector('.head__count')?.textContent?.trim()).toBe('1');
  });

  it('always states the trust note — sync state is never a toast', async () => {
    const element = await render();
    expect(element.textContent).toContain('Ništa se ne briše sa telefona');
  });

  it('shows the offline card only when the OS reports no network', async () => {
    const element = await render();
    expect(element.querySelector('.offline')).toBeNull();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [
        PendingPage,
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
        { provide: ConnectivityService, useValue: { online: () => false } },
      ],
    });

    const offlineElement = await render();
    expect(offlineElement.querySelector('.offline')).not.toBeNull();
    expect(offlineElement.textContent).toContain('Nema interneta');
  });

  it('summarises the queue by state for the expanded rail', async () => {
    await queueOne(1);
    const element = await render();

    const rows = Array.from(element.querySelectorAll('.summary__row')).map((row) => [
      row.querySelector('.summary__name')?.textContent?.trim(),
      row.querySelector('.summary__value')?.textContent?.trim(),
    ]);
    expect(rows).toEqual([
      ['Čeka mrežu', '1'],
      ['Šalje se', '0'],
      ['Nije poslato', '0'],
      ['Ukupno', '1'],
    ]);
  });

  it('switches the whole screen to English from the language switcher', async () => {
    await queueOne(1);
    const element = await render();

    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.langs__button'));
    buttons.find((button) => button.textContent?.includes('English'))?.click();
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();

    expect(element.textContent).toContain('Waiting to upload');
    expect(element.textContent).toContain('Waiting for network');
    expect(element.textContent).toContain('1 photo');
  });
});
