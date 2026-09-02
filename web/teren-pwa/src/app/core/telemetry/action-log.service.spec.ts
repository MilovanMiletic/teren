import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ADMIN_SESSION_STORAGE_KEY, AdminSession } from '../session/admin-session';
import { SESSION_STORAGE_KEY, Session } from '../session/session';
import { TEREN_DB, TerenDb } from '../db/teren-db';
import { ClientEvent, ClientEventReceipt } from './client-event';
import { CLIENT_EVENT_GATEWAY, ClientEventGateway } from './client-event-gateway';
import { ActionLogService, MAX_BUFFERED_EVENTS } from './action-log.service';

const DEVICE: Session = {
  token: 'trn_d_a-real-device-token',
  deviceId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  username: 'zoran.jovanovic',
  displayName: 'Zoran Jovanović',
  companyId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Vodoinstal Petrović d.o.o.',
  activatedAt: '2026-08-30T08:00:00.000Z',
};

const STAFF: AdminSession = {
  token: 'trn_s_a-real-staff-session',
  expiresAt: '2099-01-01T00:00:00.000Z',
  role: 'super_admin',
  userId: '44444444-4444-4444-4444-444444444444',
  displayName: 'Milovan Miletić',
  companyId: null,
  companyName: null,
  signedInAt: '2026-09-01T08:00:00.000Z',
};

/** One sent batch, with the credential it went under — which is half of what is under test. */
interface SentBatch {
  bearer: string;
  events: ClientEvent[];
}

class StubGateway implements ClientEventGateway {
  readonly sent: SentBatch[] = [];
  error: unknown = null;

  async send(bearer: string, events: readonly ClientEvent[]): Promise<ClientEventReceipt> {
    if (this.error) {
      throw this.error;
    }
    this.sent.push({ bearer, events: [...events] });
    return { accepted: events.length, rejected: 0 };
  }
}

function http(status: number): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'x', error: { detail: 'no' } });
}

describe('ActionLogService', () => {
  let db: TerenDb;
  let gateway: StubGateway;
  let service: ActionLogService;

  /**
   * Boot the service against a throwaway database and a stubbed endpoint.
   *
   * The real `SessionService` and `AdminSessionService`, seeded through `localStorage`: **which
   * bearer a batch goes under** is the decision this file exists to pin, and a stubbed session
   * service would let the spec agree with itself about it.
   */
  function boot(device: Session | null = DEVICE, admin: AdminSession | null = null): void {
    localStorage.clear();
    if (device) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(device));
    }
    if (admin) {
      localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(admin));
    }

    db = new TerenDb(`teren-test-${crypto.randomUUID()}`);
    gateway = new StubGateway();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: TEREN_DB, useValue: db },
        { provide: CLIENT_EVENT_GATEWAY, useValue: gateway },
      ],
    });
    service = TestBed.inject(ActionLogService);
  }

  /**
   * Drain the promise chain every `record()` hands its write to, **without provoking a flush**.
   *
   * `service.settled()` awaits the chain's current tail, which after a burst of synchronous
   * `record()` calls is all of them. The macrotask turn afterwards lets any work those writes
   * themselves scheduled land. Counting fixed turns instead was the first cut of this helper and
   * it was flaky at six hundred rows — a spec that is a race is worse than no spec.
   */
  async function settle(): Promise<void> {
    await service.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.settled();
  }

  async function buffered(): Promise<ClientEvent[]> {
    const rows = await db.clientEvents.orderBy(':id').toArray();
    return rows.map((row) => row.event as ClientEvent);
  }

  beforeEach(() => boot());

  afterEach(async () => {
    TestBed.resetTestingModule();
    document.body.innerHTML = '';
    db.close();
    await db.delete();
    localStorage.clear();
  });

  // ---- The phone first -------------------------------------------------------------------------

  describe('the buffer', () => {
    /**
     * The house rule, applied to the one table that is not evidence: it lands on disk before
     * anything is attempted. An in-memory array would lose exactly the presses around a crash,
     * which are the presses a log exists to explain.
     */
    it('writes to disk before it makes any network attempt', async () => {
      service.record('capture.send');
      await settle();

      expect(await db.clientEvents.count()).toBe(1);
      expect(gateway.sent).toHaveLength(0);
    });

    it('keeps the rows until the server has answered for them', async () => {
      service.record('capture.send');
      await settle();

      gateway.error = http(503);
      await service.flush();
      expect(await db.clientEvents.count()).toBe(1);

      gateway.error = null;
      await service.flush();
      expect(await db.clientEvents.count()).toBe(0);
      expect(gateway.sent[0].events[0].action).toBe('capture.send');
    });

    /**
     * **The one way telemetry could cost a foreman his work.**
     *
     * An unbounded buffer eventually claims the storage quota a day's photographs need. So it is
     * capped, it drops its *oldest* rows — this morning's press is the one somebody is asking
     * about, not last week's — and it counts what it lost.
     */
    it('is bounded, drops the oldest and counts the hole', async () => {
      gateway.error = http(503);

      for (let index = 0; index < MAX_BUFFERED_EVENTS + 100; index += 1) {
        service.record('capture.send');
      }
      await settle();

      expect(await db.clientEvents.count()).toBe(MAX_BUFFERED_EVENTS);
      expect(service.dropped()).toBe(100);
    });

    it('says out loud that the log has a hole in it, once, then forgets', async () => {
      gateway.error = http(503);
      for (let index = 0; index < MAX_BUFFERED_EVENTS + 3; index += 1) {
        service.record('capture.send');
      }
      await settle();

      gateway.error = null;
      await service.flush();

      const first = gateway.sent[0].events[0];
      expect(first.action).toBe('app.error');
      expect(first.outcome).toBe('fail');
      expect(first.detail).toEqual({ dropped: 3, cause: 'log-buffer-full' });
      expect(service.dropped()).toBe(0);

      // …and the notice does not repeat itself on the next batch.
      await service.flush();
      const actions = gateway.sent.flatMap((batch) => batch.events.map((event) => event.action));
      expect(actions.filter((action) => action === 'app.error')).toHaveLength(1);
    });

    /**
     * **A hole is forgotten when it has been reported, not when it has been mentioned.**
     *
     * The counter used to be zeroed as the notice was composed — before the request. A week
     * offline, two hundred presses dropped, one flaky first flush, and the notice went down with
     * the batch while the counter said there was nothing left to say: the log then had a hole in
     * it that nothing would ever mention again, which is the exact failure this notice exists to
     * prevent.
     */
    it('keeps the hole to report when the flush that would have reported it fails', async () => {
      gateway.error = http(503);
      for (let index = 0; index < MAX_BUFFERED_EVENTS + 3; index += 1) {
        service.record('capture.send');
      }
      await settle();
      expect(service.dropped()).toBe(3);

      // The flush that carried the notice never reached the server.
      await service.flush();
      expect(gateway.sent).toHaveLength(0);
      expect(service.dropped()).toBe(3);

      gateway.error = null;
      await service.flush();

      const first = gateway.sent[0].events[0];
      expect(first.action).toBe('app.error');
      expect(first.detail).toEqual({ dropped: 3, cause: 'log-buffer-full' });
      expect(service.dropped()).toBe(0);
    });

    it('never sends more than the hundred events the server takes', async () => {
      for (let index = 0; index < 250; index += 1) {
        service.record('capture.send');
      }
      await settle();

      await service.flush();
      for (const batch of gateway.sent) {
        expect(batch.events.length).toBeLessThanOrEqual(100);
      }
    });
  });

  // ---- What it must never break ---------------------------------------------------------------

  describe('what it may never do', () => {
    /**
     * A logger that can break the record button is worse than no logger, and it would break it
     * silently on one device class. Every entry point is wrapped; here the *store itself* is made
     * hostile, which is the failure a private-mode browser really produces.
     */
    it('does not throw when the store refuses every write', async () => {
      vi.spyOn(db.clientEvents, 'add').mockRejectedValue(new Error('QuotaExceededError'));

      expect(() => service.record('capture.send')).not.toThrow();
      await expect(service.flush()).resolves.toBeUndefined();
      await settle();
    });

    it('does not throw when the endpoint answers with anything at all', async () => {
      service.record('capture.send');
      await settle();

      for (const status of [0, 401, 404, 500, 503]) {
        gateway.error = http(status);
        await expect(service.flush()).resolves.toBeUndefined();
      }
    });

    /**
     * **The upload queue comes first, always.**
     *
     * A day of evidence and a list of button presses must never contend for the same site
     * connection. Proven on the destructive side as well as the read side: with an entry in
     * flight, nothing is sent *and* nothing in the buffer is deleted.
     */
    it('sends nothing while an entry is in flight', async () => {
      await db.outbox.put({
        entryId: crypto.randomUUID(),
        state: 'in_flight',
        seq: 1,
        attempts: 1,
        lastAttemptAt: new Date().toISOString(),
        nextAttemptAt: null,
        lastError: null,
        failureKind: null,
        createdAt: new Date().toISOString(),
      });

      service.record('capture.send');
      await settle();
      await service.flush();

      expect(gateway.sent).toHaveLength(0);
      expect(await db.clientEvents.count()).toBe(1);
    });

    it('sends nothing when the platform says there is no network', async () => {
      // `onLine` lives on `Navigator.prototype`, not on the instance, so there is no own
      // descriptor to put back — and restoring `undefined` leaves the whole file offline. That
      // cost six red specs in files that had nothing to do with the network.
      const own = Object.getOwnPropertyDescriptor(navigator, 'onLine');
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      try {
        service.record('capture.send');
        await settle();
        await service.flush();

        expect(gateway.sent).toHaveLength(0);
        expect(await db.clientEvents.count()).toBe(1);
      } finally {
        if (own) {
          Object.defineProperty(navigator, 'onLine', own);
        } else {
          delete (navigator as unknown as Record<string, unknown>)['onLine'];
        }
        expect(navigator.onLine).toBe(true);
      }
    });

    /**
     * The route does not exist in every deployment — the backend increment ships separately — and
     * a phone that met a 404 every thirty seconds for ever would be a phone spending a foreman's
     * data on a question the server has already answered.
     */
    it('goes quiet for the session when the deployment has no such route', async () => {
      service.record('capture.send');
      await settle();

      gateway.error = http(404);
      await service.flush();

      expect(service.enabled()).toBe(false);
      await settle();
      expect(await db.clientEvents.count()).toBe(0);

      gateway.error = null;
      service.record('capture.send');
      await settle();
      await service.flush();
      expect(gateway.sent).toHaveLength(0);
      expect(await db.clientEvents.count()).toBe(0);
    });

    it('drops a batch its credential is refused for rather than hammering the door', async () => {
      service.record('capture.send');
      await settle();

      gateway.error = http(401);
      await service.flush();
      await settle();

      expect(await db.clientEvents.count()).toBe(0);
      // …and it is still recording. A refused credential is about a batch, not about the app.
      expect(service.enabled()).toBe(true);
    });
  });

  // ---- Which credential -----------------------------------------------------------------------

  describe('which credential a batch goes under', () => {
    it('sends a foreman’s action with the device token', async () => {
      service.record('capture.send', {}, '/record');
      await settle();
      await service.flush();

      expect(gateway.sent[0].bearer).toBe(DEVICE.token);
    });

    /**
     * The trap `/company/profile` fell into, at scale.
     *
     * The founder's browser holds a device session and an admin session at once. A logger that
     * picked "whichever token exists" would file Teren's own activity inside a customer's company
     * — or, the other way round, a foreman's day under an account that **has no company by
     * construction**, so the row would lose its tenant scope entirely.
     */
    it('sends a staff action with the admin session, on a browser that holds both', async () => {
      boot(DEVICE, STAFF);

      service.record('logs.open', {}, '/platform');
      await settle();
      await service.flush();

      expect(gateway.sent[0].bearer).toBe(STAFF.token);
    });

    it('never mixes two men’s credentials in one batch', async () => {
      boot(DEVICE, STAFF);

      service.record('capture.send', {}, '/record');
      service.record('logs.open', {}, '/platform');
      service.record('capture.send', {}, '/record');
      await settle();

      await service.flush();
      await service.flush();
      await service.flush();

      expect(gateway.sent.length).toBeGreaterThan(1);
      for (const batch of gateway.sent) {
        expect(batch.events.length).toBeGreaterThan(0);
      }
      expect(gateway.sent[0].bearer).toBe(DEVICE.token);
      expect(gateway.sent[1].bearer).toBe(STAFF.token);
    });

    it('records nothing at all when this browser holds no credential', async () => {
      boot(null, null);

      service.record('session.login', {}, '/login');
      await settle();

      expect(await db.clientEvents.count()).toBe(0);
    });

    it('throws away rows whose credential has gone, rather than blocking the queue', async () => {
      boot(null, STAFF);
      service.record('logs.open', {}, '/platform');
      await settle();

      // He signed out between the press and the flush.
      localStorage.clear();
      boot(null, null);
      await db.clientEvents.add({
        surface: 'admin',
        event: {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          action: 'logs.open',
          route: '/platform',
        },
      });

      await service.flush();

      expect(gateway.sent).toHaveLength(0);
      expect(await db.clientEvents.count()).toBe(0);
    });
  });

  // ---- The click listener ----------------------------------------------------------------------

  describe('the click listener', () => {
    function press(html: string): HTMLElement {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.appendChild(host);
      const control = host.querySelector('button') as HTMLButtonElement;
      control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return host;
    }

    it('records a declared slug for a control that names itself', async () => {
      service.start();
      press('<button data-log="capture.record.start">Snimi</button>');
      await settle();

      const actions = (await buffered()).map((event) => event.action);
      expect(actions).toContain('capture.record.start');
    });

    /**
     * The privacy boundary, seen end to end rather than only in the pure function.
     *
     * The label on this button is what `/platform`'s directory really renders — "Open {{name}}" —
     * and the text is a customer's address. Neither may appear in anything this service writes.
     */
    it('writes nothing a person typed or read', async () => {
      service.start();
      press(
        '<app-header><button class="btn-icon" aria-label="Open Petar Petrović"' +
          ' title="Vojvode Stepe 212">Vojvode Stepe 212</button></app-header>',
      );
      await settle();

      const written = JSON.stringify(await buffered()).toLowerCase();
      for (const secret of ['petar', 'petrovi', 'vojvode', 'stepe', '212']) {
        expect(written, secret).not.toContain(secret);
      }
      expect(written).toContain('ui.app-header.button.btn-icon');
    });

    /**
     * **It never blocks a click.** The listener is capture-phase, so it runs before the app's own
     * handler; a throw or a refusal there must leave the press behaving exactly as it would with
     * no logger installed.
     */
    it('leaves the press itself untouched, even when the store is broken', async () => {
      vi.spyOn(db.clientEvents, 'add').mockRejectedValue(new Error('QuotaExceededError'));
      service.start();

      const handler = vi.fn();
      const host = document.createElement('div');
      host.innerHTML = '<button data-log="capture.send">x</button>';
      document.body.appendChild(host);
      const control = host.querySelector('button') as HTMLButtonElement;
      control.addEventListener('click', handler);

      const delivered = control.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(delivered).toBe(true);
      await settle();
    });

    it('says nothing about a tap that was not on a control', async () => {
      service.start();
      await settle();
      const before = await db.clientEvents.count();

      const paragraph = document.createElement('p');
      paragraph.textContent = 'Vojvode Stepe 212';
      document.body.appendChild(paragraph);
      paragraph.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();

      expect(await db.clientEvents.count()).toBe(before);
    });

    it('starts only once, however often it is asked', async () => {
      service.start();
      service.start();
      press('<button data-log="capture.send">x</button>');
      await settle();

      const actions = (await buffered()).map((event) => event.action);
      expect(actions.filter((action) => action === 'capture.send')).toHaveLength(1);
    });
  });
});
