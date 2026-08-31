import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';

import { ConnectivityService } from '../../core/connectivity.service';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { DEMO_PROJECTS } from '../../core/projects/project-source';
import { UploadService } from '../../core/sync/upload.service';
import { captureEntry } from '../../testing/capture-fixture';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { PendingPage } from './pending-page';

describe('PendingPage', () => {
  let db: TerenDb;
  let store: EntryStore;
  let fixture: ComponentFixture<PendingPage>;
  const online = { online: () => true };
  // The page's contract is "put it back in the queue and ask the loop to run now" — not "the loop
  // runs". Stubbing the service keeps this spec about the screen, and keeps a component test from
  // making a real network attempt.
  const uploads = { wake: vi.fn() };

  /**
   * Render the screen, and — where the spec has put entries in the store — wait for them to
   * actually appear.
   *
   * The list is a Dexie `liveQuery` running on a real IndexedDB transaction, so a fixed number of
   * turns is a guess about the machine rather than an assertion about the code: right on an idle
   * one, wrong on a loaded one, and the spec then fails over an empty list for reasons that have
   * nothing to do with the screen.
   */
  async function render(expectRows = 0): Promise<HTMLElement> {
    fixture = TestBed.createComponent(PendingPage);
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    if (expectRows > 0) {
      await waitUntil(() => element.querySelectorAll('.list .row').length === expectRows, {
        onTick: () => fixture.detectChanges(),
        describe: `${expectRows} pending row(s) to appear`,
      });
    }
    return element;
  }

  beforeEach(() => {
    localStorage.clear();
    uploads.wake.mockClear();
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
        { provide: UploadService, useValue: uploads },
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
    const element = await render(1);

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
    const element = await render(1);

    const rows = Array.from(element.querySelectorAll('.summary__row')).map((row) => [
      row.querySelector('.summary__name')?.textContent?.trim(),
      row.querySelector('.summary__value')?.textContent?.trim(),
    ]);
    expect(rows).toEqual([
      ['Čeka mrežu', '1'],
      ['Šalje se', '0'],
      ['Pokušava ponovo', '0'],
      ['Ne prolazi', '0'],
      ['Ne može da se pošalje', '0'],
      ['Ukupno', '1'],
    ]);
  });

  describe('what a failing row says', () => {
    /** Put an entry into the state the sync loop would have left it in. */
    async function failWith(
      kind: string,
      state: 'failed' | 'blocked',
      attempts = 1,
    ): Promise<string> {
      const entryId = await queueOne(1);
      // `setOutboxState('in_flight')` is the only thing that increments the counter, so a row
      // that has failed eight times is built the way the loop would really have built it.
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await store.setOutboxState(entryId, 'in_flight');
      }
      await store.setOutboxState(entryId, state, {
        failureKind: kind,
        lastError: 'Project … was not found.',
        nextAttemptAt: state === 'failed' ? new Date(Date.now() + 60_000).toISOString() : null,
      });
      return entryId;
    }

    /**
     * Render and wait for the row itself, not for a fixed number of turns.
     *
     * A live query runs on a real IndexedDB transaction; a turn count that is right on an idle
     * machine is wrong on a loaded one, and the spec then fails for a reason that has nothing to
     * do with the code.
     */
    const renderRow = () => render(1);

    it('explains a retryable failure with the reason the server gave, not a canned sentence', async () => {
      // Until B3 this row printed "veza je pukla tokom slanja" under every failure alike — a
      // guess dressed as a diagnosis. The text now comes from the classified failure.
      await failWith('server', 'failed');
      const element = await renderRow();

      expect(element.textContent).toContain('Pokušava ponovo');
      expect(element.textContent).toContain('Server trenutno ne odgovara.');
      expect(element.textContent).not.toContain('veza je pukla');
    });

    it('names a terminal failure as terminal, and says the evidence is still here', async () => {
      // The two halves that have to appear together: this cannot be sent, and nothing was lost.
      // "Nije poslato" on its own reads as "gone".
      await failWith('rejected', 'blocked');
      const element = await renderRow();

      expect(element.textContent).toContain('Ne može da se pošalje');
      expect(element.textContent).toContain('Server nije prihvatio ovaj unos.');
      expect(element.textContent).toContain('Snimak i fotografije su bezbedni na ovom telefonu');
      expect(element.querySelector('.row__reason--err')).not.toBeNull();
    });

    it('offers no "try again" while the loop is still retrying by itself', async () => {
      await failWith('offline', 'failed');

      expect((await renderRow()).querySelector('.row__retry')).toBeNull();
    });

    it('stops calling it "trying again" once it has been failing for half an hour', async () => {
      // The queue has not given up — a server that is down comes back, and abandoning the entry
      // would break principle 3. What changes is the wording, because after this long "trying
      // again" reads as progress and a spinner that looks like progress is the lie to avoid.
      const entryId = await failWith('server', 'failed', 8);
      const element = await renderRow();

      const row = element.querySelector('.list .row')!;
      expect(row.textContent).toContain('Ne prolazi');
      expect(row.textContent).not.toContain('Pokušava ponovo');
      expect(element.textContent).toContain('Server trenutno ne odgovara.');
      // Never "gone": the row says in the same breath that everything is still here.
      expect(element.textContent).toContain('Snimak i fotografije su bezbedni na ovom telefonu');
      // And it is still in the queue, waiting for its next attempt like any other failed row.
      expect(await store.getOutboxItem(entryId)).toMatchObject({ state: 'failed' });
    });

    it('lets the foreman release a stalled row from its backoff', async () => {
      // He walked out of the basement. Waiting out a ten-minute interval he cannot see is not
      // something the product should make him do.
      const entryId = await failWith('offline', 'failed', 8);
      const element = await renderRow();

      element.querySelector<HTMLButtonElement>('.row__retry')!.click();
      await fixture.whenStable();
      await flushLiveQueries();

      expect(await store.getOutboxItem(entryId)).toMatchObject({
        state: 'queued',
        attempts: 0,
        nextAttemptAt: null,
      });
      expect(uploads.wake).toHaveBeenCalled();
    });

    it('offers "try again" on a terminal row, where retrying is the foreman\'s to do', async () => {
      // `crypto.subtle` is missing on a plain-http origin, so nothing can be hashed. The loop
      // cannot fix that; opening the app on an https address can, and only he can do that.
      await failWith('insecure_context', 'blocked');
      const element = await renderRow();

      expect(element.querySelector('.row__retry')).not.toBeNull();
      expect(element.textContent).toContain('sigurne (https) adrese');
    });

    it('puts a blocked entry back in the queue when the button is pressed', async () => {
      const entryId = await failWith('rejected', 'blocked');
      const element = await renderRow();

      element.querySelector<HTMLButtonElement>('.row__retry')!.click();
      await fixture.whenStable();
      await flushLiveQueries();

      expect(await store.getOutboxItem(entryId)).toMatchObject({
        state: 'queued',
        attempts: 0,
        failureKind: null,
      });
      // …and the loop is asked to run now, because he pressed a button and should see something
      // happen rather than wait out a backoff he cannot see.
      expect(uploads.wake).toHaveBeenCalled();
    });

    it('falls back to the generic line for a failure kind this build does not know', async () => {
      // A value written by a newer version. Showing a raw enum to a foreman is not an option.
      await failWith('teleportation_failure', 'failed');
      const element = await renderRow();

      expect(element.textContent).toContain('Slanje nije uspelo iz nepoznatog razloga.');
      expect(element.textContent).not.toContain('teleportation');
    });

    it('names the credential failure without blaming the entry, and keeps retrying', async () => {
      // A revoked device. Since F1 this is a `failed` row, not a `blocked` one — the queue keeps
      // trying, because an admin un-revoking is exactly the kind of thing that happens — so the
      // row must say what is wrong without implying the recording is at fault.
      await failWith('unauthenticated', 'failed');
      const element = await renderRow();

      expect(element.textContent).toContain('Ovom telefonu je ukinut pristup serveru');
      // Not the 403 sentence: this phone is not "without permission", its access was withdrawn.
      expect(element.textContent).not.toContain('nema dozvolu da šalje');
    });

    it('keeps the 403 sentence for a row that really is forbidden', async () => {
      await failWith('unauthorized', 'blocked');
      const element = await renderRow();

      expect(element.textContent).toContain('Ovaj telefon nema dozvolu da šalje na server.');
    });

    describe('try all again', () => {
      it('is not offered when nothing is stuck', async () => {
        await queueOne(1);
        const element = await render(1);

        expect(element.querySelector('.retryAll__button')).toBeNull();
      });

      it('releases every stuck row in one press, and wakes the loop once', async () => {
        // The chore this retires: three rows, three taps, on a screen a foreman opens with muddy
        // hands because something has already gone wrong.
        const blocked = await failWith('rejected', 'blocked');
        const stalled = await failWith('server', 'failed', 8);
        const revoked = await failWith('unauthenticated', 'failed', 8);
        const element = await render(3);

        element.querySelector<HTMLButtonElement>('.retryAll__button')!.click();
        await fixture.whenStable();
        await flushLiveQueries();

        for (const entryId of [blocked, stalled, revoked]) {
          expect(await store.getOutboxItem(entryId)).toMatchObject({
            state: 'queued',
            attempts: 0,
            failureKind: null,
          });
        }
        // Once, after everything is released — a pass started against a half-released queue would
        // leave the rest until the next tick.
        expect(uploads.wake).toHaveBeenCalledTimes(1);
      });

      it('leaves rows the loop is still working on exactly where they are', async () => {
        // "Try all again" acts on precisely the rows that carry their own retry button. A row that
        // is merely backing off is not stuck, and resetting its attempt count would throw away the
        // queue's honest record of how long it has been trying.
        const stillTrying = await failWith('offline', 'failed', 1);
        await failWith('rejected', 'blocked');
        const element = await render(2);

        element.querySelector<HTMLButtonElement>('.retryAll__button')!.click();
        await fixture.whenStable();
        await flushLiveQueries();

        expect(await store.getOutboxItem(stillTrying)).toMatchObject({
          state: 'failed',
          attempts: 1,
        });
      });
    });

    it('counts blocked entries separately in the expanded summary', async () => {
      await failWith('rejected', 'blocked');
      const element = await renderRow();

      const rows = Array.from(element.querySelectorAll('.summary__row')).map((row) => [
        row.querySelector('.summary__name')?.textContent?.trim(),
        row.querySelector('.summary__value')?.textContent?.trim(),
      ]);
      expect(rows).toContainEqual(['Ne može da se pošalje', '1']);
      expect(rows).toContainEqual(['Čeka mrežu', '0']);
      expect(element.querySelector('.summary__value--err')).not.toBeNull();
    });
  });

  it('switches the whole screen to English from the language switcher', async () => {
    await queueOne(1);
    const element = await render(1);

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
