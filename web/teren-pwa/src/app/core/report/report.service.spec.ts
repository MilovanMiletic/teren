import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { API_CONFIG } from '../api/api-config';
import { FileSaver } from './file-saver';
import { REPORT_FAILURES, ReportService } from './report.service';

/**
 * The app's half of "the PDF is downloadable from the app" (PROJECT.md §11, ruling 5).
 *
 * Almost every test below is about a *failure*, and that is the point. Three of this project's
 * last reviews each found a defect that existed precisely because a failure path was untested,
 * and C3's was this screen: a 404 rendering identically to an unreachable server. The single
 * thing this service exists to guarantee is that "the report is not ready yet", "the server has
 * no such entry" and "the server could not be asked" never collapse into one another.
 */
describe('ReportService', () => {
  const entryId = '11111111-2222-3333-4444-555555555555';
  const reportUrl = `http://localhost:5080/api/entries/${entryId}/report`;
  const entryUrl = `http://localhost:5080/api/entries/${entryId}`;

  let http: HttpTestingController;
  let reports: ReportService;
  let saver: { save: ReturnType<typeof vi.fn> };

  function configure(deviceToken = 'test-token'): void {
    saver = { save: vi.fn() };
    // Two describes configure different tokens, and a test that left the bed instantiated would
    // otherwise hand the next one the previous token — silently, and with a live HTTP backend.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_CONFIG, useValue: { baseUrl: 'http://localhost:5080', deviceToken } },
        { provide: FileSaver, useValue: saver as unknown as FileSaver },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    reports = TestBed.inject(ReportService);
  }

  /**
   * Let the promise chain inside the service run.
   *
   * The re-read of a 409 is issued several microtasks after the first response is flushed — the
   * catch, the classify, the await. Expecting it in the same synchronous turn finds nothing.
   */
  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function pdf(bytes = 4): Blob {
    return new Blob([new Uint8Array(bytes).fill(0x25)], { type: 'application/pdf' });
  }

  describe('with a device token', () => {
    beforeEach(() => configure());
    afterEach(() => http.verify());

    it('fetches the PDF from the token-protected route and saves it under the server name', async () => {
      const pending = reports.download(entryId, 'teren-2026-08-29');

      const request = http.expectOne(reportUrl);
      expect(request.request.method).toBe('GET');
      // The whole reason this is a fetch and not an `<a href>`: a link cannot carry the header.
      expect(request.request.headers.get('Authorization')).toBe('Bearer test-token');
      expect(request.request.responseType).toBe('blob');

      request.flush(pdf(), {
        headers: {
          'Content-Disposition':
            "attachment; filename*=UTF-8''Teren%20-%20izve%C5%A1taj%20-%2029.08.2026.pdf",
        },
      });

      const result = await pending;
      expect(result.ok).toBe(true);
      expect(result.failure).toBe(null);
      expect(saver.save).toHaveBeenCalledTimes(1);
      expect(saver.save.mock.calls[0][1]).toBe('Teren - izveštaj - 29.08.2026.pdf');
    });

    it('names the file itself when the browser will not expose Content-Disposition', async () => {
      // The ordinary cross-origin case — the header is not CORS-safelisted. A download that
      // succeeds must not fail over a missing name.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(pdf());

      const result = await pending;
      expect(result.ok).toBe(true);
      expect(result.filename).toBe('teren-2026-08-29.pdf');
    });

    it('hands the browser a blob that says it is a PDF', async () => {
      // iOS decides what to do with a file largely from its MIME type; an octet-stream is one it
      // will not open as a document.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http
        .expectOne(reportUrl)
        .flush(new Blob([new Uint8Array(4)], { type: 'application/octet-stream' }));

      await pending;
      expect((saver.save.mock.calls[0][0] as Blob).type).toBe('application/pdf');
    });

    it('reports progress, so a multi-megabyte report is not a button that does nothing', async () => {
      const seen: (number | null)[] = [];
      const pending = reports.download(entryId, 'teren-2026-08-29', (f) => seen.push(f));

      const request = http.expectOne(reportUrl);
      request.event({ type: HttpEventType.DownloadProgress, loaded: 500_000, total: 2_000_000 });
      request.event({ type: HttpEventType.DownloadProgress, loaded: 2_000_000, total: 2_000_000 });
      // No `Content-Length`: the fraction is unknown, and saying so beats inventing one.
      request.event({ type: HttpEventType.DownloadProgress, loaded: 2_000_000 });
      request.flush(pdf());

      await pending;
      expect(seen).toEqual([0.25, 1, null]);
    });

    it('will not save a 200 with no bytes in it', async () => {
      // A zero-byte PDF opens in nothing. Saving it is a silent failure wearing a success's
      // clothes.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(new Blob([]));

      const result = await pending;
      expect(result).toMatchObject({ ok: false, failure: 'empty', retryable: true });
      expect(saver.save).not.toHaveBeenCalled();
    });

    it('calls a 404 missing — and nothing else missing', async () => {
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(null, { status: 404, statusText: 'Not Found' });

      const result = await pending;
      expect(result).toMatchObject({ ok: false, failure: 'missing', retryable: false });
      expect(saver.save).not.toHaveBeenCalled();
    });

    it('reads a 409 on a reported entry as "not ready yet", not as an error', async () => {
      // The report exists as a promise but not yet as bytes: it is being produced or sent. The
      // verdict comes from re-reading the entry, never from the server's English prose.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(null, { status: 409, statusText: 'Conflict' });
      await tick();

      const reread = http.expectOne(entryUrl);
      expect(reread.request.method).toBe('GET');
      reread.flush({ id: entryId, status: 'reported', reported_at: '2026-08-29T18:00:00.000Z' });

      const result = await pending;
      expect(result).toMatchObject({ ok: false, failure: 'notReady', retryable: true });
    });

    it('reads a 409 report_unavailable as a fault, never as "try again later"', async () => {
      // The one 409 the entry itself cannot answer: it carries a reported_at exactly like a
      // healthy report, so re-reading it would produce "the report is being sent, come back
      // shortly" over a document that is never coming back.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http
        .expectOne(reportUrl)
        .flush(
          new Blob([JSON.stringify({ title: 'Conflict', code: 'report_unavailable' })]),
          { status: 409, statusText: 'Conflict' },
        );
      await tick();

      const result = await pending;
      expect(result).toMatchObject({ ok: false, failure: 'unavailable', retryable: false });
      // Decided on the code alone — the entry is never re-read, and http.verify() in afterEach
      // is what proves no second call was made.
    });

    it('branches on the typed code, not on the English detail beside it', async () => {
      // A client whose correctness depends on the wording breaks the day somebody improves it.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(
        new Blob([
          JSON.stringify({
            title: 'Conflict',
            detail: 'The stored report does not match what was sent.',
            code: 'report_not_ready',
          }),
        ]),
        { status: 409, statusText: 'Conflict' },
      );
      await tick();
      http.expectOne(entryUrl).flush({ id: entryId, status: 'confirmed', reported_at: null, confirmed_at: null });

      // The detail string talks about a stored report; the code says not ready. The code wins.
      expect(await pending).toMatchObject({ failure: 'notReported' });
    });

    it('waits, rather than saying nothing is coming, once the day has been confirmed', async () => {
      // report_not_ready covers both "he never confirmed" and "confirmed, report in flight".
      // confirmed_at is the hinge, and it is a column rather than prose.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(null, { status: 409, statusText: 'Conflict' });
      await tick();
      http.expectOne(entryUrl).flush({
        id: entryId,
        status: 'confirmed',
        confirmed_at: '2026-08-29T17:00:00.000Z',
        reported_at: null,
      });

      expect(await pending).toMatchObject({ failure: 'notReady', retryable: true });
    });

    it('reads a 409 on an unreported entry as "no report has gone out"', async () => {
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(null, { status: 409, statusText: 'Conflict' });
      await tick();
      http.expectOne(entryUrl).flush({ id: entryId, status: 'awaiting_confirmation', confirmed_at: null, reported_at: null });

      const result = await pending;
      // Nothing to wait for and nothing to retry: a person has to confirm the day first.
      expect(result).toMatchObject({ ok: false, failure: 'notReported', retryable: false });
    });

    it('does not guess downwards when the re-read of a 409 fails', async () => {
      // "No report has been sent for this day" over an entry whose report is mid-flight would
      // send a foreman to re-do work he has finished. The softer sentence is the only safe one.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(null, { status: 409, statusText: 'Conflict' });
      await tick();
      http.expectOne(entryUrl).error(new ProgressEvent('error'));

      const result = await pending;
      expect(result).toMatchObject({ ok: false, failure: 'notReady', retryable: true });
    });

    it('keeps every 5xx retryable, 500 included', async () => {
      // Binding since B3. There is no "the server is broken, give up" class.
      for (const status of [500, 502, 503]) {
        const pending = reports.download(entryId, 'teren-2026-08-29');
        http.expectOne(reportUrl).flush(null, { status, statusText: 'Server Error' });
        expect(await pending).toMatchObject({ ok: false, failure: 'server', retryable: true });
      }
    });

    it('says the server could not be asked, rather than that the report is gone', async () => {
      // Angular reports every network-layer failure as status 0. It is not the server's answer,
      // and a screen that treats it as one is the C3 defect all over again.
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).error(new ProgressEvent('error'));

      const result = await pending;
      expect(result).toMatchObject({ ok: false, failure: 'offline', retryable: true });
    });

    it('treats a rejected device token as terminal', async () => {
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(null, { status: 401, statusText: 'Unauthorized' });

      expect(await pending).toMatchObject({ ok: false, failure: 'unauthorized', retryable: false });
    });

    it('keeps a malformed request apart from a missing entry', async () => {
      const pending = reports.download(entryId, 'teren-2026-08-29');
      http.expectOne(reportUrl).flush(null, { status: 400, statusText: 'Bad Request' });

      expect(await pending).toMatchObject({ ok: false, failure: 'rejected', retryable: false });
    });

    it('escapes the entry id rather than pasting it into the path', async () => {
      const pending = reports.download('a/b', 'teren');
      http.expectOne('http://localhost:5080/api/entries/a%2Fb/report').flush(pdf());
      await pending;
    });
  });

  describe('without a device token', () => {
    beforeEach(() => configure(''));
    afterEach(() => http.verify());

    it('does not even ask, because no retry invents credentials', async () => {
      const result = await reports.download(entryId, 'teren-2026-08-29');
      expect(result).toMatchObject({ ok: false, failure: 'notConfigured', retryable: false });
      // `http.verify()` in afterEach is the other half: not one request was made.
    });
  });
});

describe('REPORT_FAILURES', () => {
  it('enumerates the union, so the i18n guard can walk it', () => {
    // The component builds `archive.report.error.${failure}`, which no scan of string literals
    // can see. This list is what lets a spec prove both dictionaries can name every one.
    expect(REPORT_FAILURES).toContain('notReady');
    expect(REPORT_FAILURES).toContain('notReported');
    expect(REPORT_FAILURES).toContain('missing');
    expect(REPORT_FAILURES).toContain('unavailable');
    expect(REPORT_FAILURES.length).toBe(11);
  });
});
