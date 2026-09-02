import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../session/admin-session';
import { COMPANY_GATEWAY, CompanyGateway } from './company-gateway';
import {
  COMPANY_STATUSES,
  CompanyService,
  CompanyStatus,
  serverAnswered,
} from './company.service';
import { MockCompanyGateway } from './mock-company-gateway';

/** A signed-in company admin, exactly as `POST /auth/login` left him in this browser. */
const ADMIN: AdminSession = {
  token: 'trn_s_a-real-admin-session',
  // Far enough out that `hasExpired` never turns this spec red on a slow machine.
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'company_admin',
  userId: '99999999-9999-9999-9999-999999999999',
  displayName: 'Milan Gradnja',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Vodoinstal Petrović d.o.o.',
  signedInAt: '2026-08-31T08:00:00.000Z',
};

function httpError(status: number, body: unknown = { detail: 'no' }): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'x', error: body });
}

/** A gateway whose every route rejects the same way, for the classification table. */
function failingWith(error: unknown): CompanyGateway {
  return {
    me: () => Promise.reject(error),
    listWorkers: () => Promise.reject(error),
    addWorker: () => Promise.reject(error),
    shareText: () => Promise.reject(error),
    issueCode: () => Promise.reject(error),
    listDevices: () => Promise.reject(error),
    revokeDevice: () => Promise.reject(error),
  };
}

/**
 * A gateway whose every route throws **synchronously**, before it ever returns a promise.
 *
 * Not a contrivance: `CompanyGateway` is an interface returning promises, not a promise-returning
 * base class, and nothing stops an implementation — a future decorator, a caching layer, a spec
 * double — from throwing on the way in. A `try` around an `await` catches it; a bare
 * `.then().catch()` on a call that never returned does not. The distinction is invisible until
 * the day it isn't.
 */
function throwingSynchronouslyWith(error: unknown): CompanyGateway {
  const bang = (): never => {
    throw error;
  };
  return {
    me: bang,
    listWorkers: bang,
    addWorker: bang,
    shareText: bang,
    issueCode: bang,
    listDevices: bang,
    revokeDevice: bang,
  };
}

describe('CompanyService', () => {
  let gateway: MockCompanyGateway;

  function configure(company: CompanyGateway = gateway, signedIn = true): CompanyService {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(ADMIN));
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: COMPANY_GATEWAY, useValue: company }],
    });
    return TestBed.inject(CompanyService);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    gateway = new MockCompanyGateway();
  });

  afterEach(() => localStorage.clear());

  describe('listWorkers', () => {
    it('narrows the company into rows a screen can act on', async () => {
      const service = configure();

      const result = await service.listWorkers();

      expect(result.status).toBe('ok');
      expect(result.workers).toHaveLength(2);
      expect(result.workers[0]).toMatchObject({
        id: MockCompanyGateway.ZORAN_ID,
        displayName: 'Zoran Jovanović',
        username: 'zoran.jovanovic',
        disabled: false,
        activeDeviceCount: 1,
        hasLiveCode: true,
      });
      // The ordinary case, not a defect: a man with no address cannot ask for his own code.
      expect(result.workers[1].email).toBeNull();
      expect(result.workers[1].hasLiveCode).toBe(false);
    });

    /**
     * Every button on the screen addresses a worker by id and identifies him by name. A row
     * missing either is a row that either does nothing when tapped or that nobody can recognise,
     * so it is dropped rather than rendered half-formed.
     */
    it('drops a row that could not be acted on, and keeps the rest', async () => {
      const service = configure({
        ...failingWith(null),
        listWorkers: () =>
          Promise.resolve({
            workers: [
              { id: null, display_name: 'No id at all' },
              { id: 'has-id', display_name: '   ' },
              { id: 'good', display_name: 'Zoran Jovanović' },
            ],
          }),
      });

      const result = await service.listWorkers();

      expect(result.status).toBe('ok');
      expect(result.workers.map((worker) => worker.id)).toEqual(['good']);
    });

    it('answers an empty body without inventing a company', async () => {
      const service = configure({ ...failingWith(null), listWorkers: () => Promise.resolve({}) });
      await expect(service.listWorkers()).resolves.toEqual({ status: 'ok', workers: [] });
    });

    it('never sends a request when this browser holds no admin credential', async () => {
      const service = configure(gateway, false);

      const result = await service.listWorkers();

      // `notSignedIn`, never a 401: sending `Bearer ` and reading the refusal back would tell the
      // screen the session expired when in fact there never was one.
      expect(result).toEqual({ status: 'notSignedIn', workers: [] });
    });
  });

  /**
   * One foreman by id, and **there is no endpoint for it**.
   *
   * `WorkerEndpoints.cs` exposes the list, the code, the share text and a PATCH; a per-worker read
   * was left out of scope for a frontend-only increment, so the man's page reads him out of the
   * company's own list. These specs pin the two properties that makes acceptable — tenancy still
   * decides what can be found, and a failed read is never reported as a man who does not exist.
   */
  describe('getWorker', () => {
    it('finds one man in the company list', async () => {
      const service = configure();

      const result = await service.getWorker(MockCompanyGateway.ZORAN_ID);

      expect(result.status).toBe('ok');
      expect(result.missing).toBe(false);
      expect(result.worker).toMatchObject({
        id: MockCompanyGateway.ZORAN_ID,
        displayName: 'Zoran Jovanović',
        username: 'zoran.jovanovic',
      });
    });

    /**
     * The list is scoped to his company server-side, so another company's worker is simply not in
     * it — and comes back as `missing`, exactly as one that does not exist does. That is the
     * server's own doctrine (a foreign id is a 404) and the client must not invent a distinction
     * the API refuses to make.
     */
    it('answers "not in this company" for an id that is not in the list', async () => {
      const service = configure();

      const result = await service.getWorker('d3a0c1f0-5b8e-4f1a-9c62-00000000ffff');

      expect(result).toEqual({ status: 'ok', worker: null, missing: true });
    });

    /**
     * **A read that did not answer is not a man who does not exist.** On the screen that hands out
     * credentials, announcing that a foreman is not in the company because the wifi blipped would
     * be the worst thing it could say — so `missing` stays false and the status carries the reason.
     */
    it('never reports a failed read as a missing man', async () => {
      for (const [error, expected] of [
        [httpError(0), 'offline'],
        [httpError(401), 'signedOut'],
        [httpError(403), 'forbidden'],
        [httpError(500), 'unavailable'],
      ] as [unknown, CompanyStatus][]) {
        const service = configure(failingWith(error));

        const result = await service.getWorker(MockCompanyGateway.ZORAN_ID);

        expect(result).toEqual({ status: expected, worker: null, missing: false });
      }
    });

    it('never sends a request when this browser holds no admin credential', async () => {
      const service = configure(gateway, false);

      await expect(service.getWorker(MockCompanyGateway.ZORAN_ID)).resolves.toEqual({
        status: 'notSignedIn',
        worker: null,
        missing: false,
      });
    });

    /** Reading a man's page must never touch his code. It is one GET of a list. */
    it('spends nothing', async () => {
      const service = configure();

      await service.getWorker(MockCompanyGateway.ZORAN_ID);

      expect(gateway.reads).toEqual([]);
      expect(gateway.issues).toEqual([]);
    });
  });

  describe('listDevices', () => {
    it('returns the revoked phones alongside the live ones', async () => {
      const service = configure();

      const result = await service.listDevices();

      expect(result.status).toBe('ok');
      expect(result.devices).toHaveLength(3);
      // Both are needed to answer "which of these am I taking away" — a list of only live phones
      // reads as though the withdrawn one never existed.
      expect(result.devices.filter((phone) => phone.revokedAt !== null)).toHaveLength(1);
      expect(result.devices[0]).toMatchObject({
        id: MockCompanyGateway.ZORAN_PHONE_ID,
        name: 'Zoranov telefon',
        userId: MockCompanyGateway.ZORAN_ID,
      });
    });

    it('drops a phone with no id, because it could never be revoked', async () => {
      const service = configure({
        ...failingWith(null),
        listDevices: () =>
          Promise.resolve({ devices: [{ id: null, name: 'Ghost' }, { id: 'real', name: null }] }),
      });

      const result = await service.listDevices();

      expect(result.devices.map((phone) => phone.id)).toEqual(['real']);
      // A phone that reached activation without a name still has to be revocable.
      expect(result.devices[0].name).toBe('');
    });

    it('answers notSignedIn without reaching the wire', async () => {
      const service = configure(gateway, false);
      await expect(service.listDevices()).resolves.toEqual({ status: 'notSignedIn', devices: [] });
    });
  });

  describe('readCode', () => {
    /**
     * The property the whole feature is built around (§5, and the reversal that put the plaintext
     * back in the database): looking at a code must never spend it. An admin sends a code by
     * Viber and taps back an hour later to read it aloud; if reading re-issued, it would kill the
     * code the man is at that moment typing.
     */
    it('reads a live code without minting one', async () => {
      const service = configure();

      const result = await service.readCode(MockCompanyGateway.ZORAN_ID);

      expect(result.status).toBe('ok');
      expect(result.code?.code).toBe(MockCompanyGateway.LIVE_CODE);
      expect(result.code?.expiresAt).toBe('2026-09-07T14:00:00.000Z');
      expect(result.code?.emailDelivery).toBe('not_configured');
      expect(result.shareText).toContain(MockCompanyGateway.LIVE_CODE);
      expect(result.noLiveCode).toBe(false);

      expect(gateway.reads).toEqual([MockCompanyGateway.ZORAN_ID]);
      expect(gateway.issues).toEqual([]);

      // And it is still the same code afterwards — the read changed nothing on the server.
      const again = await service.readCode(MockCompanyGateway.ZORAN_ID);
      expect(again.code?.code).toBe(MockCompanyGateway.LIVE_CODE);
    });

    /**
     * `409 no_live_activation_code` is the server stating a fact about the worker, not refusing
     * the request — modelled the way `ArchiveService` models a 404: a state the screen renders,
     * not an error it apologises for.
     */
    it('reads "he has no code" as information rather than as failure', async () => {
      const service = configure();

      const result = await service.readCode(MockCompanyGateway.MARKO_ID);

      expect(result).toEqual({ status: 'ok', code: null, shareText: null, noLiveCode: true });
    });

    /**
     * "A 409 is never judged alone... never on the English detail string" (CLAUDE.md, from B3).
     * A conflict this build cannot name is a plain refusal — offering to issue a code off the back
     * of prose nobody parsed is how a screen invents a state the server never described.
     */
    it('branches on the problem code and never on the English sentence', async () => {
      const prose = configure({
        ...failingWith(
          httpError(409, { detail: 'Worker has no live activation code.', title: 'Conflict' }),
        ),
      });
      await expect(prose.readCode('anyone')).resolves.toMatchObject({
        status: 'refused',
        noLiveCode: false,
      });

      const other = configure({ ...failingWith(httpError(409, { code: 'something_else' })) });
      await expect(other.readCode('anyone')).resolves.toMatchObject({
        status: 'refused',
        noLiveCode: false,
      });
    });

    it('answers notSignedIn without reaching the wire', async () => {
      const service = configure(gateway, false);
      await expect(service.readCode(MockCompanyGateway.ZORAN_ID)).resolves.toEqual({
        status: 'notSignedIn',
        code: null,
        shareText: null,
        noLiveCode: false,
      });
      expect(gateway.reads).toEqual([]);
    });
  });

  describe('issueCode', () => {
    /**
     * **Issuing supersedes.** The previous code stops working the instant a new one exists, and
     * the service must hand back the new one — a caller left holding the old string would show an
     * admin a code that is already dead, which is a foreman typing at a locked door while his
     * boss watches.
     */
    it('supersedes the code the man was holding and returns the new one', async () => {
      const service = configure();
      const before = await service.readCode(MockCompanyGateway.ZORAN_ID);
      expect(before.code?.code).toBe(MockCompanyGateway.LIVE_CODE);

      const issued = await service.issueCode(MockCompanyGateway.ZORAN_ID);

      expect(issued.status).toBe('ok');
      expect(issued.code?.code).not.toBe(MockCompanyGateway.LIVE_CODE);
      expect(gateway.issues).toEqual([MockCompanyGateway.ZORAN_ID]);

      // The server no longer holds the old one at all: a later read returns the new code.
      const after = await service.readCode(MockCompanyGateway.ZORAN_ID);
      expect(after.code?.code).toBe(issued.code?.code);
      expect(after.code?.code).not.toBe(MockCompanyGateway.LIVE_CODE);
    });

    it('carries the ready-made message back with the code', async () => {
      const service = configure();

      const issued = await service.issueCode(MockCompanyGateway.ZORAN_ID);

      expect(issued.shareText).toContain(issued.code?.code ?? 'nothing');
      expect(issued.shareText).toContain('Zoran Jovanović');
    });

    /**
     * The second call is a convenience and the first is the act. A share text that did not answer
     * must not turn an issue that **did** into a reported failure — the admin would press again
     * and supersede a code that is already on its way to a man's phone.
     */
    it('keeps a successful issue successful when the message could not be fetched', async () => {
      const service = configure({
        ...failingWith(null),
        issueCode: (id: string) => gateway.issueCode(id),
        shareText: () => Promise.reject(httpError(500)),
      });

      const issued = await service.issueCode(MockCompanyGateway.ZORAN_ID);

      expect(issued.status).toBe('ok');
      expect(issued.code?.code).toBeTruthy();
      expect(issued.shareText).toBeNull();
    });

    it('does not throw when the message call blows up before it returns a promise', async () => {
      const service = configure({
        ...failingWith(null),
        issueCode: (id: string) => gateway.issueCode(id),
        shareText: () => {
          throw new TypeError('a decorator that never returned a promise');
        },
      });

      const issued = await service.issueCode(MockCompanyGateway.ZORAN_ID);

      expect(issued.status).toBe('ok');
      expect(issued.shareText).toBeNull();
    });

    /**
     * A 200 whose body this build cannot read. The code **was** issued and the previous one is
     * dead, so the honest answer is "we could not confirm", never "it failed": `serverAnswered`
     * is false for `unavailable`, which is what makes the screen say *reload* instead of *try
     * again*. Pressing again would supersede a code that already exists.
     */
    it('refuses to call an unreadable success a failure the admin may retry', async () => {
      const service = configure({ ...failingWith(null), issueCode: () => Promise.resolve({}) });

      const issued = await service.issueCode('anyone');

      expect(issued.code).toBeNull();
      expect(issued.status).toBe('unavailable');
      expect(serverAnswered(issued.status)).toBe(false);
    });

    it('answers notSignedIn without minting anything', async () => {
      const service = configure(gateway, false);
      await expect(service.issueCode(MockCompanyGateway.ZORAN_ID)).resolves.toMatchObject({
        status: 'notSignedIn',
        code: null,
      });
      expect(gateway.issues).toEqual([]);
    });
  });

  describe('addWorker', () => {
    it('adds a foreman and hands back his first code', async () => {
      const service = configure();

      const result = await service.addWorker('  Petar Petrović  ', '  Petar@Firma.RS  ');

      expect(result.status).toBe('ok');
      expect(result.worker?.displayName).toBe('Petar Petrović');
      expect(result.code?.code).toBeTruthy();
      expect(result.conflict).toBeNull();
    });

    /**
     * §4: the server proposes the username from the display name and retries its own proposal if
     * it loses a race, so an admin adding a man never meets a "that name is taken" fight he did
     * not pick. A field for it would be a field to get wrong.
     */
    it('never sends a username, and normalises what it does send', async () => {
      const service = configure();

      await service.addWorker('  Petar Petrović  ', '  Petar@Firma.RS  ');

      expect(gateway.added).toEqual([
        { display_name: 'Petar Petrović', email: 'petar@firma.rs' },
      ]);
      expect(gateway.added[0]).not.toHaveProperty('username');
    });

    it('omits the address entirely rather than sending an empty one', async () => {
      const service = configure();

      await service.addWorker('Petar Petrović', '   ');

      expect(gateway.added).toEqual([{ display_name: 'Petar Petrović' }]);
      expect(gateway.added[0]).not.toHaveProperty('email');
    });

    /**
     * The two conflicts mean different things to the admin and must not be collapsed. A taken
     * **email** is his mistake and he fixes it by changing a field; a taken **username** is a
     * race the server lost with itself and the remedy is to press the button again. One sentence
     * for both would send him to change a field that was never the problem.
     */
    it('tells a taken address apart from a lost username race', async () => {
      const email = configure({ ...failingWith(httpError(409, { code: 'email_taken' })) });
      await expect(email.addWorker('Petar', 'zauzeto@firma.rs')).resolves.toMatchObject({
        status: 'refused',
        conflict: 'email',
        worker: null,
      });

      const username = configure({ ...failingWith(httpError(409, { code: 'username_taken' })) });
      await expect(username.addWorker('Petar', null)).resolves.toMatchObject({
        status: 'refused',
        conflict: 'username',
      });
    });

    it('claims no conflict it cannot name', async () => {
      const service = configure({ ...failingWith(httpError(409, { detail: 'Conflict.' })) });
      await expect(service.addWorker('Petar', null)).resolves.toMatchObject({
        status: 'refused',
        conflict: null,
      });
    });

    it('does not report a man as added when the response says nothing about him', async () => {
      const service = configure({ ...failingWith(null), addWorker: () => Promise.resolve({}) });

      const result = await service.addWorker('Petar', null);

      expect(result.worker).toBeNull();
      expect(result.status).toBe('unavailable');
    });

    it('answers notSignedIn without adding anyone', async () => {
      const service = configure(gateway, false);
      await expect(service.addWorker('Petar', null)).resolves.toMatchObject({
        status: 'notSignedIn',
        worker: null,
      });
      expect(gateway.added).toEqual([]);
    });
  });

  describe('revokeDevice', () => {
    it('withdraws a phone and returns it stamped, never deleted', async () => {
      const service = configure();

      const result = await service.revokeDevice(MockCompanyGateway.ZORAN_PHONE_ID);

      expect(result.status).toBe('ok');
      expect(result.device?.id).toBe(MockCompanyGateway.ZORAN_PHONE_ID);
      expect(result.device?.revokedAt).not.toBeNull();
      expect(gateway.revokes).toEqual([MockCompanyGateway.ZORAN_PHONE_ID]);

      // The row survives the revoke: `entry.device_id` is provenance on evidence, and an
      // administrative action must not degrade evidence.
      const devices = await service.listDevices();
      expect(devices.devices.map((phone) => phone.id)).toContain(
        MockCompanyGateway.ZORAN_PHONE_ID,
      );
    });

    it('answers a second revoke exactly as the first, so a double tap is harmless', async () => {
      const service = configure();

      const first = await service.revokeDevice(MockCompanyGateway.ZORAN_PHONE_ID);
      const second = await service.revokeDevice(MockCompanyGateway.ZORAN_PHONE_ID);

      expect(second.status).toBe('ok');
      expect(second.device?.revokedAt).toBe(first.device?.revokedAt);
    });

    it('reads an unknown phone as a refusal the server stands behind', async () => {
      const service = configure();
      await expect(service.revokeDevice('d3a0c1f0-0000-0000-0000-000000000000')).resolves.toEqual({
        status: 'refused',
        device: null,
      });
    });

    it('answers notSignedIn without revoking anything', async () => {
      const service = configure(gateway, false);
      await expect(service.revokeDevice(MockCompanyGateway.ZORAN_PHONE_ID)).resolves.toEqual({
        status: 'notSignedIn',
        device: null,
      });
      expect(gateway.revokes).toEqual([]);
    });
  });

  /**
   * Every call the screen can make, so the two properties below are asserted about all of them
   * rather than about whichever one somebody remembered.
   */
  const CALLS: [string, (service: CompanyService) => Promise<{ status: CompanyStatus }>][] = [
    ['listWorkers', (service) => service.listWorkers()],
    ['getWorker', (service) => service.getWorker(MockCompanyGateway.ZORAN_ID)],
    ['listDevices', (service) => service.listDevices()],
    ['readCode', (service) => service.readCode(MockCompanyGateway.ZORAN_ID)],
    ['issueCode', (service) => service.issueCode(MockCompanyGateway.ZORAN_ID)],
    ['addWorker', (service) => service.addWorker('Petar Petrović', 'petar@firma.rs')],
    ['revokeDevice', (service) => service.revokeDevice(MockCompanyGateway.ZORAN_PHONE_ID)],
  ];

  /**
   * The classification table.
   *
   * Each row is a sentence an owner reads while a foreman waits for a code, and getting one wrong
   * offers him the wrong remedy. The two that carry the most: **401** is fixed by signing in
   * again and **403** never is, so collapsing them — as the archive and the profile screen
   * legitimately do — would put a sign-in button in front of a man whose role simply does not
   * allow this.
   */
  describe('classification', () => {
    const cases: [unknown, CompanyStatus][] = [
      [httpError(0), 'offline'],
      [{ name: 'TimeoutError' }, 'offline'],
      [httpError(401), 'signedOut'],
      [httpError(403), 'forbidden'],
      [httpError(400), 'refused'],
      [httpError(404), 'refused'],
      [httpError(409), 'refused'],
      [httpError(422), 'refused'],
      [httpError(429), 'unavailable'],
      [httpError(500), 'unavailable'],
      [httpError(503), 'unavailable'],
      [new TypeError('something local'), 'unavailable'],
      [null, 'unavailable'],
    ];

    for (const [error, expected] of cases) {
      for (const [name, call] of CALLS) {
        it(`reads ${describeError(error)} from ${name} as '${expected}'`, async () => {
          const service = configure(failingWith(error));
          await expect(call(service)).resolves.toMatchObject({ status: expected });
        });
      }
    }
  });

  /**
   * **No method throws, ever.**
   *
   * A rejected promise reaching the component would leave an owner looking at a spinner with no
   * sentence under it — the failure mode `ArchiveService` and `ProfileService` are built the same
   * way to avoid. Asserted against a gateway that rejects *and* one that throws before it returns
   * at all, because only the second can catch a `.then()` chain that sits outside its `try`.
   */
  describe('never throws', () => {
    const disasters: [string, unknown][] = [
      ['a 500', httpError(500)],
      ['a rejected credential', httpError(401)],
      ['a network failure', httpError(0)],
      ['a plain Error', new Error('boom')],
      ['nothing at all', null],
      ['a string', 'boom'],
    ];

    for (const [name, call] of CALLS) {
      for (const [description, error] of disasters) {
        it(`${name} answers rather than rejecting on ${description}`, async () => {
          const rejecting = configure(failingWith(error));
          const answer = await call(rejecting);
          expect(COMPANY_STATUSES).toContain(answer.status);
          expect(answer.status).not.toBe('ok');
        });

        it(`${name} answers rather than rejecting when ${description} is thrown outright`, async () => {
          const throwing = configure(throwingSynchronouslyWith(error));
          const answer = await call(throwing);
          expect(COMPANY_STATUSES).toContain(answer.status);
          expect(answer.status).not.toBe('ok');
        });
      }
    }
  });

  /**
   * The difference between "it did not work" and "we do not know whether it worked".
   *
   * Both mutations on this screen are destructive in one direction: issuing supersedes a live
   * code, and revoking stops a phone sending. Where the server never gave a verdict the screen
   * must say so and ask for a reload, because an admin told "failed" about a request that in fact
   * succeeded will press the button again.
   */
  describe('serverAnswered', () => {
    it('is true only where the server actually looked at the request', () => {
      expect(serverAnswered('ok')).toBe(true);
      expect(serverAnswered('signedOut')).toBe(true);
      expect(serverAnswered('forbidden')).toBe(true);
      expect(serverAnswered('refused')).toBe(true);

      expect(serverAnswered('offline')).toBe(false);
      expect(serverAnswered('unavailable')).toBe(false);
      expect(serverAnswered('notSignedIn')).toBe(false);
    });

    it('has an answer for every status the service can produce', () => {
      for (const status of COMPANY_STATUSES) {
        expect(typeof serverAnswered(status)).toBe('boolean');
      }
      expect(COMPANY_STATUSES).toHaveLength(7);
    });
  });
});

function describeError(error: unknown): string {
  return error instanceof HttpErrorResponse ? `status ${error.status}` : String(error);
}
