import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { SESSION_STORAGE_KEY, Session } from './session';
import { SessionService } from './session.service';

/** A complete, valid session — every field the narrower insists on. */
function session(overrides: Partial<Session> = {}): Session {
  return {
    token: 'trn_d_a-real-device-token',
    deviceId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    username: 'zoran.jovanovic',
    displayName: 'Zoran Jovanović',
    companyId: '33333333-3333-3333-3333-333333333333',
    companyName: 'Gradnja d.o.o.',
    activatedAt: '2026-08-30T08:00:00.000Z',
    ...overrides,
  };
}

function store(value: unknown): void {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

describe('SessionService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  afterEach(() => localStorage.clear());

  describe('with no stored session', () => {
    it('falls back to the build-time token, so every existing install keeps working', () => {
      // The compatibility hinge of F2. A phone that has never seen an activation screen must send
      // exactly what it sent before this increment existed, or the distributor's demo breaks on
      // the morning he opens it.
      const sessions = TestBed.inject(SessionService);

      expect(sessions.session()).toBeNull();
      expect(sessions.token()).toBe(environment.deviceToken);
      // `.toBe(true)`, not `.toBe(environment.deviceToken.length > 0)` — the latter passes for
      // *any* value of the constant, including the empty string that would mean a demo phone
      // silently stopped uploading. The point of the fallback is that this phone can still send.
      expect(sessions.usable()).toBe(true);
    });
  });

  describe('reading what is on disk', () => {
    it('reads a stored session synchronously, at construction', () => {
      // Synchronously is the whole point: the route guard that decides between the record button
      // and the activation screen has to answer on the first frame, with no awaited promise and
      // no network call, or a foreman in a basement meets a spinner instead of a microphone.
      store(session());

      const sessions = TestBed.inject(SessionService);

      expect(sessions.token()).toBe('trn_d_a-real-device-token');
      expect(sessions.session()?.username).toBe('zoran.jovanovic');
      expect(sessions.usable()).toBe(true);
    });

    it('prefers the stored token over the build-time one', () => {
      store(session({ token: 'trn_d_issued-by-the-server' }));

      expect(TestBed.inject(SessionService).token()).toBe('trn_d_issued-by-the-server');
    });
  });

  describe('a row this build cannot fully understand', () => {
    /**
     * Every one of these must resolve to `null` — a whole session or none.
     *
     * A half-recognised session is the worst outcome available: the app would believe it is
     * activated and send a bearer it cannot describe, and the failure would surface as a 401 on
     * the upload path rather than as a screen asking for a code.
     */
    it.each([
      ['not JSON at all', 'this is not json'],
      ['a JSON primitive', '"just-a-string"'],
      ['null', 'null'],
      ['an empty object', {}],
      ['a session with no token', { ...session(), token: undefined }],
      ['a session with a blank token', { ...session(), token: '   ' }],
      ['a session with a numeric token', { ...session(), token: 12345 }],
      ['a row written before a field existed', { ...session(), companyId: undefined }],
      ['a row missing the worker', { ...session(), username: undefined }],
    ])('resolves %s to null rather than half a session', (_label, value) => {
      store(value);

      const sessions = TestBed.inject(SessionService);

      expect(sessions.session()).toBeNull();
      // …and it falls back rather than sending an empty bearer.
      expect(sessions.token()).toBe(environment.deviceToken);
    });
  });

  it('survives localStorage throwing outright', () => {
    // Bootstrap must never be able to fail (`app.config.ts`), and this service is constructed
    // during it. Private mode, a blocked-cookies setting or a locked-down WebView can make
    // `getItem` throw rather than return null — a blank app is the one outcome a foreman on a
    // roof can do nothing with.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    try {
      expect(() => TestBed.inject(SessionService)).not.toThrow();
      expect(TestBed.inject(SessionService).token()).toBe(environment.deviceToken);
    } finally {
      getItem.mockRestore();
    }
  });

  describe('adopt', () => {
    it('publishes the new credential and persists it for the next launch', () => {
      const sessions = TestBed.inject(SessionService);

      sessions.adopt(session({ token: 'trn_d_freshly-activated' }));

      expect(sessions.token()).toBe('trn_d_freshly-activated');
      expect(sessions.usable()).toBe(true);
      expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!).token).toBe(
        'trn_d_freshly-activated',
      );
    });

    it('keeps the credential usable even when it cannot be written down', () => {
      // A quota error means the session will not survive a reload — one re-activation, once. It
      // must never take down the activation that produced it: the token is already good and the
      // phone can record and upload with it for as long as the app stays open.
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });

      try {
        const sessions = TestBed.inject(SessionService);
        expect(() => sessions.adopt(session({ token: 'trn_d_unwritable' }))).not.toThrow();
        expect(sessions.token()).toBe('trn_d_unwritable');
      } finally {
        setItem.mockRestore();
      }
    });
  });
});
