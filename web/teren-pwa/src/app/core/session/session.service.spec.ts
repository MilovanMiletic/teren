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
    it('has no credential at all, because the build-time fallback is gone', () => {
      // **This spec is the token flip (D7/F9), and it used to assert the opposite.** Through F2–F6
      // `token()` fell back to a throwaway compiled into the bundle, so `usable()` was true on
      // every install and the gate could not bite. That fallback was the compatibility hinge that
      // kept the demo working while the identity model was built underneath it; it is now retired.
      //
      // Emptying `environment.deviceToken` is what turns the login screens from something a
      // curious person can navigate to into something everyone has to pass, because a credential
      // compiled into a bundle is readable from devtools by anyone who opens it.
      const sessions = TestBed.inject(SessionService);

      expect(sessions.session()).toBeNull();
      expect(sessions.token()).toBe('');
      expect(sessions.usable()).toBe(false);
      expect(sessions.activated()).toBe(false);
    });

    it('keeps the build constant empty, so the fallback cannot be reintroduced by accident', () => {
      // Guarding the constant rather than the behaviour: restoring a value here to "make staging
      // demo out of the box" would silently reopen the door this increment closed, and every other
      // spec in this file would still pass. Activate the box instead — `DemoSeeder` provisions the
      // demo device and prints its username and code.
      //
      // **Still worth asserting now that `token()` no longer reads it (2026-09-02).** This is the
      // only remaining reason the property exists: a credential compiled into the bundle is
      // readable from devtools by anyone who opens them, whether or not this build sends it, and
      // the next thing an edit that restored a value here would do is wire it back up.
      expect(environment.deviceToken).toBe('');
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
      // Read during construction, so the gate can answer on the first frame.
      expect(sessions.activated()).toBe(true);
    });

    it('is not activated by a row it could not fully read', () => {
      // The gate must side with "ask him for a code" over "let a bearer it cannot describe
      // through": a half-session is the one outcome worse than none.
      store({ token: 'trn_d_x', username: 'zoran.jovanovic' });

      const sessions = TestBed.inject(SessionService);

      expect(sessions.session()).toBeNull();
      expect(sessions.activated()).toBe(false);
    });

    it('sends the token the server issued, and nothing else', () => {
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
      // …and it sends nothing at all, rather than a bearer it cannot describe. Asserted against
      // the literal, not against `environment.deviceToken`: since the fallback was deleted the
      // constant is unrelated to this answer, and comparing to it would make the spec pass for
      // the wrong reason on the day somebody put a value back in the build.
      expect(sessions.token()).toBe('');
      expect(sessions.usable()).toBe(false);
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
      expect(TestBed.inject(SessionService).token()).toBe('');
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
