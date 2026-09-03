import { SiteHealth } from '../../core/platform/platform.service';
import {
  SITE_CHIP_KEYS,
  SITE_DEFAULT_DIRECTION,
  SITE_INITIAL_SORT,
  attentionScore,
  siteChips,
  sortSites,
} from './health-sites';

function site(overrides: Partial<SiteHealth> = {}): SiteHealth {
  return {
    companyId: 'c-1',
    companyName: 'Vodoinstal Petrović d.o.o.',
    projectId: 'p-1',
    projectName: 'Gradilište',
    pipeline: {
      entryCount: 4,
      received: 0,
      processing: 0,
      awaitingConfirmation: 0,
      needsReview: 0,
      confirmed: 0,
      reported: 4,
    },
    pipelineFailures: [],
    delivery: { reportCount: 4, sending: 0, sent: 4, failed: 0 },
    deliveryFailures: [],
    ...overrides,
  };
}

describe('attentionScore', () => {
  /**
   * A deliberate mirror of the server's own `NeedsAttention`, and the same three terms: days handed
   * back to a person, entries carrying a failure, and reports that did not go out.
   */
  it('counts the three things that need somebody', () => {
    expect(
      attentionScore(
        site({
          pipeline: { ...site().pipeline, needsReview: 2 },
          pipelineFailures: [
            { reason: 'extraction_failed', count: 3 },
            { reason: 'render_failed', count: 1 },
          ],
          delivery: { reportCount: 4, sending: 0, sent: 2, failed: 2 },
        }),
      ),
    ).toBe(8);
  });

  /**
   * **`deliveryFailures` is deliberately not a term**, for the reason the server gives: a `failed`
   * report row always carries a reason, so summing both would count one problem twice for no extra
   * signal.
   */
  it('does not add the delivery reasons on top of the failed reports', () => {
    const scored = site({
      delivery: { reportCount: 4, sending: 0, sent: 3, failed: 1 },
      deliveryFailures: [{ reason: 'delivery_failed', count: 1 }],
    });

    expect(attentionScore(scored)).toBe(1);
  });

  /** A healthy site scores nothing, which is the only property the ordering actually needs. */
  it('scores a site with nothing wrong at zero', () => {
    expect(attentionScore(site())).toBe(0);
  });
});

describe('sortSites', () => {
  /**
   * **Ascending on the state column means worst first, and the direction is not a free choice.**
   *
   * `ui/column-menu.ts` names both directions in words, and for `kind="state"` those words are
   * fixed: `table.sort.state.asc` reads *"Prvo ono što traži pažnju"*. `/platform` is built on the
   * same convention — `platform-people.ts` ranks the urgent state at 0 so ascending means *who
   * needs you*. The first cut of this file had `desc` mean attention-first, which would have put a
   * control on screen naming the opposite of what it does.
   */
  it('puts the worst site first when the state column is ascending', () => {
    const calm = site({ projectId: 'calm', projectName: 'Mirno' });
    const busy = site({
      projectId: 'busy',
      projectName: 'Vruće',
      pipeline: { ...site().pipeline, needsReview: 5 },
    });

    expect(
      sortSites([calm, busy], { key: 'state', direction: 'asc' }).map((s) => s.projectId),
    ).toEqual(['busy', 'calm']);

    expect(
      sortSites([calm, busy], { key: 'state', direction: 'desc' }).map((s) => s.projectId),
    ).toEqual(['calm', 'busy']);
  });

  /** …and that is the order the screen opens on, so the first paint is the server's own answer. */
  it('opens on the state column, attention first', () => {
    expect(SITE_INITIAL_SORT).toEqual({ key: 'state', direction: 'asc' });
    expect(SITE_DEFAULT_DIRECTION.state).toBe('asc');
  });

  /** A name wants A→Ž on a first tap; a count of days wants the busiest site. */
  it('gives every column its useful first direction', () => {
    expect(SITE_DEFAULT_DIRECTION).toEqual({
      company: 'asc',
      site: 'asc',
      days: 'desc',
      state: 'asc',
    });
  });

  /**
   * Serbian Latin collation, explicitly.
   *
   * `Č`, `Ć`, `Š`, `Ž` and `Đ` are letters of their own; the default collation folds them onto `c`,
   * `s`, `z` and `d`, which puts Čolić between Cvetković and Ćirić — wrong in a way a Serbian
   * reader notices at once.
   */
  it('orders Serbian names as a Serbian reader expects', () => {
    const names = ['Ćirić', 'Cvetković', 'Čolić', 'Džonić', 'Dimitrijević'];
    const ordered = sortSites(
      names.map((companyName, index) => site({ companyName, projectId: `p-${index}` })),
      { key: 'company', direction: 'asc' },
    ).map((s) => s.companyName);

    expect(ordered).toEqual(['Cvetković', 'Čolić', 'Ćirić', 'Dimitrijević', 'Džonić']);
  });

  /**
   * **Ties break on customer then site, so the order is total.**
   *
   * A hundred healthy sites all score zero, and a list that reshuffled itself between two reloads
   * is a list nobody trusts — which on this screen would be the first reason to disbelieve the
   * numbers beside the names.
   */
  it('breaks every tie the same way, twice running', () => {
    const rows = [
      site({ projectId: 'b', companyName: 'Beta', projectName: 'Druga' }),
      site({ projectId: 'a', companyName: 'Alfa', projectName: 'Prva' }),
      site({ projectId: 'c', companyName: 'Beta', projectName: 'Prva' }),
    ];

    const once = sortSites(rows, SITE_INITIAL_SORT).map((s) => s.projectId);
    const twice = sortSites([...rows].reverse(), SITE_INITIAL_SORT).map((s) => s.projectId);

    // Alfa before Beta; and within Beta, "Druga" before "Prva".
    expect(once).toEqual(['a', 'b', 'c']);
    expect(twice).toEqual(once);
  });

  /** It never mutates what it was handed — the screen keeps the server's list to re-sort. */
  it('leaves the input alone', () => {
    const rows = [site({ projectId: 'b', companyName: 'Beta' }), site({ projectId: 'a', companyName: 'Alfa' })];
    const before = rows.map((s) => s.projectId);

    sortSites(rows, { key: 'company', direction: 'asc' });

    expect(rows.map((s) => s.projectId)).toEqual(before);
  });
});

describe('siteChips', () => {
  /**
   * **Every condition gets its own chip rather than one worst-state word**, because the founder's
   * next action differs per condition: a handed-back day is a phone call to a foreman, a failed
   * report is a look at the log, and an entry carrying a failure may be either.
   */
  it('names every condition a site is in', () => {
    const chips = siteChips(
      site({
        pipeline: { ...site().pipeline, needsReview: 2 },
        pipelineFailures: [{ reason: 'extraction_failed', count: 3 }],
        delivery: { reportCount: 4, sending: 1, sent: 2, failed: 1 },
      }),
    );

    expect(chips.map((chip) => chip.key)).toEqual([
      'health.site.needsReview',
      'health.site.failures',
      'health.site.undelivered',
      'health.site.sending',
    ]);
    expect(chips.map((chip) => chip.count)).toEqual([2, 3, 1, 1]);
    expect(chips.map((chip) => chip.tone)).toEqual(['warn', 'err', 'err', 'warn']);
  });

  /**
   * The two plain states, which must not read as problems. A site that has recorded nothing is a
   * real and common state — two of the three demo sites are in it — and a site with days and
   * nothing wrong is the answer this screen exists to be able to give.
   */
  it('tells a site with nothing wrong from a site with nothing on it', () => {
    expect(siteChips(site())).toEqual([
      { key: 'health.site.ok', wordKey: 'health.site.ok', tone: 'ok', count: null },
    ]);

    const fresh = site({
      pipeline: {
        entryCount: 0,
        received: 0,
        processing: 0,
        awaitingConfirmation: 0,
        needsReview: 0,
        confirmed: 0,
        reported: 0,
      },
      delivery: { reportCount: 0, sending: 0, sent: 0, failed: 0 },
    });
    expect(siteChips(fresh)).toEqual([
      { key: 'health.site.empty', wordKey: 'health.site.empty', tone: 'neutral', count: null },
    ]);
  });

  /**
   * **Every key a chip can render is written out**, never assembled — which is what keeps all ten
   * of them visible to `i18n.spec.ts`, the one guard that stops a raw key reaching the glass. The
   * first cut built the four counted forms by concatenation and hid them from it.
   */
  it('declares every key it can render', () => {
    const produced = new Set<string>();
    const cases = [
      site(),
      site({
        pipeline: {
          entryCount: 0,
          received: 0,
          processing: 0,
          awaitingConfirmation: 0,
          needsReview: 0,
          confirmed: 0,
          reported: 0,
        },
        delivery: { reportCount: 0, sending: 0, sent: 0, failed: 0 },
      }),
      site({
        pipeline: { ...site().pipeline, needsReview: 1 },
        pipelineFailures: [{ reason: 'render_failed', count: 1 }],
        delivery: { reportCount: 2, sending: 1, sent: 0, failed: 1 },
      }),
    ];

    for (const candidate of cases) {
      for (const chip of siteChips(candidate)) {
        produced.add(chip.key);
        produced.add(chip.wordKey);
      }
    }

    expect([...produced].sort()).toEqual([...SITE_CHIP_KEYS].sort());
  });

  /** The identity a `@for` tracks on is the plain key, so counted and plain chips never collide. */
  it('gives the plain and the counted form of a chip one identity and two keys', () => {
    const [chip] = siteChips(site({ pipeline: { ...site().pipeline, needsReview: 3 } }));

    expect(chip.key).toBe('health.site.needsReview');
    expect(chip.wordKey).toBe('health.site.needsReviewCount');
  });
});
