import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { UploadFailure } from '../api/api-failure';
import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../session/admin-session';
import { AdminSessionService } from '../session/admin-session.service';
import { MockPlatformGateway } from './mock-platform-gateway';
import { PLATFORM_GATEWAY, PlatformGateway } from './platform-gateway';
import {
  PLATFORM_STATUSES,
  PlatformService,
  PlatformStatus,
  serverAnswered,
} from './platform.service';

/**
 * A signed-in member of Teren staff, exactly as `POST /auth/login` left him in this browser.
 *
 * `companyId` is null and that is not an omission: a super admin has no company by construction
 * (`ck_app_user_company_scope`), which is the whole reason the add form has two tabs.
 */
const STAFF: AdminSession = {
  token: 'trn_s_a-real-staff-session',
  // Far enough out that `hasExpired` never turns this spec red on a slow machine.
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'super_admin',
  userId: MockPlatformGateway.FOUNDER_ID,
  displayName: 'Milovan Miletić',
  companyId: null,
  companyName: null,
  signedInAt: '2026-09-01T08:00:00.000Z',
};

function httpError(status: number, body: unknown = { detail: 'no' }): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'x', error: body });
}

/** A gateway whose every route rejects the same way, for the classification table. */
function failingWith(error: unknown): PlatformGateway {
  return {
    listCompanies: () => Promise.reject(error),
    createCompany: () => Promise.reject(error),
    suspendCompany: () => Promise.reject(error),
    resumeCompany: () => Promise.reject(error),
    listUsers: () => Promise.reject(error),
    createAdmin: () => Promise.reject(error),
    invite: () => Promise.reject(error),
    disableUser: () => Promise.reject(error),
    enableUser: () => Promise.reject(error),
    listLogs: () => Promise.reject(error),
    exportLogs: () => Promise.reject(error),
  };
}

/**
 * A gateway whose every route throws **synchronously**, before it ever returns a promise.
 *
 * Not a contrivance: `PlatformGateway` is an interface returning promises, not a promise-returning
 * base class, and nothing stops an implementation — a decorator, a caching layer, a spec double —
 * from throwing on the way in. A `try` around an `await` catches it; a bare `.then().catch()` on a
 * call that never returned does not.
 */
function throwingSynchronouslyWith(error: unknown): PlatformGateway {
  const bang = (): never => {
    throw error;
  };
  return {
    listCompanies: bang,
    createCompany: bang,
    suspendCompany: bang,
    resumeCompany: bang,
    listUsers: bang,
    createAdmin: bang,
    invite: bang,
    disableUser: bang,
    enableUser: bang,
    listLogs: bang,
    exportLogs: bang,
  };
}

describe('PlatformService', () => {
  let gateway: MockPlatformGateway;

  function configure(platform: PlatformGateway = gateway, signedIn = true): PlatformService {
    localStorage.clear();
    if (signedIn) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(STAFF));
    }
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_GATEWAY, useValue: platform }],
    });
    return TestBed.inject(PlatformService);
  }

  /**
   * A gateway that answers one route with a hand-written body and refuses everything else.
   *
   * The refusal is deliberate: a narrowing spec that accidentally exercised a second route would
   * be asserting about the mock rather than about the body under test.
   */
  function answering(overrides: Partial<PlatformGateway>): PlatformGateway {
    return { ...failingWith(httpError(500)), ...overrides };
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    gateway = new MockPlatformGateway();
  });

  afterEach(() => localStorage.clear());

  // ---- Reading the customers ------------------------------------------------------------------

  describe('listCustomers', () => {
    it('narrows the customers into rows a screen can act on', async () => {
      const service = configure();

      const result = await service.listCustomers();

      expect(result.status).toBe('ok');
      expect(result.customers).toHaveLength(2);
      expect(result.customers[0]).toEqual({
        id: MockPlatformGateway.VODOINSTAL_ID,
        name: 'Vodoinstal Petrović d.o.o.',
        createdAt: '2026-08-01T09:00:00.000Z',
        suspendedAt: null,
        userCount: 3,
        activeUserCount: 3,
      });
      // Withdrawn, and the stamp is what says so — a boolean would lose "since when".
      expect(result.customers[1].suspendedAt).toBe('2026-08-28T11:00:00.000Z');
      expect(result.nextCursor).toBeNull();
    });

    /**
     * Every action on this screen addresses a customer by id and names him in the question it asks
     * first. A row missing either is a row that does nothing when tapped or that nobody can
     * recognise — so it is dropped rather than drawn half-formed.
     */
    it('drops a customer it could not name or act on, and keeps the rest', async () => {
      const service = configure(
        answering({
          listCompanies: () =>
            Promise.resolve({
              companies: [
                { id: null, name: 'No id at all' },
                { id: 'has-id', name: '   ' },
                { id: 'good', name: 'Vodoinstal Petrović d.o.o.' },
              ],
            }),
        }),
      );

      const result = await service.listCustomers();

      expect(result.status).toBe('ok');
      expect(result.customers.map((customer) => customer.id)).toEqual(['good']);
    });

    it('answers an empty body without inventing a customer', async () => {
      const service = configure(answering({ listCompanies: () => Promise.resolve({}) }));

      await expect(service.listCustomers()).resolves.toEqual({
        status: 'ok',
        customers: [],
        nextCursor: null,
      });
    });

    /** A count the wire could not state is nought, never `NaN` on the glass. */
    it('reads a missing or nonsensical count as nought', async () => {
      const service = configure(
        answering({
          listCompanies: () =>
            Promise.resolve({
              companies: [
                {
                  id: 'good',
                  name: 'Vodoinstal',
                  user_count: null,
                  active_user_count: -3,
                },
              ],
            }),
        }),
      );

      const result = await service.listCustomers();

      expect(result.customers[0].userCount).toBe(0);
      expect(result.customers[0].activeUserCount).toBe(0);
    });

    it('carries the cursor when there is another page, and null when there is not', async () => {
      const more = configure(
        answering({
          listCompanies: () => Promise.resolve({ companies: [], next_cursor: 'opaque-cursor' }),
        }),
      );
      await expect(more.listCustomers()).resolves.toMatchObject({ nextCursor: 'opaque-cursor' });

      const last = configure(
        answering({ listCompanies: () => Promise.resolve({ companies: [], next_cursor: '  ' }) }),
      );
      await expect(last.listCustomers()).resolves.toMatchObject({ nextCursor: null });
    });
  });

  // ---- Reading the people ---------------------------------------------------------------------

  describe('listPeople', () => {
    it('narrows every account in the product into rows a screen can group', async () => {
      const service = configure();

      const result = await service.listPeople();

      expect(result.status).toBe('ok');
      expect(result.people).toHaveLength(3);
      expect(result.people[0]).toEqual({
        id: MockPlatformGateway.FOUNDER_ID,
        companyId: null,
        companyName: null,
        role: 'super_admin',
        username: null,
        displayName: 'Milovan Miletić',
        email: 'osnivac@teren.rs',
        createdAt: '2026-07-01T08:00:00.000Z',
        lastLoginAt: '2026-09-01T07:30:00.000Z',
        disabled: false,
        passwordPending: false,
      });
      // Invited and never finished: the state the founder chases.
      expect(result.people[1]).toMatchObject({
        role: 'company_admin',
        passwordPending: true,
        lastLoginAt: null,
      });
      // And a foreman, whose username is his durable identity and who has no password by
      // constraint — `passwordPending` is permanently true for him and means nothing is wrong.
      expect(result.people[2]).toMatchObject({
        role: 'worker',
        username: 'zoran.jovanovic',
        passwordPending: true,
      });
    });

    /**
     * A row is drawn only when it can be named and its role known. The role decides which group it
     * lands in and which chips it may carry, so a roleless row would be an account the screen
     * files under "foremen" on a guess.
     */
    it('drops a row missing an id, a role or a name, and keeps the rest', async () => {
      const service = configure(
        answering({
          listUsers: () =>
            Promise.resolve({
              users: [
                { id: null, role: 'company_admin', display_name: 'No id' },
                { id: 'no-role', role: null, display_name: 'No role' },
                { id: 'no-name', role: 'worker', display_name: '   ' },
                { id: 'good', role: 'company_admin', display_name: 'Petar Petrović' },
              ],
            }),
        }),
      );

      const result = await service.listPeople();

      expect(result.status).toBe('ok');
      expect(result.people.map((person) => person.id)).toEqual(['good']);
    });

    it('reads a withdrawal stamp as a boolean the screen can act on, never as a delete', async () => {
      const service = configure(
        answering({
          listUsers: () =>
            Promise.resolve({
              users: [
                {
                  id: 'gone',
                  role: 'company_admin',
                  display_name: 'Petar Petrović',
                  disabled_at: '2026-08-30T09:00:00.000Z',
                },
              ],
            }),
        }),
      );

      const result = await service.listPeople();

      expect(result.people[0].disabled).toBe(true);
    });

    /**
     * `password_pending` is the `status=pending` filter's whole meaning, and it is a boolean the
     * server states. Anything that is not literally `true` is false — a `null` from an older build
     * must not put a warning chip beside a man who is perfectly fine.
     */
    it('believes only a literal true about a missing password', async () => {
      const service = configure(
        answering({
          listUsers: () =>
            Promise.resolve({
              users: [
                { id: 'a', role: 'company_admin', display_name: 'A', password_pending: null },
                { id: 'b', role: 'company_admin', display_name: 'B' },
                { id: 'c', role: 'company_admin', display_name: 'C', password_pending: true },
              ],
            }),
        }),
      );

      const result = await service.listPeople();

      expect(result.people.map((person) => person.passwordPending)).toEqual([false, false, true]);
    });

    it('answers an empty body without inventing an account', async () => {
      const service = configure(answering({ listUsers: () => Promise.resolve({}) }));

      await expect(service.listPeople()).resolves.toEqual({
        status: 'ok',
        people: [],
        nextCursor: null,
      });
    });
  });

  // ---- Creating -------------------------------------------------------------------------------

  describe('createCustomer', () => {
    it('adds a customer and narrows him back', async () => {
      const service = configure();

      const result = await service.createCustomer('  Gradnja Ilić d.o.o.  ');

      expect(result.status).toBe('ok');
      expect(result.customer).toMatchObject({
        name: 'Gradnja Ilić d.o.o.',
        suspendedAt: null,
        userCount: 0,
        activeUserCount: 0,
      });

      const listed = await service.listCustomers();
      expect(listed.customers.map((customer) => customer.name)).toContain('Gradnja Ilić d.o.o.');
    });

    it('does not report a customer as created when the response says nothing about him', async () => {
      const service = configure(answering({ createCompany: () => Promise.resolve({}) }));

      const result = await service.createCustomer('Gradnja Ilić');

      expect(result.customer).toBeNull();
      // Never `refused`: the row may well exist, and telling the founder it failed invites a
      // second customer with the same name.
      expect(result.status).toBe('unavailable');
      expect(serverAnswered(result.status)).toBe(false);
    });
  });

  describe('createAdmin', () => {
    it('creates a company admin with his company, and says his invite was emailed', async () => {
      const service = configure();

      const result = await service.createAdmin({
        role: 'company_admin',
        displayName: '  Jovan Jovanović  ',
        email: '  Jovan@Firma.RS  ',
        companyId: MockPlatformGateway.VODOINSTAL_ID,
      });

      expect(result.status).toBe('ok');
      expect(result.person).toMatchObject({
        role: 'company_admin',
        displayName: 'Jovan Jovanović',
        email: 'jovan@firma.rs',
        companyId: MockPlatformGateway.VODOINSTAL_ID,
        companyName: 'Vodoinstal Petrović d.o.o.',
        passwordPending: true,
      });
      // **No token and no URL.** The link is minted on the server, inside the job that mails it,
      // and never reaches a response body — so there is nothing here to read down a phone, put on
      // a clipboard, or leak into a screenshot. What the screen gets is whether it went.
      expect(result.invite).toEqual({ email: null, emailed: true });
    });

    /**
     * **A super admin must not carry a company id.** `ck_app_user_company_scope` makes one
     * unstorable, so the server answers 400 rather than letting a CHECK produce a 500 — which
     * means a stale selection left behind by the other tab is a refusal nobody could account for.
     * The field is therefore absent, not empty.
     */
    it('sends no company at all for a member of staff', async () => {
      const sent: unknown[] = [];
      const service = configure(
        answering({
          createAdmin: (request) => {
            sent.push(request);
            return Promise.resolve({ user: { id: 'x', role: 'super_admin', display_name: 'X' } });
          },
        }),
      );

      await service.createAdmin({
        role: 'super_admin',
        displayName: 'Nova Kolegica',
        email: 'nova@teren.rs',
        companyId: null,
      });

      expect(sent).toEqual([
        { role: 'super_admin', display_name: 'Nova Kolegica', email: 'nova@teren.rs' },
      ]);
      expect(sent[0]).not.toHaveProperty('company_id');
    });

    it('omits an empty company rather than sending one', async () => {
      const sent: unknown[] = [];
      const service = configure(
        answering({
          createAdmin: (request) => {
            sent.push(request);
            return Promise.resolve({ user: { id: 'x', role: 'company_admin', display_name: 'X' } });
          },
        }),
      );

      await service.createAdmin({
        role: 'company_admin',
        displayName: 'Petar',
        email: 'petar@firma.rs',
        companyId: '',
      });

      expect(sent[0]).not.toHaveProperty('company_id');
    });

    /**
     * A 409 on create is the one refusal the founder can fix without leaving the form. Telling him
     * "the server refused it" would be true and useless; naming the address is the same fact with
     * the remedy attached.
     */
    it('names a taken address instead of calling it a plain refusal', async () => {
      const service = configure();

      const result = await service.createAdmin({
        role: 'super_admin',
        displayName: 'Neko Drugi',
        email: 'osnivac@teren.rs',
      });

      expect(result.status).toBe('emailTaken');
      expect(result.person).toBeNull();
      expect(result.invite).toBeNull();
    });

    it('leaves every other refusal a plain refusal', async () => {
      for (const status of [400, 404, 422]) {
        const service = configure(failingWith(httpError(status)));

        await expect(
          service.createAdmin({ role: 'company_admin', displayName: 'A', email: 'a@b.rs' }),
        ).resolves.toMatchObject({ status: 'refused' });
      }
    });

    /**
     * **`emailTaken` is a verdict about creating an account and about nothing else.** A 409
     * anywhere else on this surface — a customer, a suspend, a link, a withdrawal — is a conflict
     * whose meaning this build has not been told, and dressing it up as a taken address would send
     * the founder to change a field that was never involved.
     */
    it('never says emailTaken about any other call', async () => {
      const service = configure(failingWith(httpError(409, { code: 'email_taken' })));

      await expect(service.listCustomers()).resolves.toMatchObject({ status: 'refused' });
      await expect(service.createCustomer('Firma')).resolves.toMatchObject({ status: 'refused' });
      await expect(service.setSuspended('any', true)).resolves.toMatchObject({ status: 'refused' });
      await expect(service.setSuspended('any', false)).resolves.toMatchObject({ status: 'refused' });
      await expect(service.listPeople()).resolves.toMatchObject({ status: 'refused' });
      await expect(service.invite('any')).resolves.toMatchObject({ status: 'refused' });
      await expect(service.setDisabled('any', true)).resolves.toMatchObject({ status: 'refused' });
    });

    /**
     * The account exists — the server said 200 — and this build cannot read its link. Reporting a
     * failure would have the founder create the man a second time; `unavailable` is what makes the
     * screen say *reload* rather than *try again*.
     */
    it('refuses to call an unreadable success a failure the founder may retry', async () => {
      const service = configure(answering({ createAdmin: () => Promise.resolve({}) }));

      const result = await service.createAdmin({
        role: 'super_admin',
        displayName: 'Nova Kolegica',
        email: 'nova@teren.rs',
      });

      expect(result.person).toBeNull();
      expect(result.invite).toBeNull();
      expect(result.status).toBe('unavailable');
      expect(serverAnswered(result.status)).toBe(false);
    });

    /**
     * A link with no token is not a link: rendering one hands the founder something to read out
     * that cannot possibly work. And since the link **is** what this dialog exists to produce, an
     * account created without a readable one is unconfirmed rather than done — the recovery is a
     * reload and a fresh `invite`, not a second create that can only 409.
     */
    it('reports the whole create unconfirmed when the link came back tokenless', async () => {
      const service = configure(
        answering({
          createAdmin: () =>
            Promise.resolve({
              user: { id: 'x', role: 'super_admin', display_name: 'X' },
              invite: { purpose: 'invite', token: null, url: 'https://teren.example/set-password' },
            }),
        }),
      );

      const result = await service.createAdmin({
        role: 'super_admin',
        displayName: 'X',
        email: 'x@teren.rs',
      });

      expect(result.status).toBe('unavailable');
      expect(serverAnswered(result.status)).toBe(false);
      expect(result.invite).toBeNull();
      expect(result.person).toBeNull();
    });

    /**
     * A body that says an account was made but not whether the invite went.
     *
     * The screen must not fill that in. `emailed` is required rather than defaulted, so an answer
     * this build cannot read resolves to null and the dialog says "it could not be confirmed"
     * instead of "we emailed him" — which is the sentence that would leave a customer waiting for
     * a mail nobody sent.
     */
    it('will not assume an invite went out when the answer did not say', async () => {
      const service = configure(
        answering({
          createAdmin: () =>
            Promise.resolve({ user: { id: 'x', role: 'super_admin', display_name: 'X' } }),
        }),
      );

      const result = await service.createAdmin({
        role: 'super_admin',
        displayName: 'X',
        email: 'x@teren.rs',
      });

      expect(result.status).toBe('unavailable');
      expect(result.invite).toBeNull();
    });
  });

  // ---- The heavy actions ----------------------------------------------------------------------

  describe('setSuspended', () => {
    it('withdraws a customer and returns him stamped', async () => {
      const service = configure();

      const result = await service.setSuspended(MockPlatformGateway.VODOINSTAL_ID, true);

      expect(result.status).toBe('ok');
      expect(result.customer?.suspendedAt).not.toBeNull();
    });

    it('restores one, and the stamp is gone', async () => {
      const service = configure();

      const result = await service.setSuspended(MockPlatformGateway.ELEKTRO_ID, false);

      expect(result.status).toBe('ok');
      expect(result.customer?.suspendedAt).toBeNull();
    });

    it('answers a second suspend exactly as the first, so a double tap is harmless', async () => {
      const service = configure();

      const first = await service.setSuspended(MockPlatformGateway.VODOINSTAL_ID, true);
      const second = await service.setSuspended(MockPlatformGateway.VODOINSTAL_ID, true);

      expect(second.status).toBe('ok');
      expect(second.customer?.suspendedAt).toBe(first.customer?.suspendedAt);
    });

    it('reads an unknown customer as a refusal the server stands behind', async () => {
      const service = configure();

      await expect(service.setSuspended('no-such-company', true)).resolves.toEqual({
        status: 'refused',
        customer: null,
      });
    });
  });

  describe('invite', () => {
    it('emails a fresh link to an account that can hold a password', async () => {
      const service = configure();

      const result = await service.invite(MockPlatformGateway.PETAR_ID);

      expect(result.status).toBe('ok');
      expect(result.invite?.emailed).toBe(true);
      // The address, because it is the one thing that answers "why has he not had it?" — and the
      // founder already reads it in the directory, so echoing it discloses nothing new.
      expect(result.invite?.email).toBe('petar.petrovic@vodoinstal-petrovic.example.com');
    });

    /**
     * **Nothing on this screen may carry a credential**, which is the whole of the 2026-09-01
     * change. A future contract that put a token back in the body would sail through every other
     * assertion here, because they all read named fields; this one reads the shape.
     */
    it('has no field anywhere on it that could hold a token', async () => {
      const service = configure();

      const result = await service.invite(MockPlatformGateway.PETAR_ID);

      expect(Object.keys(result.invite ?? {}).sort()).toEqual(['email', 'emailed']);
      expect(JSON.stringify(result)).not.toContain('trn_p_');
    });

    /**
     * **This call supersedes a live link whether or not its answer could be read**, so a body this
     * build cannot parse is the one case where "it worked" is the dangerous sentence: the founder
     * presses again, retires a second link, and the one already sent to somebody stays dead.
     *
     * The flag is required rather than defaulted for exactly that reason — a missing `emailed`
     * treated as false would look identical on screen today and would hide a contract change
     * tomorrow.
     */
    it('says it could not be confirmed when the answer did not say whether it went', async () => {
      const service = configure(
        answering({ invite: () => Promise.resolve({ email: 'petar@firma.rs' }) }),
      );

      const result = await service.invite(MockPlatformGateway.PETAR_ID);

      expect(result).toEqual({ status: 'unavailable', invite: null });
      expect(serverAnswered(result.status)).toBe(false);
    });

    /** A foreman has no password by constraint, so there is nothing to link him to. */
    it('refuses a foreman rather than inventing a password path for him', async () => {
      const service = configure();

      await expect(service.invite(MockPlatformGateway.ZORAN_ID)).resolves.toEqual({
        status: 'refused',
        invite: null,
      });
    });
  });

  describe('setDisabled', () => {
    it('takes an account out of service with a stamp, never a delete', async () => {
      const service = configure();

      const result = await service.setDisabled(MockPlatformGateway.PETAR_ID, true);

      expect(result.status).toBe('ok');
      expect(result.person?.disabled).toBe(true);

      // The row survives: evidence stays nameable, which is why this is a stamp.
      const listed = await service.listPeople();
      expect(listed.people.map((person) => person.id)).toContain(MockPlatformGateway.PETAR_ID);
    });

    it('puts one back', async () => {
      const service = configure();

      await service.setDisabled(MockPlatformGateway.PETAR_ID, true);
      const result = await service.setDisabled(MockPlatformGateway.PETAR_ID, false);

      expect(result.person?.disabled).toBe(false);
    });
  });

  // ---- Every call, as one table ---------------------------------------------------------------

  /**
   * Every call the screens can make, so the properties below are asserted about all of them rather
   * than about whichever one somebody remembered.
   */
  const CALLS: [string, (service: PlatformService) => Promise<{ status: PlatformStatus }>][] = [
    ['listCustomers', (service) => service.listCustomers()],
    ['createCustomer', (service) => service.createCustomer('Gradnja Ilić')],
    ['suspend', (service) => service.setSuspended(MockPlatformGateway.VODOINSTAL_ID, true)],
    ['resume', (service) => service.setSuspended(MockPlatformGateway.ELEKTRO_ID, false)],
    ['listPeople', (service) => service.listPeople()],
    [
      'createAdmin',
      (service) =>
        service.createAdmin({ role: 'super_admin', displayName: 'X', email: 'x@teren.rs' }),
    ],
    ['invite', (service) => service.invite(MockPlatformGateway.PETAR_ID)],
    ['setDisabled', (service) => service.setDisabled(MockPlatformGateway.PETAR_ID, true)],
  ];

  /**
   * **Nothing is sent when this browser holds no admin credential.**
   *
   * Not politeness and not rate-limiter hygiene alone: a request that went out with `Bearer ` and
   * came back 401 would be read as `signedOut` and put "your session expired" in front of a man
   * who never had one. The only way to assert a request that was *not* made is to count the ones
   * that were.
   */
  describe('with nobody signed in', () => {
    it('answers notSignedIn from every call, and reaches the wire for none of them', async () => {
      for (const [name, call] of CALLS) {
        const watched = new WatchedGateway(new MockPlatformGateway());
        const service = configure(watched, false);

        const result = await call(service);

        expect(result.status, name).toBe('notSignedIn');
        expect(watched.calls, `${name} reached the wire with no credential`).toEqual([]);
      }
    });

    it('hands back an empty answer of the right shape, never a half-filled one', async () => {
      const service = configure(gateway, false);

      await expect(service.listCustomers()).resolves.toEqual({
        status: 'notSignedIn',
        customers: [],
        nextCursor: null,
      });
      await expect(service.listPeople()).resolves.toEqual({
        status: 'notSignedIn',
        people: [],
        nextCursor: null,
      });
      await expect(service.createCustomer('Firma')).resolves.toEqual({
        status: 'notSignedIn',
        customer: null,
      });
      await expect(service.setSuspended('any', true)).resolves.toEqual({
        status: 'notSignedIn',
        customer: null,
      });
      await expect(
        service.createAdmin({ role: 'super_admin', displayName: 'X', email: 'x@teren.rs' }),
      ).resolves.toEqual({ status: 'notSignedIn', person: null, invite: null });
      await expect(service.invite('any')).resolves.toEqual({
        status: 'notSignedIn',
        invite: null,
      });
      await expect(service.setDisabled('any', true)).resolves.toEqual({
        status: 'notSignedIn',
        person: null,
      });
    });

    /** An expired credential is no credential: the token would be refused, so it is not sent. */
    it('treats an expired session as no session', async () => {
      const watched = new WatchedGateway(new MockPlatformGateway());
      localStorage.clear();
      localStorage.setItem(
        ADMIN_SESSION_STORAGE_KEY,
        JSON.stringify({ ...STAFF, expiresAt: '2020-01-01T00:00:00.000Z' }),
      );
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: PLATFORM_GATEWAY, useValue: watched }],
      });
      const service = TestBed.inject(PlatformService);

      await expect(service.listPeople()).resolves.toMatchObject({ status: 'notSignedIn' });
      expect(watched.calls).toEqual([]);
    });
  });

  /**
   * The classification table.
   *
   * Each row is a sentence the founder reads while deciding whether to press a button that stops a
   * contractor's phones. **401 and 403 are kept apart**: signing in again fixes one and can never
   * fix the other, and offering the wrong remedy is a screen lying about what it knows.
   */
  describe('classification', () => {
    const cases: [unknown, PlatformStatus][] = [
      [httpError(0), 'offline'],
      [{ name: 'TimeoutError' }, 'offline'],
      [httpError(401), 'signedOut'],
      [httpError(403), 'forbidden'],
      [httpError(400), 'refused'],
      [httpError(404), 'refused'],
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

    /**
     * ## A 401 has to *end* the session, not merely describe it
     *
     * The twin of the company surface's rule, and the same defect until 2026-09-02: the server
     * refused the credential, the screen said "sign in again", and `localStorage` still held the
     * dead row — so `requiresNoAdminSession` read a signed-in super admin and bounced him off
     * `/login` back to the screen full of 401s. **The remedy the copy names was the one door the
     * app kept shut.**
     *
     * Every route, because the platform screens load several at once — and asserted on the stored
     * row, which is also what pins that exactly one `localStorage` entry goes and nothing else.
     */
    for (const [name, call] of CALLS) {
      it(`signs the founder out of this browser when ${name} is refused`, async () => {
        const service = configure(failingWith(httpError(401)));
        const admins = TestBed.inject(AdminSessionService);
        expect(admins.signedIn()).toBe(true);

        await expect(call(service)).resolves.toMatchObject({ status: 'signedOut' });

        expect(admins.signedIn()).toBe(false);
        expect(localStorage.getItem(ADMIN_SESSION_STORAGE_KEY)).toBeNull();
      });
    }

    /**
     * A 403 signs nobody out. It says the role may not do this; signing in again changes nothing,
     * and throwing the credential away would turn a wrong screen into a lost session.
     */
    it('keeps the credential through a 403, a 500 and a network failure', async () => {
      for (const error of [httpError(403), httpError(500), httpError(0)]) {
        const service = configure(failingWith(error));

        await service.listPeople();

        expect(TestBed.inject(AdminSessionService).signedIn(), describeError(error)).toBe(true);
      }
    });

    /** A 409 is `refused` everywhere except create, where it has a remedy attached. */
    it('reads a 409 as refused everywhere but create', async () => {
      for (const [name, call] of CALLS) {
        const service = configure(failingWith(httpError(409)));
        await expect(call(service), name).resolves.toMatchObject({
          status: name === 'createAdmin' ? 'emailTaken' : 'refused',
        });
      }
    });

    /**
     * A build with no API address never reached the network, so the honest answer is the one that
     * sends the founder to sign in rather than one that blames a server nobody called.
     */
    it('reads an unconfigured build as notSignedIn', async () => {
      const service = configure(
        failingWith(new UploadFailure('not_configured', 'no api base url configured')),
      );

      await expect(service.listPeople()).resolves.toMatchObject({ status: 'notSignedIn' });
    });
  });

  /**
   * **No method throws, ever.**
   *
   * A rejected promise reaching the component would leave the founder looking at a spinner with no
   * sentence under it. Asserted against a gateway that rejects *and* one that throws before it
   * returns at all, because only the second can catch a `.then()` chain sitting outside its `try`.
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
          expect(PLATFORM_STATUSES).toContain(answer.status);
          expect(answer.status).not.toBe('ok');
        });

        it(`${name} answers rather than rejecting when ${description} is thrown outright`, async () => {
          const throwing = configure(throwingSynchronouslyWith(error));
          const answer = await call(throwing);
          expect(PLATFORM_STATUSES).toContain(answer.status);
          expect(answer.status).not.toBe('ok');
        });
      }
    }
  });

  /**
   * The difference between "it did not work" and "we do not know whether it worked".
   *
   * Sharper here than anywhere else in the app: **inviting supersedes a live link**, and suspending
   * stops every phone in a company. A founder told "failed" after a request that in fact succeeded
   * will press again — and the second press retires a link already on its way to somebody.
   */
  describe('serverAnswered', () => {
    it('is true only where the server actually looked at the request', () => {
      expect(serverAnswered('ok')).toBe(true);
      expect(serverAnswered('signedOut')).toBe(true);
      expect(serverAnswered('forbidden')).toBe(true);
      expect(serverAnswered('refused')).toBe(true);
      // The server read the address, found an account on it, and said so. There is nothing to
      // reload — the remedy is in the form.
      expect(serverAnswered('emailTaken')).toBe(true);

      expect(serverAnswered('offline')).toBe(false);
      expect(serverAnswered('unavailable')).toBe(false);
      expect(serverAnswered('notSignedIn')).toBe(false);
    });

    it('has an answer for every status the service can produce', () => {
      for (const status of PLATFORM_STATUSES) {
        expect(typeof serverAnswered(status)).toBe('boolean');
      }
      expect(PLATFORM_STATUSES).toHaveLength(8);
    });
  });
});

/**
 * Every call that reached the gateway, in order.
 *
 * A list of names rather than a `vi.fn()` per method, so the assertion reads as the property it is:
 * *nothing at all was sent*.
 */
class WatchedGateway implements PlatformGateway {
  readonly calls: string[] = [];

  constructor(private readonly inner: PlatformGateway) {}

  listCompanies(query?: Parameters<PlatformGateway['listCompanies']>[0]) {
    this.calls.push('listCompanies');
    return this.inner.listCompanies(query);
  }

  createCompany(request: Parameters<PlatformGateway['createCompany']>[0]) {
    this.calls.push('createCompany');
    return this.inner.createCompany(request);
  }

  suspendCompany(companyId: string) {
    this.calls.push('suspendCompany');
    return this.inner.suspendCompany(companyId);
  }

  resumeCompany(companyId: string) {
    this.calls.push('resumeCompany');
    return this.inner.resumeCompany(companyId);
  }

  listUsers(query?: Parameters<PlatformGateway['listUsers']>[0]) {
    this.calls.push('listUsers');
    return this.inner.listUsers(query);
  }

  createAdmin(request: Parameters<PlatformGateway['createAdmin']>[0]) {
    this.calls.push('createAdmin');
    return this.inner.createAdmin(request);
  }

  invite(userId: string) {
    this.calls.push('invite');
    return this.inner.invite(userId);
  }

  disableUser(userId: string) {
    this.calls.push('disableUser');
    return this.inner.disableUser(userId);
  }

  enableUser(userId: string) {
    this.calls.push('enableUser');
    return this.inner.enableUser(userId);
  }

  listLogs(query?: Parameters<PlatformGateway['listLogs']>[0]) {
    this.calls.push('listLogs');
    return this.inner.listLogs(query);
  }

  exportLogs(query?: Parameters<PlatformGateway['exportLogs']>[0]) {
    this.calls.push('exportLogs');
    return this.inner.exportLogs(query);
  }
}

function describeError(error: unknown): string {
  return error instanceof HttpErrorResponse ? `status ${error.status}` : String(error);
}
