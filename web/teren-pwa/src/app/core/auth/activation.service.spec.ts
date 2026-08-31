import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { EntryStore } from '../db/entry-store';
import { PROJECT_CACHE_KEY } from '../projects/api-project-source';
import { ProjectService, SELECTED_PROJECT_KEY } from '../projects/project.service';
import { SESSION_STORAGE_KEY } from '../session/session';
import { SessionService } from '../session/session.service';
import { UploadService } from '../sync/upload.service';
import { ActivationService, AuthFailure, describeDevice } from './activation.service';
import { AUTH_GATEWAY, AuthGateway } from './auth-gateway';
import { MockAuthGateway } from './mock-auth-gateway';

/** A gateway whose every route fails the same way, for the classification table. */
function failingWith(error: unknown): AuthGateway {
  return {
    activate: () => Promise.reject(error),
    requestActivationCode: () => Promise.reject(error),
    login: () => Promise.reject(error),
  };
}

function httpError(status: number): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'x', error: { detail: 'no' } });
}

describe('ActivationService', () => {
  let gateway: MockAuthGateway;
  const uploads = { wake: vi.fn() };
  const entries = { releaseBlockedByAuth: vi.fn().mockResolvedValue(0) };
  const projects = { load: vi.fn().mockResolvedValue(undefined) };

  function configure(auth: AuthGateway = gateway): ActivationService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AUTH_GATEWAY, useValue: auth },
        { provide: UploadService, useValue: uploads },
        { provide: EntryStore, useValue: entries },
        { provide: ProjectService, useValue: projects },
      ],
    });
    return TestBed.inject(ActivationService);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    entries.releaseBlockedByAuth.mockResolvedValue(0);
    projects.load.mockResolvedValue(undefined);
    gateway = new MockAuthGateway();
  });

  afterEach(() => localStorage.clear());

  describe('activate', () => {
    it('stores the credential, so the very next request goes out as this worker', async () => {
      const activation = configure();

      const result = await activation.activate(
        MockAuthGateway.USERNAME,
        MockAuthGateway.CODE,
        'Zoranov telefon',
      );

      expect(result.ok).toBe(true);
      expect(result.failure).toBeNull();

      const sessions = TestBed.inject(SessionService);
      expect(sessions.token()).toBe('trn_d_mock-device-token');
      expect(sessions.session()?.username).toBe(MockAuthGateway.USERNAME);
      expect(sessions.session()?.companyName).toBe('Gradnja d.o.o.');
      // Persisted, not only published: a credential that did not survive a reload would send the
      // foreman back to this screen the next time he opened the app.
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toContain('trn_d_mock-device-token');
    });

    it('sends the canonical code and a normalised username, never what was typed', async () => {
      const activation = configure();

      // What a phone keyboard produces from a man typing his own name, and a code read off a
      // Cyrillic keyboard: Х К Д are Cyrillic, and the last four are Latin.
      await activation.activate(' Zoran.Jovanovic ', 'XKD4-7HMP');

      expect(gateway.activations).toHaveLength(1);
      expect(gateway.activations[0].username).toBe('zoran.jovanovic');
      expect(gateway.activations[0].activation_code).toBe('XKD47HMP');
    });

    it('names the device, because an admin with four phones has to tell them apart', async () => {
      const activation = configure();

      await activation.activate(MockAuthGateway.USERNAME, MockAuthGateway.CODE);

      expect(gateway.activations[0].device_name).toBe(describeDevice());
      expect(gateway.activations[0].device_name.length).toBeGreaterThan(0);
    });

    /**
     * The obligation `EntryStore.releaseBlockedByAuth`'s own comment records, in spec form.
     *
     * `UploadService` also releases auth-blocked rows when the credential changes, but that
     * effect keys on the token *string*. An idempotent re-activation that hands back the same
     * token would move nothing — in exactly the case where a foreman who was just given a new
     * code has most reason to expect his morning's work to start going out. So the call is made
     * here, explicitly, on every success.
     */
    it('releases auth-blocked entries even when the returned token is the one already held', async () => {
      entries.releaseBlockedByAuth.mockResolvedValue(6);
      const activation = configure();
      await activation.activate(MockAuthGateway.USERNAME, MockAuthGateway.CODE);
      expect(entries.releaseBlockedByAuth).toHaveBeenCalledTimes(1);

      // Same code, same worker, same token back. Nothing about the credential changed.
      const again = await activation.activate(MockAuthGateway.USERNAME, MockAuthGateway.CODE);

      expect(entries.releaseBlockedByAuth).toHaveBeenCalledTimes(2);
      expect(again.released).toBe(6);
      expect(uploads.wake).toHaveBeenCalled();
    });

    it('survives a store that will not open — the phone is activated either way', async () => {
      entries.releaseBlockedByAuth.mockRejectedValue(new Error('IndexedDB is unavailable'));
      const activation = configure();

      const result = await activation.activate(MockAuthGateway.USERNAME, MockAuthGateway.CODE);

      expect(result.ok).toBe(true);
      expect(result.released).toBe(0);
      expect(TestBed.inject(SessionService).token()).toBe('trn_d_mock-device-token');
    });

    /**
     * §10.4. A cached list from the previous holder's company is a set of project ids the new
     * credential cannot use, and `POST /api/entries` answers an unknown project id with a 404 —
     * which is terminal. The recording would never leave the phone.
     */
    it('forgets the cached site list when the phone changes company', async () => {
      localStorage.setItem(PROJECT_CACHE_KEY, '[{"id":"other-company-site"}]');
      localStorage.setItem(SELECTED_PROJECT_KEY, 'other-company-site');
      const activation = configure();

      await activation.activate(MockAuthGateway.USERNAME, MockAuthGateway.CODE);

      expect(localStorage.getItem(PROJECT_CACHE_KEY)).toBeNull();
      expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBeNull();
      // …and it is refetched under the new credential, without the screen waiting for it.
      expect(projects.load).toHaveBeenCalled();
    });

    it('keeps the cached site list when the same company re-activates the phone', async () => {
      const activation = configure();
      await activation.activate(MockAuthGateway.USERNAME, MockAuthGateway.CODE);

      localStorage.setItem(PROJECT_CACHE_KEY, '[{"id":"same-company-site"}]');
      localStorage.setItem(SELECTED_PROJECT_KEY, 'same-company-site');
      await activation.activate(MockAuthGateway.USERNAME, MockAuthGateway.CODE);

      // Clearing here would drop the site he is standing on for no reason at all.
      expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('same-company-site');
    });

    it('never adopts half a session, however good the status code was', async () => {
      const activation = configure({
        ...failingWith(null),
        activate: () => Promise.resolve({ device_token: 'trn_d_x', worker: { username: 'zoran' } }),
      });

      const result = await activation.activate('zoran', 'XKD47HMP');

      expect(result.ok).toBe(false);
      expect(result.failure).toBe('unknown');
      // The app must not believe it is activated in a way it cannot describe. A stored bearer
      // with no company would fail later, on the upload path, as a 401 nobody could explain.
      expect(TestBed.inject(SessionService).session()).toBeNull();
    });

    it('does not throw, whatever the network does', async () => {
      const activation = configure(failingWith(new TypeError('boom')));
      await expect(activation.activate('zoran', 'XKD47HMP')).resolves.toMatchObject({ ok: false });
    });
  });

  /**
   * The classification table.
   *
   * Each row is a sentence a man reads while holding a code he cannot use, and getting one wrong
   * sends him to the wrong person. The most valuable is 404: today it is the *normal* answer,
   * because `/auth/activate` does not exist yet — and telling him "wrong code" when the server
   * never looked at his code would have him asking his boss for a replacement he does not need.
   */
  describe('classification', () => {
    const cases: [number | unknown, AuthFailure][] = [
      [httpError(0), 'offline'],
      [httpError(401), 'rejected'],
      [httpError(403), 'rejected'],
      [httpError(400), 'rejected'],
      [httpError(422), 'rejected'],
      [httpError(404), 'notAvailable'],
      [httpError(429), 'tooManyAttempts'],
      [httpError(500), 'server'],
      [httpError(503), 'server'],
      [{ name: 'TimeoutError' }, 'offline'],
      [new TypeError('something local'), 'unknown'],
    ];

    for (const [error, expected] of cases) {
      it(`reads ${describeError(error)} as '${expected}'`, async () => {
        const activation = configure(failingWith(error));
        const result = await activation.activate('zoran', 'XKD47HMP');
        expect(result.failure).toBe(expected);
      });
    }
  });

  describe('requestCode', () => {
    it('asks for a fresh code and reports acceptance, never existence', async () => {
      const activation = configure();

      const result = await activation.requestCode('  Zoran.Jovanovic ');

      expect(result.ok).toBe(true);
      expect(gateway.codeRequests).toEqual([{ username: 'zoran.jovanovic' }]);
    });

    it('reports a failure rather than throwing', async () => {
      const activation = configure(failingWith(httpError(429)));
      await expect(activation.requestCode('zoran')).resolves.toEqual({
        ok: false,
        failure: 'tooManyAttempts',
      });
    });
  });

  describe('login', () => {
    it('proves the credential and reports the role', async () => {
      const activation = configure();

      const result = await activation.login(' Vlasnik@Gradnja.rs ', MockAuthGateway.PASSWORD);

      expect(result).toMatchObject({
        ok: true,
        role: 'company_admin',
        displayName: 'Milan Gradnja',
      });
      expect(gateway.logins[0].email).toBe('vlasnik@gradnja.rs');
    });

    /**
     * `Session` describes a *device* bound to a worker, and `API_CONFIG` hands its token to every
     * `/api` call as this phone's bearer. Writing an admin session token into that slot would
     * make the app claim a device it does not have, on the one path whose output is provenance on
     * an evidence row. F5–F7 bring the admin surfaces and the storage decision together.
     */
    it('stores nothing — an admin session is not a device credential', async () => {
      const activation = configure();

      await activation.login(MockAuthGateway.EMAIL, MockAuthGateway.PASSWORD);

      expect(TestBed.inject(SessionService).session()).toBeNull();
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    });

    it('reads a wrong password as a rejected credential, not as a broken server', async () => {
      const activation = configure();
      const result = await activation.login(MockAuthGateway.EMAIL, 'not-it');
      expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    });
  });
});

function describeError(error: unknown): string {
  return error instanceof HttpErrorResponse ? `status ${error.status}` : String(error);
}
