import { SiteHealth } from '../../core/platform/platform.service';
import { SortDirection } from '../../ui/table-controls';

/**
 * How badly one site wants looking at, as one number.
 *
 * **A deliberate mirror of the server's own `PlatformDirectory.NeedsAttention`**, and the same
 * three terms: days handed back to a person, entries carrying a failure, and reports that did not
 * go out. It exists so that "sort by state" means the order the founder actually reads the list in,
 * and so that the screen's *default* order is the order the server sent — which is what keeps the
 * first paint from visibly reshuffling itself.
 *
 * **Never rendered, and nothing adds it up.** That is what makes the double-counting harmless:
 * an entry parked in `needs_review` almost always carries a reason too, so the first two terms
 * overlap. The only property that has to hold is that a site with something wrong outranks a site
 * with nothing, and undercounting is the failure that would matter.
 *
 * `deliveryFailures` is deliberately **not** a term, for the reason the server gives: a `failed`
 * report row always carries a reason, so summing both would count one problem twice for no extra
 * signal.
 */
export function attentionScore(site: SiteHealth): number {
  return (
    site.pipeline.needsReview +
    site.pipelineFailures.reduce((total, tally) => total + tally.count, 0) +
    site.delivery.failed
  );
}

/** The four facts on a site row worth ordering by. */
export type SiteSortKey = 'company' | 'site' | 'days' | 'state';

export interface SiteSort {
  readonly key: SiteSortKey;
  readonly direction: SortDirection;
}

/**
 * The order the server sends the list in, expressed as a column sort.
 *
 * Attention first, then customer, then site — so the table's first paint is the answer the server
 * already computed rather than a re-sort of it.
 *
 * **`asc`, and the direction is not a free choice.** `ui/column-menu.ts` names both directions in
 * words, and for `kind="state"` the words are fixed: `table.sort.state.asc` reads *"Prvo ono što
 * traži pažnju"* and `desc` reads *"Prvo ono što je rešeno"*. `/platform` is built on the same
 * convention — `platform-people.ts` ranks `pending` at 0 so that ascending means *who needs you*.
 * The first cut of this file had `desc` mean attention-first, so the funnel would have offered
 * "resolved first" and answered with the troubled sites at the top: a control naming the opposite
 * of what it does, on the screen whose whole job is not misleading the reader.
 */
export const SITE_INITIAL_SORT: SiteSort = { key: 'state', direction: 'asc' };

/**
 * The useful direction per column, so a first tap never costs a second one: names want A→Ž, days
 * want the busiest site, and state wants attention first — which is `asc`, per the note above.
 */
export const SITE_DEFAULT_DIRECTION: Record<SiteSortKey, SortDirection> = {
  company: 'asc',
  site: 'asc',
  days: 'desc',
  state: 'asc',
};

/**
 * The sites in the order the list shows them. **Never mutates the input.**
 *
 * Ties always break on customer then site, so the order is total: a hundred healthy sites all
 * score zero, and a list that reshuffled itself between two reloads is a list nobody trusts —
 * which on this screen would be the first reason to disbelieve the numbers beside the names.
 */
export function sortSites(sites: readonly SiteHealth[], sort: SiteSort): SiteHealth[] {
  return [...sites].sort((left, right) => {
    const primary = compare(left, right, sort);
    return primary !== 0 ? primary : byName(left, right);
  });
}

function compare(left: SiteHealth, right: SiteHealth, sort: SiteSort): number {
  const factor = sort.direction === 'asc' ? 1 : -1;

  switch (sort.key) {
    case 'company':
      return left.companyName.localeCompare(right.companyName, 'sr-Latn') * factor;
    case 'site':
      return left.projectName.localeCompare(right.projectName, 'sr-Latn') * factor;
    case 'days':
      return (left.pipeline.entryCount - right.pipeline.entryCount) * factor;
    case 'state':
      // **Reversed on purpose.** A higher score is a worse site, and ascending on this column has
      // to mean *worst first* — that is what the menu's own words promise and what `/platform`
      // does with its rank. `platform-people.ts` gets there by numbering the urgent state 0;
      // this score mirrors the server's `NeedsAttention`, where urgent counts up, so the
      // subtraction is the one that turns it round.
      return (attentionScore(right) - attentionScore(left)) * factor;
  }
}

/**
 * Serbian Latin collation, explicitly, and the customer before the site.
 *
 * `Č`, `Ć`, `Š`, `Ž` and `Đ` are letters of their own; the default collation folds them onto `c`,
 * `s`, `z` and `d`, which puts Čolić between Cvetković and Ćirić — wrong in a way a Serbian reader
 * notices at once. Customer first because two customers may well name a site the same thing (a
 * street is a street), and grouping a customer's sites together is how this list is read.
 */
function byName(left: SiteHealth, right: SiteHealth): number {
  return (
    left.companyName.localeCompare(right.companyName, 'sr-Latn') ||
    left.projectName.localeCompare(right.projectName, 'sr-Latn')
  );
}

/** A chip on a site row: what is wrong with it, or that nothing is. */
export interface SiteChip {
  /**
   * The chip's identity, and the key for its wordless form.
   *
   * Also what `@for` tracks on, which is why it is the plain key rather than the one being
   * rendered: the two chips that carry a count and the two that do not must never collide.
   */
  readonly key: string;
  /**
   * The key actually rendered — **written out, never assembled from {@link key}.**
   *
   * `i18n.spec.ts` finds a translation key by reading the source for anything shaped like one, so
   * a `` `${chip.key}Count` `` would hide four keys from the guard whose whole job is stopping a
   * raw key reaching the glass. This is the same argument `health-reason.ts` makes for being a
   * literal map, applied to the four chips that interpolate a number.
   *
   * Two keys rather than one with an optional parameter, because Transloco renders a missing
   * `{{count}}` as an empty string: one key would print "Potrebna provera" with a gap where the
   * number should be on the two chips that have no number.
   */
  readonly wordKey: string;
  readonly tone: 'ok' | 'warn' | 'err' | 'neutral';
  /** How many, where the chip counts something. Null on the two that are plain states. */
  readonly count: number | null;
}

/**
 * What a site's row says about itself.
 *
 * **Every condition gets its own chip rather than one worst-state word**, because the founder's
 * next action differs per condition: a day in `needs_review` is a phone call to a foreman, a
 * failed report is a look at the log, and an entry carrying a failure may be either. A single
 * "worst" label would collapse three different errands into one.
 *
 * The two plain states are the ones that must not read as problems: a site that has recorded
 * nothing is a real and common state (two of the three demo sites are in it), and a site with
 * days and nothing wrong is the answer the screen exists to be able to give.
 */
export function siteChips(site: SiteHealth): SiteChip[] {
  const chips: SiteChip[] = [];
  const failures = site.pipelineFailures.reduce((total, tally) => total + tally.count, 0);

  if (site.pipeline.needsReview > 0) {
    chips.push({
      key: 'health.site.needsReview',
      wordKey: 'health.site.needsReviewCount',
      tone: 'warn',
      count: site.pipeline.needsReview,
    });
  }
  if (failures > 0) {
    chips.push({
      key: 'health.site.failures',
      wordKey: 'health.site.failuresCount',
      tone: 'err',
      count: failures,
    });
  }
  if (site.delivery.failed > 0) {
    chips.push({
      key: 'health.site.undelivered',
      wordKey: 'health.site.undeliveredCount',
      tone: 'err',
      count: site.delivery.failed,
    });
  }
  if (site.delivery.sending > 0) {
    chips.push({
      key: 'health.site.sending',
      wordKey: 'health.site.sendingCount',
      tone: 'warn',
      count: site.delivery.sending,
    });
  }

  if (chips.length > 0) {
    return chips;
  }

  return site.pipeline.entryCount === 0
    ? [{ key: 'health.site.empty', wordKey: 'health.site.empty', tone: 'neutral', count: null }]
    : [{ key: 'health.site.ok', wordKey: 'health.site.ok', tone: 'ok', count: null }];
}

/**
 * Every chip key the screen can render, so `i18n.spec.ts` can walk them at runtime as well.
 *
 * The literal scan already sees each one above; this is the second guard, and it is the one that
 * would survive somebody deciding to build a key from a variable after all.
 */
export const SITE_CHIP_KEYS: readonly string[] = [
  'health.site.needsReview',
  'health.site.needsReviewCount',
  'health.site.failures',
  'health.site.failuresCount',
  'health.site.undelivered',
  'health.site.undeliveredCount',
  'health.site.sending',
  'health.site.sendingCount',
  'health.site.empty',
  'health.site.ok',
];
