import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';

import en from '../../../../public/i18n/en.json';
import sr from '../../../../public/i18n/sr.json';
import { EntryResponse } from '../../core/api/api-types';
import { AppStatus } from '../../core/app-status.service';
import { TerenApiClient } from '../../core/api/teren-api.client';
import { EntryStore } from '../../core/db/entry-store';
import { TEREN_DB, TerenDb } from '../../core/db/teren-db';
import { TEST_PROJECT, captureEntry } from '../../testing/capture-fixture';
import { flushLiveQueries, waitUntil } from '../../testing/flush';
import { ConfirmPage } from './confirm-page';

/**
 * The mandatory gate (PROJECT.md principle 5), specced against a server that behaves like the
 * real one.
 *
 * Three of the assertions below are the ones worth having, and each corresponds to something that
 * would be invisible until it cost a real report:
 *
 * - the **triple** actually reaching the server — the human's answer, complete, as `corrected`;
 * - the **typed fallback** working on an entry with no structure at all, which is today's
 *   everyday case and every future extraction failure;
 * - a failed confirmation **never** being described as lost work.
 */
class FakeApi {
  configured = true;

  status = 'awaiting_confirmation';
  reportedAt: string | null = null;
  structure: unknown = null;
  corrected: unknown = null;
  transcript: string | null =
    'Danas smo završili razvod, ugradili pipr cevi dvaes 5, bila dvojica.';

  sent: Record<string, unknown> | null = null;
  failConfirm: unknown = null;

  async getEntry(entryId: string): Promise<EntryResponse> {
    return this.entry(entryId);
  }

  async confirmEntry(entryId: string, corrected: Record<string, unknown>): Promise<EntryResponse> {
    if (this.failConfirm) {
      throw this.failConfirm;
    }
    this.sent = corrected;
    this.corrected = corrected;
    this.status = 'confirmed';
    return this.entry(entryId);
  }

  private entry(id: string): EntryResponse {
    return {
      id,
      project_id: TEST_PROJECT.id,
      entry_date: '2026-08-29',
      status: this.status,
      created_at: '2026-08-29T10:00:00.000Z',
      received_at: '2026-08-29T10:05:00.000Z',
      confirmed_at: null,
      reported_at: this.reportedAt,
      failure_reason: null,
      raw_transcript: this.transcript,
      structure: this.structure,
      corrected: this.corrected,
      media: [],
    };
  }
}

function httpError(status: number, detail?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    statusText: 'error',
    url: 'http://localhost:5080/api/entries/x/confirm',
    error: detail ? { title: 'Problem', detail } : null,
  });
}

describe('ConfirmPage', () => {
  let db: TerenDb;
  let store: EntryStore;
  let api: FakeApi;
  let fixture: ComponentFixture<ConfirmPage>;
  let element: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    api = new FakeApi();
    TestBed.configureTestingModule({
      imports: [
        ConfirmPage,
        // The shipped dictionaries: a spec with its own copies would pass while the Serbian a
        // foreman actually reads was missing a key.
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
        { provide: TerenApiClient, useValue: api as unknown as TerenApiClient },
      ],
    });
    store = TestBed.inject(EntryStore);
  });

  afterEach(async () => {
    // Destroy first, then let the flushed draft write land: closing the database out from under
    // an in-flight Dexie put turns a passing spec into an unhandled rejection somewhere else.
    fixture?.destroy();
    await flushLiveQueries();
    db.close();
    await db.delete();
  });

  async function givenEntry(): Promise<string> {
    const entry = await captureEntry(store);
    await store.markConfirmedByServer(entry.id, { serverStatus: 'awaiting_confirmation' });
    return entry.id;
  }

  async function render(entryId: string): Promise<HTMLElement> {
    fixture = TestBed.createComponent(ConfirmPage);
    fixture.componentRef.setInput('entryId', entryId);
    fixture.detectChanges();
    await fixture.whenStable();
    await flushLiveQueries();
    fixture.detectChanges();
    element = fixture.nativeElement as HTMLElement;
    return element;
  }

  function inputs(): HTMLInputElement[] {
    return [...element.querySelectorAll<HTMLInputElement>('input.field__input')];
  }

  /**
   * The inputs under a given field label, in document order.
   *
   * By label rather than by position, because "the first empty input on the page" is a trap on
   * this screen: the headcount box is empty on every fresh entry and sits above the material rows,
   * so a spec that reached for it would type a material name into the crew size and still pass.
   */
  function fieldsByLabel(label: string): HTMLInputElement[] {
    return [...element.querySelectorAll<HTMLLabelElement>('label.field')]
      .filter((node) => node.querySelector('.field__label')?.textContent?.trim() === label)
      .map((node) => node.querySelector('input'))
      .filter((node): node is HTMLInputElement => node !== null);
  }

  function textarea(): HTMLTextAreaElement {
    return element.querySelector<HTMLTextAreaElement>('textarea')!;
  }

  function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function button(label: string): HTMLButtonElement {
    const match = [...element.querySelectorAll('button')].find((node) =>
      node.textContent?.includes(label),
    );
    if (!match) {
      throw new Error(`No button reading "${label}". Buttons on screen: ${buttonLabels()}`);
    }
    return match as HTMLButtonElement;
  }

  function buttonLabels(): string {
    return [...element.querySelectorAll('button')]
      .map((node) => node.textContent?.trim().slice(0, 40))
      .join(' | ');
  }

  /**
   * Click, then wait for the work the click started to finish.
   *
   * `whenStable` is not enough: confirming runs a plain promise chain through the API and Dexie,
   * which nothing tracks, so a spec that only awaited Angular would assert on a screen still
   * reading "Šalje se…".
   */
  async function click(label: string): Promise<void> {
    button(label).click();
    fixture.detectChanges();
    await waitUntil(() => !element.textContent!.includes('Šalje se…'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the click to settle',
    });
  }

  // ------------------------------------------------------------------------ what it shows

  it('renders Serbian by default — no English leaks onto a site phone', async () => {
    const html = await render(await givenEntry());

    expect(html.textContent).toContain('Provera unosa');
    expect(html.textContent).toContain('Potvrdi unos');
  });

  it('shows the transcript as spoken, never translated or tidied', async () => {
    const html = await render(await givenEntry());

    // Content is never localised (PROJECT.md principle 2) — only the chrome around it.
    expect(html.textContent).toContain('ugradili pipr cevi dvaes 5');
  });

  it('fills the form from what the model extracted', async () => {
    api.structure = {
      schema_version: 1,
      work_done: [{ description: 'Razvod od kotla', location: '2. sprat', quantity: null }],
      materials: [{ name: 'pipr cevi dvaes 5', quantity: { value: 40, unit: 'm' } }],
      headcount: { total: 2, roles: [] },
      blockers: [],
      hidden_work: [],
      notes: null,
    };

    const html = await render(await givenEntry());

    const values = inputs().map((field) => field.value);
    expect(values).toContain('Razvod od kotla');
    expect(values).toContain('pipr cevi dvaes 5');
    expect(values).toContain('2');
  });

  // ------------------------------------------------- the triple actually reaching the server

  it('sends the corrected day, in full, as the human left it', async () => {
    api.structure = {
      schema_version: 1,
      work_done: [],
      materials: [{ name: 'pipr cevi dvaes 5', quantity: { value: 40, unit: 'm' } }],
      headcount: null,
      blockers: [],
      hidden_work: [],
      notes: null,
    };
    await render(await givenEntry());

    // The routine correction: transcription mangles material codes on every provider path.
    const mangled = inputs().find((field) => field.value === 'pipr cevi dvaes 5')!;
    type(mangled, 'PPR cev 25');

    await click('Potvrdi unos');

    expect(api.sent).toEqual({
      schema_version: 1,
      work_done: [],
      headcount: null,
      materials: [{ name: 'PPR cev 25', quantity: { value: 40, unit: 'm' }, delivered: null }],
      blockers: [],
      hidden_work: [],
      notes: null,
    });
  });

  it('says the entry is confirmed once the server has it', async () => {
    await render(await givenEntry());
    type(textarea(), 'Postavljeni radijatori.');

    await click('Potvrdi unos');

    expect(element.textContent).toContain('Unos je potvrđen');
  });

  // ---------------------------------------------------------------- the typed fallback

  it('lets a foreman type a whole day on an entry with no structure at all', async () => {
    // Today's everyday case — extraction has no key configured — and every future extraction
    // failure. A screen that only worked on the happy path would make the pipeline's bad day the
    // foreman's lost day.
    api.status = 'needs_review';
    api.structure = null;
    await render(await givenEntry());

    await click('Dodaj materijal');
    type(fieldsByLabel('Materijal')[0], 'PPR cev 25');
    type(textarea(), 'Zatvoreni šlicevi u kupatilu.');

    await click('Potvrdi unos');

    expect(api.sent).toMatchObject({
      schema_version: 1,
      materials: [{ name: 'PPR cev 25' }],
      notes: 'Zatvoreni šlicevi u kupatilu.',
    });
  });

  it('refuses to confirm an entry with nothing in it, and says why', async () => {
    api.status = 'needs_review';
    await render(await givenEntry());

    expect(button('Potvrdi unos').disabled).toBe(true);
    expect(element.textContent).toContain('Upišite bar jednu stavku');
  });

  it('copies the transcript into the notes only when a person asks it to', async () => {
    // Never automatic: `corrected` is the human's answer and the eval set's third column.
    // Pre-filling it would make every untouched entry look like somebody had agreed.
    api.status = 'needs_review';
    await render(await givenEntry());
    expect(textarea().value).toBe('');

    await click('Prebaci u napomenu');

    expect(textarea().value).toContain('pipr cevi dvaes 5');
  });

  // ------------------------------------------- his own words as the record (founder ruling 3)

  /**
   * The screen used to lie here, and the lie is the reason this section exists.
   *
   * A real entry: transcription succeeded — *"Snimam test pokušaj za stanbenu zgradu vojvode
   * stepe."* — and extraction failed because the Anthropic account was out of credit. Both land
   * in `needs_review`, the screen read that one status as one situation, and printed **"Iz snimka
   * nije moglo da se pročita ništa"** directly beneath the recording, read out in full.
   *
   * So the two situations are told apart by what is actually there, and the case where his words
   * came through gets the one-tap path out: approve them as the day's record, no typing.
   */
  const SPOKEN = 'Snimam test pokušaj za stanbenu zgradu vojvode stepe.';

  async function givenTranscriptButNoStructure(): Promise<HTMLElement> {
    api.status = 'needs_review';
    api.structure = null;
    api.transcript = SPOKEN;
    return render(await givenEntry());
  }

  it('never says the recording was unreadable while the words are on the screen', async () => {
    const html = await givenTranscriptButNoStructure();

    expect(html.textContent).toContain(SPOKEN);
    expect(html.textContent).not.toContain('Iz snimka nije moglo da se pročita ništa');
    // What actually failed, said plainly.
    expect(html.textContent).toContain('Sistem nije uspeo da razvrsta ovaj dan po stavkama');

    // And once he starts writing the day out himself the offer retires, which puts the *banner*
    // on screen in place of the card. That is the second surface the old copy lied on, so it is
    // checked too rather than assumed to follow.
    await click('Dodaj materijal');
    type(fieldsByLabel('Materijal')[0], 'PPR cev 25');

    expect(element.querySelector('.verbatim')).toBeNull();
    expect(element.textContent).not.toContain('Iz snimka nije moglo da se pročita ništa');
    expect(element.textContent).toContain('Sistem nije uspeo da razvrsta ovaj dan po stavkama');
  });

  it('still says the recording could not be read when there really is no transcript', async () => {
    api.status = 'needs_review';
    api.structure = null;
    api.transcript = null;
    const html = await render(await givenEntry());

    expect(html.textContent).toContain('Iz snimka nije moglo da se pročita ništa');
    // And there is nothing to approve, so the one-tap way out is not offered — typing is the
    // only way forward and the screen must not pretend otherwise.
    expect(buttonLabels()).not.toContain('Pošalji moje reči');
  });

  it('finishes the day in one tap, sending his words as the record', async () => {
    // The product's floor: with the transcript right and every AI downstream of it broken, a
    // foreman still finishes. No typing, one action.
    await givenTranscriptButNoStructure();

    await click('Pošalji moje reči');

    expect(api.sent).toEqual({
      schema_version: 1,
      work_done: [],
      headcount: null,
      materials: [],
      blockers: [],
      hidden_work: [],
      notes: SPOKEN,
      described_verbatim: true,
    });
  });

  it('does not dress a verbatim day up as the good path once it is sent', async () => {
    // If confirming prose feels identical to confirming structure, nothing ever creates pressure
    // to notice extraction is broken — and here it was broken for a billing reason that would
    // otherwise have gone unnoticed for weeks.
    await givenTranscriptButNoStructure();

    await click('Pošalji moje reči');

    expect(element.textContent).toContain('Vaše reči su potvrđene');
    expect(element.textContent).not.toContain('Unos je potvrđen');
  });

  it('does not offer to send prose when the model actually extracted a day', async () => {
    // With a day extracted, approving prose instead of checking it would throw the better record
    // away. Note the status is still `needs_review` — the offer follows the facts, not the label.
    api.status = 'needs_review';
    api.transcript = SPOKEN;
    api.structure = {
      schema_version: 1,
      work_done: [{ description: 'Razvod od kotla' }],
      materials: [],
      headcount: null,
      blockers: [],
      hidden_work: [],
      notes: null,
    };
    const html = await render(await givenEntry());

    expect(buttonLabels()).not.toContain('Pošalji moje reči');
    expect(html.textContent).not.toContain('Sistem nije uspeo da razvrsta');
  });

  it('withdraws the verbatim offer the moment he writes a line himself', async () => {
    // Anything typed into the structured sections means it is no longer a verbatim record, so
    // there must be no path from an edited draft to a `described_verbatim` payload. Hiding the
    // action is how that is enforced rather than merely intended.
    await givenTranscriptButNoStructure();
    expect(buttonLabels()).toContain('Pošalji moje reči');

    await click('Dodaj materijal');
    type(fieldsByLabel('Materijal')[0], 'PPR cev 25');

    expect(buttonLabels()).not.toContain('Pošalji moje reči');

    await click('Potvrdi unos');

    expect(api.sent).toMatchObject({ materials: [{ name: 'PPR cev 25' }] });
    expect(api.sent).not.toHaveProperty('described_verbatim');
  });

  it('keeps approval and typing apart even when the words are identical', async () => {
    // ARCHITECTURE §9.3. Copying the transcript into the notes and confirming produces the same
    // `notes` string as approving it — and a completely different signal. Only the flag separates
    // a person's independent answer from a person declining to answer because the system failed
    // to ask, and without it the eval set reads every transcript-shaped note as agreement.
    await givenTranscriptButNoStructure();

    await click('Prebaci u napomenu');
    await click('Potvrdi unos');

    expect(api.sent).toMatchObject({ notes: SPOKEN });
    expect(api.sent).not.toHaveProperty('described_verbatim');
  });

  it('reports a failed verbatim approval beside the button that was pressed', async () => {
    // The form's own gate is at the foot of a long day; an error announced down there over an
    // action taken at the top of the screen is an error nobody reads.
    await givenTranscriptButNoStructure();
    api.failConfirm = httpError(500);

    await click('Pošalji moje reči');

    const card = element.querySelector('.verbatim')!;
    expect(card.textContent).toContain('Server trenutno ne odgovara');
    expect(card.textContent).toContain('Ništa nije izgubljeno');
    // Retryable, and the button says so — a 5xx is never a dead end (B3 taxonomy).
    expect(button('Pokušaj ponovo').disabled).toBe(false);
    expect(element.textContent).not.toContain('Vaše reči su potvrđene');
  });

  it('does not tell him to write a line while one tap above would finish the day', async () => {
    // The disabled gate at the foot of the screen must not contradict the offer at the top of it.
    const html = await givenTranscriptButNoStructure();

    expect(button('Potvrdi unos').disabled).toBe(true);
    expect(html.textContent).toContain('ili gore pošaljite svoje reči');
  });

  it('does not present already-approved words as something he typed', async () => {
    // Re-opening an entry confirmed this way. Seeding the notes box from that `corrected` would
    // show his approved words as typed text — and confirming from that draft would send them back
    // without the flag, silently demoting a verbatim record to a typed one.
    api.status = 'confirmed';
    api.structure = null;
    api.transcript = SPOKEN;
    api.corrected = {
      schema_version: 1,
      work_done: [],
      headcount: null,
      materials: [],
      blockers: [],
      hidden_work: [],
      notes: SPOKEN,
      described_verbatim: true,
    };
    await render(await givenEntry());

    expect(textarea().value).toBe('');
    expect(buttonLabels()).toContain('Pošalji moje reči');
  });

  // ------------------------------------------------------------------- honest failures

  it('never calls a failed confirmation lost work', async () => {
    // The C3 review found this class of lie twice. A confirmation that did not reach the server
    // costs nothing typed — the draft is on the phone — and the screen has to say so.
    await render(await givenEntry());
    type(textarea(), 'Postavljeni radijatori.');
    api.failConfirm = httpError(0);

    await click('Potvrdi unos');

    expect(element.textContent).toContain('Server nije bio dostupan');
    expect(element.textContent).toContain('Ništa nije izgubljeno');
    expect(element.textContent).not.toContain('Unos je potvrđen');
    expect(textarea().value).toBe('Postavljeni radijatori.');
  });

  it('treats a 500 as something to try again, not as a dead end', async () => {
    await render(await givenEntry());
    type(textarea(), 'gotovo');
    api.failConfirm = httpError(500);

    await click('Potvrdi unos');

    expect(element.textContent).toContain('Server trenutno ne odgovara');
    // The button now says what pressing it would do. Still enabled: a 5xx is something to try
    // again, never a dead end (B3 taxonomy, binding for B5).
    expect(button('Pokušaj ponovo').disabled).toBe(false);
  });

  it('keeps what was typed on the phone across a reload', async () => {
    const id = await givenEntry();
    await render(id);
    type(textarea(), 'Pola dana otkucano');

    // Leaving the screen flushes the pending write rather than dropping it.
    fixture.destroy();
    await waitUntil(async () => (await store.getConfirmDraft(id)) !== undefined, {
      describe: 'the draft to reach the local store',
    });

    const html = await render(id);

    expect(html.querySelector('textarea')!.value).toBe('Pola dana otkucano');
  });

  // -------------------------------------------------------------------- states, honestly

  it('offers no form at all on an entry the server has already reported', async () => {
    // Immutable (PROJECT.md principle 2). Offering an edit and refusing it on send would be the
    // screen promising something the product does not do.
    api.status = 'reported';
    api.reportedAt = '2026-08-29T18:00:00.000Z';
    const html = await render(await givenEntry());

    expect(html.textContent).toContain('Ovaj unos je već poslat');
    expect(html.querySelector('textarea')).toBeNull();
    expect(buttonLabels()).not.toContain('Potvrdi unos');
  });

  it('still edits an entry that is confirmed but not yet reported', async () => {
    // The destination of the archive's way back. The server accepts a second confirmation until
    // the report goes out, and this screen has to honour that — a read-only screen here would
    // make the archive's offer a lie.
    api.status = 'confirmed';
    api.corrected = { schema_version: 1, notes: 'Postavljeni radijatri.' };
    const html = await render(await givenEntry());

    expect(html.textContent).toContain('Potvrđeno');
    expect(html.textContent).toContain('Unos možete ispravljati sve dok izveštaj ne ode');
    // Seeded from what he approved last time, and editable.
    expect(textarea().value).toBe('Postavljeni radijatri.');
    expect(button('Potvrdi unos').disabled).toBe(false);

    type(textarea(), 'Postavljeni radijatori.');
    await click('Potvrdi unos');

    expect(api.sent).toMatchObject({ notes: 'Postavljeni radijatori.' });
    expect(html.textContent).toContain('Unos je potvrđen');
  });

  it('does not claim a correction landed when the report went out while he was typing', async () => {
    // The race B6 closed: the server refuses a *changed* re-confirmation while a report pass is
    // sending, because sealing v2 after sending v1 would make the archive contradict the report.
    // The 409 is judged by re-reading the entry and looking at `reported_at` — never at the
    // server's English prose, which is free to change.
    api.status = 'confirmed';
    const id = await givenEntry();
    const html = await render(id);
    type(textarea(), 'Ipak je bilo troje ljudi.');

    api.failConfirm = httpError(409, 'Entry has already been reported.');
    api.status = 'reported';
    api.reportedAt = '2026-08-29T18:00:00.000Z';

    await click('Potvrdi unos');

    // The re-read settles it: the entry is sealed, so the screen stops offering an edit at all
    // rather than leaving a form on screen that the server will refuse for ever.
    expect(html.textContent).toContain('Ovaj unos je već poslat');
    expect(html.textContent).not.toContain('Unos je potvrđen');
    // Terminal: no amount of retrying moves a sealed entry, so the screen must not offer it.
    expect(buttonLabels()).not.toContain('Pokušaj ponovo');
    expect(buttonLabels()).not.toContain('Potvrdi unos');
    // And the correction he typed is still on the phone — a refused confirmation costs nothing.
    await waitUntil(async () => (await store.getConfirmDraft(id)) !== undefined, {
      describe: 'the correction to still be on the phone',
    });
  });

  it('says the pipeline is still working rather than showing an empty form', async () => {
    api.status = 'processing';
    const html = await render(await givenEntry());

    expect(html.textContent).toContain('Obrada je u toku');
    expect(html.querySelector('textarea')).toBeNull();
  });

  it('tells apart "not on the server" from "the server could not be asked"', async () => {
    api.configured = false;
    const html = await render(await givenEntry());

    expect(html.textContent).toContain('Još nije stiglo na server');
    expect(html.textContent).not.toContain('Unos nije pronađen');
  });

  it('switches every label to English without touching the transcript', async () => {
    await render(await givenEntry());

    TestBed.inject(TranslocoService).setActiveLang('en');
    fixture.detectChanges();

    expect(element.textContent).toContain('Check the entry');
    // Content is not chrome: the words spoken on site stay exactly as they were spoken.
    expect(element.textContent).toContain('ugradili pipr cevi dvaes 5');
  });

  // ------------------------------------------------------------- when the local store gives out

  /**
   * The screen's central promise is "ništa nije izgubljeno", and the hint under the button says
   * so on every render. The draft write used to be `.catch(() => undefined)` — so if Dexie
   * refused the write, the typing was gone and the screen went on promising it was safe. Quota
   * exhaustion is the realistic cause and C1 media pruning does not exist yet, so this is a path
   * a real phone can take.
   */
  async function givenTheStoreRefusesToSaveDrafts(): Promise<void> {
    vi.spyOn(store, 'saveConfirmDraft').mockRejectedValue(
      new DOMException('quota', 'QuotaExceededError'),
    );
  }

  it('stops promising the draft is safe once the local store has refused to save it', async () => {
    await render(await givenEntry());
    await givenTheStoreRefusesToSaveDrafts();

    type(textarea(), 'Ugradili PPR cev 25, dvojica na fasadi.');

    await waitUntil(() => element.textContent!.includes('Telefon nije uspeo da sačuva'), {
      onTick: () => fixture.detectChanges(),
      describe: 'the screen to admit the draft was not saved',
    });
    // And the promise it can no longer keep is gone, not merely accompanied by a warning.
    expect(element.textContent).not.toContain('Sve što upišete čuva se na telefonu');
  });

  it('raises the app-wide store failure, so Home and capture hear about it too', async () => {
    // The same pairing `capture-recording-page.ts` makes when `beginCapture` cannot write: a
    // failed Dexie write is a failed Dexie write, and recording into a store that has just proven
    // it cannot hold anything is the one thing the app must not go on doing.
    const status = TestBed.inject(AppStatus);
    await render(await givenEntry());
    await givenTheStoreRefusesToSaveDrafts();
    expect(status.storageAvailable()).toBe(true);

    type(textarea(), 'Ugradili PPR cev 25, dvojica na fasadi.');

    await waitUntil(() => !status.storageAvailable(), {
      onTick: () => fixture.detectChanges(),
      describe: 'the app-wide storage failure to be reported',
    });
  });

  it('sends a foreman to Home when he is done', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate');
    await render(await givenEntry());
    type(textarea(), 'gotovo');

    await click('Potvrdi unos');
    await click('Gotovo');

    expect(navigate).toHaveBeenCalledWith(['/']);
  });
});
