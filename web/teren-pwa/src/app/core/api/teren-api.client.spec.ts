import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { API_CONFIG } from './api-config';
import { TerenApiClient } from './teren-api.client';

/**
 * The confirmation request, on the wire.
 *
 * One route is specced at this level rather than through a hand-written fake, and it is this one,
 * because the shape of the request *is* the invariant: `raw_transcript`, `structure` and
 * `corrected` are three separate columns and the confirm route accepts only the third
 * (ARCHITECTURE §9.3). A client that sent a `structure` field alongside — or sent the payload
 * unwrapped — would be a client trying to overwrite the model's answer with the human's, which
 * destroys the eval set while looking entirely correct from the screen.
 */
describe('TerenApiClient.confirmEntry', () => {
  let http: HttpTestingController;
  let api: TerenApiClient;

  const entryId = '11111111-2222-3333-4444-555555555555';
  const corrected = { schema_version: 1, notes: 'Postavljeni radijatori', work_done: [] };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: API_CONFIG,
          useValue: { baseUrl: 'http://localhost:5080', deviceToken: 'test-token' },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(TerenApiClient);
  });

  afterEach(() => http.verify());

  it('posts the approved structure under `corrected`, and nothing else', async () => {
    const pending = api.confirmEntry(entryId, corrected);

    const request = http.expectOne(`http://localhost:5080/api/entries/${entryId}/confirm`);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Authorization')).toBe('Bearer test-token');
    // Exactly one field. No `structure`, no `raw_transcript`, no status.
    expect(Object.keys(request.request.body as object)).toEqual(['corrected']);
    expect((request.request.body as { corrected: unknown }).corrected).toEqual(corrected);

    request.flush({ id: entryId, status: 'confirmed' });
    expect((await pending).status).toBe('confirmed');
  });

  it('escapes the entry id rather than pasting it into the path', async () => {
    const pending = api.confirmEntry('a/b', corrected).catch(() => undefined);

    http.expectOne('http://localhost:5080/api/entries/a%2Fb/confirm').flush({});
    await pending;
  });
});
