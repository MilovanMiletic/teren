import { ACTION_VOCABULARY } from './actions';
import {
  ACTION_PATTERN,
  MAX_DETAIL_KEYS,
  buildEvent,
  isAction,
  safeRoute,
  scrubDetail,
} from './client-event';

/** The vocabulary the contract publishes, so the shapes below are checked against real slugs. */
const VOCABULARY = [
  'nav.route.enter',
  'capture.record.start',
  'capture.record.stop',
  'capture.record.discard',
  'capture.photo.add',
  'capture.send',
  'confirm.open',
  'confirm.edit',
  'confirm.send',
  'confirm.verbatim',
  'archive.open',
  'archive.entry.open',
  'archive.media.open',
  'archive.report.download',
  // 2026-09-03: the correction gesture. The one press that answers PROJECT.md invariant 2 — a
  // record that cannot change, corrected by recording a new day that names it.
  'archive.correction.start',
  'company.worker.open',
  'company.worker.add',
  'company.code.issue',
  'company.code.reveal',
  'platform.company.open',
  'platform.user.open',
  'platform.invite.send',
  'platform.user.disable',
  'logs.open',
  'logs.filter',
  'logs.export',
  // 2026-09-03: the estate's health screen was opened (F7). One slug for the screen and none for
  // its controls, like the log viewer: there is exactly one thing to do on it, which is read it.
  'health.open',
  'session.login',
  'session.logout',
  'session.activate',
  'app.start',
  'app.offline',
  'app.online',
  'app.error',
  // 2026-09-03: the server refused this phone's credential and the phone signed itself out. The
  // only event in the vocabulary that nobody pressed.
  'session.device.refused',
];

describe('the client-event contract, applied on the phone', () => {
  describe('actions', () => {
    it('accepts every slug in the published vocabulary', () => {
      for (const action of VOCABULARY) {
        expect(isAction(action), action).toBe(true);
      }
    });

    /**
     * The shipped map against the contract, transcribed by hand above.
     *
     * Two copies on purpose: the map is what the screens reference, and this list is what §4 of the
     * wire contract says. A slug quietly added, renamed or dropped in `actions.ts` is a log line
     * the server will refuse or a founder will never find, and it fails here rather than in
     * production.
     */
    it('is exactly the vocabulary the shipped map holds', () => {
      expect([...ACTION_VOCABULARY].sort()).toEqual([...VOCABULARY].sort());
    });

    it('accepts the structural descriptors the click listener produces', () => {
      for (const action of ['ui.click', 'ui.button.btn-icon', 'ui.app-column-menu.button.more']) {
        expect(isAction(action), action).toBe(true);
      }
    });

    /**
     * The clause the whole feature rests on: **a slug cannot carry a transcript.**
     *
     * Every rejection below is a shape that could hold something a person said or read — a space,
     * a capital, a diacritic, a colon, a slash. The server refuses them too; refusing them here as
     * well is what stops a batch being retried for ever because one row in it is malformed.
     */
    it('refuses anything a sentence would fit into', () => {
      const refused = [
        'Zamenjena je slavina u kupatilu',
        'capture.record.Stop',
        'capture record stop',
        'capture.zamena-česme',
        'capture',
        'a.b.c.d.e.f',
        '.leading.dot',
        'trailing.dot.',
        '1capture.start',
        `${'a'.repeat(90)}.b`,
      ];
      for (const action of refused) {
        expect(isAction(action), action).toBe(false);
      }
    });

    it('has a pattern that is the contract character for character', () => {
      expect(ACTION_PATTERN.source).toBe('^[a-z][a-z0-9]*(\\.[a-z0-9-]+){1,4}$');
    });
  });

  describe('routes', () => {
    it('keeps a path, ids and all', () => {
      expect(safeRoute('/entry/8f0d3a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f')).toBe(
        '/entry/8f0d3a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f',
      );
      expect(safeRoute('/')).toBe('/');
    });

    /**
     * **The archive opens a record as `?entry=<id>` and the auth screens carry `?next=`.**
     *
     * A query string is where a search term lives, and a search term is what somebody typed. It is
     * cut off rather than encoded, so there is no path by which a filter box's contents reaches a
     * log table.
     */
    it('cuts the query string and the fragment off', () => {
      expect(safeRoute('/diary?entry=abc')).toBe('/diary');
      expect(safeRoute('/login?next=%2Fcompany')).toBe('/login');
      expect(safeRoute('/diary#photo-3')).toBe('/diary');
    });

    it('refuses a path this app cannot express safely rather than substituting one', () => {
      // Serbian in a path is not something this route table produces, and a log line that claimed
      // the press happened on `/` would be filing it under the wrong screen.
      expect(safeRoute('/dnevnik/čvor')).toBeNull();
      expect(safeRoute('')).toBeNull();
      expect(safeRoute(null)).toBeNull();
      expect(safeRoute(`/${'x'.repeat(200)}`)).toBeNull();
    });
  });

  describe('detail', () => {
    it('keeps numbers, booleans and slugs', () => {
      expect(scrubDetail({ chunks: 31, ok: true, cause: 'log-buffer-full' })).toEqual({
        chunks: 31,
        ok: true,
        cause: 'log-buffer-full',
      });
    });

    /**
     * The one rule that makes free text structurally impossible in a detail value.
     *
     * A slug has no spaces, so an address, a project name or a sentence cannot be one — and an
     * object or an array cannot smuggle one either, because only three value types survive at all.
     */
    it('drops a value that is not a number, a boolean or a slug', () => {
      const scrubbed = scrubDetail({
        note: 'Zamenjena slavina u kupatilu',
        site: 'Vojvode Stepe 212',
        nested: { transcript: 'anything' },
        many: [1, 2, 3],
        kept: 4,
      });
      expect(scrubbed).toEqual({ kept: 4 });
    });

    it('drops a key the server would refuse, and keeps the event', () => {
      expect(scrubDetail({ Bad: 1, 'also-bad': 2, good_one: 3 })).toEqual({ good_one: 3 });
    });

    it('stops at the tenth key', () => {
      const wide: Record<string, number> = {};
      for (let index = 0; index < 20; index += 1) {
        wide[`k${index}`] = index;
      }
      expect(Object.keys(scrubDetail(wide) ?? {})).toHaveLength(MAX_DETAIL_KEYS);
    });

    it('says nothing rather than sending an empty map', () => {
      expect(scrubDetail({})).toBeUndefined();
      expect(scrubDetail({ note: 'a sentence with spaces' })).toBeUndefined();
      expect(scrubDetail(null)).toBeUndefined();
    });
  });

  describe('composing an event', () => {
    const AT = '2026-09-02T18:12:03.221Z';
    const ENTRY = '8f0d3a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f';

    it('mints a device-side id, exactly as an entry does', () => {
      const event = buildEvent('capture.send', '/record', AT);
      expect(event?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('carries the facts the server files a row under', () => {
      const event = buildEvent('capture.record.stop', '/record', AT, {
        outcome: 'ok',
        durationMs: 31_200,
        entryId: ENTRY,
        detail: { chunks: 31 },
      });
      expect(event).toMatchObject({
        at: AT,
        action: 'capture.record.stop',
        route: '/record',
        outcome: 'ok',
        duration_ms: 31_200,
        entry_id: ENTRY,
        detail: { chunks: 31 },
      });
    });

    it('refuses to compose an event whose action or route the server would reject whole', () => {
      expect(buildEvent('Zamenjena slavina', '/record', AT)).toBeNull();
      expect(buildEvent('capture.send', '/dnevnik/čvor', AT)).toBeNull();
    });

    /**
     * A stopwatch that read longer than an hour still says something true about how long a man
     * waited; an event the server refuses whole says nothing at all. Clamped, not dropped.
     */
    it('clamps a duration into range rather than losing the event', () => {
      expect(buildEvent('capture.send', '/record', AT, { durationMs: 9e9 })?.duration_ms).toBe(
        3_600_000,
      );
      expect(buildEvent('capture.send', '/record', AT, { durationMs: -5 })?.duration_ms).toBe(0);
      expect(buildEvent('capture.send', '/record', AT, { durationMs: NaN })).not.toHaveProperty(
        'duration_ms',
      );
    });

    it('drops an id that is not a UUID rather than sending it', () => {
      const event = buildEvent('capture.send', '/record', AT, { entryId: 'zoran.jovanovic' });
      expect(event).not.toHaveProperty('entry_id');
    });
  });
});
