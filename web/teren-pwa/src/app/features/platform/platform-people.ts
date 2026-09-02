import { Customer, Person } from '../../core/platform/platform.service';
import { SortDirection } from '../../ui/table-controls';

/**
 * How an account stands, as one value — the thing the people list sorts by.
 *
 * Not a label: each of these is already said on the row as a chip, and a second vocabulary for the
 * same fact is how two halves of one screen come to disagree. This exists so "sort by state" means
 * the order the founder actually reads the list in — **who is not finished yet**:
 *
 * - `pending` — invited and never set a password. He cannot sign in, and nobody is chasing it but
 *   the founder. Sorts first because it is the only state that needs him to act.
 * - `active` — has a password and is not disabled. The ordinary case.
 * - `removed` — taken out of service. Last, whatever else is true of him.
 */
export type PersonState = 'pending' | 'active' | 'removed';

const STATE_RANK: Record<PersonState, number> = { pending: 0, active: 1, removed: 2 };

export function personState(person: Person): PersonState {
  if (person.disabled) {
    return 'removed';
  }

  // **A worker is never `pending`, and this is the same rule `personChips` enforces.**
  // `ck_app_user_worker_has_no_password` makes a foreman's password unstorable, so
  // `passwordPending` is permanently true for every worker in the product. Reading that as
  // "invited and never finished" would put every foreman on the platform into the bucket that
  // means *this one needs you* — at the top of the state sort, for ever, with nothing anybody
  // could do about it.
  //
  // This was wrong until the F7 review: the chips suppressed it and the sort did not, so the two
  // halves of one screen disagreed about the same man.
  if (person.role === 'worker') {
    return 'active';
  }

  return person.passwordPending ? 'pending' : 'active';
}

/**
 * A chip on a person's row.
 *
 * **A worker is `pending` by construction, and that must not read as a problem.**
 * `ck_app_user_worker_has_no_password` makes a foreman's password unstorable, so
 * `password_pending` is permanently true for every worker in the product. Showing him the same
 * "invited, never finished" chip an unfinished admin gets would put a warning next to every
 * foreman on the platform, forever — a screen crying wolf about its own data model. So the chip is
 * only drawn for the roles that can actually hold a password.
 */
export interface PersonChip {
  readonly key: string;
  readonly tone: 'ok' | 'warn' | 'err' | 'neutral';
}

export function personChips(person: Person): PersonChip[] {
  const chips: PersonChip[] = [];

  // First, because it changes what every other chip means.
  if (person.disabled) {
    chips.push({ key: 'platform.person.disabled', tone: 'err' });
  }

  if (person.role !== 'worker' && person.passwordPending) {
    chips.push({ key: 'platform.person.pending', tone: 'warn' });
  }

  if (person.role !== 'worker' && !person.passwordPending && !person.disabled) {
    chips.push({ key: 'platform.person.active', tone: 'ok' });
  }

  return chips;
}

export type PeopleSortKey = 'name' | 'state' | 'company';

/** One definition for every list in the product — see `ui/table-controls.ts`. */
export type { SortDirection };

export interface PeopleSort {
  readonly key: PeopleSortKey;
  readonly direction: SortDirection;
}

/** A name wants A→Ž; a state wants "who needs me" first, which is already `asc`. */
export const DEFAULT_DIRECTION: Record<PeopleSortKey, SortDirection> = {
  name: 'asc',
  state: 'asc',
  company: 'asc',
};

/**
 * The accounts in the order the list shows them. **Never mutates the input.**
 *
 * Ties always break on the name, so the order is total and a re-sort of the same data cannot
 * shuffle rows — a list that reorders itself between reloads is a list nobody trusts.
 *
 * **Teren's own staff sort last on the company column in both directions.** A super admin has no
 * company by construction (`ck_app_user_company_scope`); that is not "the empty company name", and
 * putting him at the top of an A→Ž list of customers would read as a customer whose name is
 * missing.
 */
export function sortPeople(people: readonly Person[], sort: PeopleSort): Person[] {
  return [...people].sort((left, right) => {
    const primary = compare(left, right, sort);
    return primary !== 0 ? primary : byName(left, right);
  });
}

function compare(left: Person, right: Person, sort: PeopleSort): number {
  const factor = sort.direction === 'asc' ? 1 : -1;

  switch (sort.key) {
    case 'name':
      return byName(left, right) * factor;
    case 'state':
      return (STATE_RANK[personState(left)] - STATE_RANK[personState(right)]) * factor;
    case 'company': {
      if (left.companyName === null && right.companyName === null) {
        return 0;
      }
      // Undirected on purpose — see the class comment. Staff belong to no customer, and that is a
      // different thing from an unnamed one.
      if (left.companyName === null) {
        return 1;
      }
      if (right.companyName === null) {
        return -1;
      }
      return left.companyName.localeCompare(right.companyName, 'sr-Latn') * factor;
    }
  }
}

/**
 * Serbian Latin collation, explicitly. `Č`, `Ć`, `Š`, `Ž` and `Đ` are letters of their own; the
 * default collation folds them onto `c`, `s`, `z` and `d`, which puts Čolić between Cvetković and
 * Ćirić — wrong in a way a Serbian reader notices at once.
 */
function byName(left: Person, right: Person): number {
  return left.displayName.localeCompare(right.displayName, 'sr-Latn');
}

/** The three facts on a customer row worth ordering by. */
export type CustomerSortKey = 'name' | 'people' | 'since';

export interface CustomerSort {
  readonly key: CustomerSortKey;
  readonly direction: SortDirection;
}

/**
 * A name wants A→Ž; the two others want the interesting end first — the biggest customer, and the
 * newest signing. A first tap on a column never costs a second one.
 */
export const CUSTOMER_DEFAULT_DIRECTION: Record<CustomerSortKey, SortDirection> = {
  name: 'asc',
  people: 'desc',
  since: 'desc',
};

/**
 * The customers in the order the list shows them. **Never mutates the input.**
 *
 * The default is by name, which is the order the screen was born with and the order the "choose a
 * company" dropdown on `/platform` still wants — a dropdown is not a table and has nothing to sort
 * itself by.
 *
 * Ties always break on the name, so the order is total: sorted by head-count, two customers of two
 * people each would otherwise arrive in whatever order the server happened to send them, and a list
 * that reshuffles itself between reloads is a list nobody trusts. **A customer with no signing date
 * sorts last in both directions**, for the same reason a foreman who has never called home does:
 * an unknown date is not the oldest date.
 */
export function sortCustomers(
  customers: readonly Customer[],
  sort: CustomerSort = { key: 'name', direction: 'asc' },
): Customer[] {
  return [...customers].sort((left, right) => {
    const primary = compareCustomers(left, right, sort);
    return primary !== 0 ? primary : byCustomerName(left, right);
  });
}

function compareCustomers(left: Customer, right: Customer, sort: CustomerSort): number {
  const factor = sort.direction === 'asc' ? 1 : -1;

  switch (sort.key) {
    case 'name':
      return byCustomerName(left, right) * factor;
    case 'people':
      return (left.userCount - right.userCount) * factor;
    case 'since': {
      if (left.createdAt === null && right.createdAt === null) {
        return 0;
      }
      // Undirected on purpose: a customer whose signing date the server did not send is not the
      // oldest customer, and putting him at the top of "oldest first" would read as the founder's
      // first ever sale.
      if (left.createdAt === null) {
        return 1;
      }
      if (right.createdAt === null) {
        return -1;
      }
      return (Date.parse(left.createdAt) - Date.parse(right.createdAt)) * factor;
    }
  }
}

function byCustomerName(left: Customer, right: Customer): number {
  return left.name.localeCompare(right.name, 'sr-Latn');
}

/**
 * Which of the three tabs an account belongs under.
 *
 * Grouped by role rather than listed flat because the founder's two questions are different
 * questions: "who on my staff" and "who at my customers" are not answered by one alphabetical
 * list of everybody in the product.
 */
export type PeopleGroupKey = 'staff' | 'admins' | 'workers';

export function groupOf(person: Person): PeopleGroupKey {
  switch (person.role) {
    case 'super_admin':
      return 'staff';
    case 'company_admin':
      return 'admins';
    default:
      return 'workers';
  }
}
