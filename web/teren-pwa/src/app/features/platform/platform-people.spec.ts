import { Customer, Person } from '../../core/platform/platform.service';
import {
  DEFAULT_DIRECTION,
  PeopleSort,
  groupOf,
  personChips,
  personState,
  sortCustomers,
  sortPeople,
} from './platform-people';

function person(overrides: Partial<Person> & { displayName: string }): Person {
  return {
    id: overrides.displayName,
    companyId: null,
    companyName: null,
    role: 'company_admin',
    username: null,
    email: null,
    createdAt: null,
    lastLoginAt: null,
    disabled: false,
    passwordPending: false,
    ...overrides,
  };
}

function customer(name: string): Customer {
  return {
    id: name,
    name,
    createdAt: null,
    suspendedAt: null,
    userCount: 0,
    activeUserCount: 0,
  };
}

function names(people: Person[]): string[] {
  return people.map((one) => one.displayName);
}

describe('personState', () => {
  /**
   * The order the founder reads the list in — **who is not finished yet**. It is the only reason
   * "sort by state" means anything, so the ranking is asserted rather than assumed.
   */
  it('tells an account nobody can sign in to from one that works', () => {
    expect(personState(person({ displayName: 'A', passwordPending: true }))).toBe('pending');
    expect(personState(person({ displayName: 'B' }))).toBe('active');
  });

  /** Removed outranks everything: a disabled man's finished password is not something to chase. */
  it('puts a removed account last whatever else is true of it', () => {
    expect(
      personState(person({ displayName: 'C', disabled: true, passwordPending: true })),
    ).toBe('removed');
    expect(personState(person({ displayName: 'D', disabled: true }))).toBe('removed');
  });

  /**
   * **A foreman is never `pending`, and the sort has to agree with the chips about that.**
   *
   * `ck_app_user_worker_has_no_password` makes a foreman's password unstorable, so
   * `password_pending` is permanently true for every worker in the product. This resolved to
   * `pending` until the F7 review: {@link personChips} refused to *draw* it, but the state is the
   * sort key, so every foreman on the platform sorted into the "needs you" bucket at the top —
   * for ever, with nothing anybody could do about it. Two halves of one screen disagreeing about
   * the same man.
   */
  it('never reports a foreman as pending, however pending the column says he is', () => {
    expect(
      personState(person({ displayName: 'Zoran', role: 'worker', passwordPending: true })),
    ).toBe('active');

    // And being disabled still outranks it, exactly as for anybody else.
    expect(
      personState(
        person({ displayName: 'Zoran', role: 'worker', passwordPending: true, disabled: true }),
      ),
    ).toBe('removed');
  });
});

describe('personChips', () => {
  /**
   * **The rule this file exists for.** `ck_app_user_worker_has_no_password` makes a foreman's
   * password unstorable, so `password_pending` is true for every worker in the product, for ever.
   * Drawing the "invited, never finished" chip for him would put a permanent, unfixable warning
   * beside every foreman on the platform — a screen crying wolf about its own data model.
   */
  it('never says a foreman has not signed in, however pending he is', () => {
    const chips = personChips(
      person({ displayName: 'Zoran', role: 'worker', passwordPending: true }),
    );

    expect(chips).toEqual([]);
    expect(chips.map((chip) => chip.key)).not.toContain('platform.person.pending');
    // Nor the opposite: "active" is a statement about a password, and he has none to have set.
    expect(chips.map((chip) => chip.key)).not.toContain('platform.person.active');
  });

  it('still says a foreman was taken out of service, because that is a real act', () => {
    const chips = personChips(
      person({ displayName: 'Zoran', role: 'worker', passwordPending: true, disabled: true }),
    );

    expect(chips).toEqual([{ key: 'platform.person.disabled', tone: 'err' }]);
  });

  it('warns about an administrator who was invited and never finished', () => {
    expect(personChips(person({ displayName: 'Petar', passwordPending: true }))).toEqual([
      { key: 'platform.person.pending', tone: 'warn' },
    ]);
  });

  it('says an administrator with a password is active', () => {
    expect(personChips(person({ displayName: 'Petar' }))).toEqual([
      { key: 'platform.person.active', tone: 'ok' },
    ]);
    expect(personChips(person({ displayName: 'Milovan', role: 'super_admin' }))).toEqual([
      { key: 'platform.person.active', tone: 'ok' },
    ]);
  });

  it('leads with removed, because it changes what every other chip means', () => {
    const chips = personChips(
      person({ displayName: 'Petar', disabled: true, passwordPending: true }),
    );

    expect(chips[0]).toEqual({ key: 'platform.person.disabled', tone: 'err' });
    // …and a removed account is never also called active.
    expect(chips.map((chip) => chip.key)).not.toContain('platform.person.active');
  });

  /**
   * A chip is a **key**, and there is no field on it that could carry a name, an address or a
   * link even if somebody wanted one there. The platform screens say what an account *is*, never
   * what it holds.
   */
  it('carries a translation key and a tone, and nothing about the person', () => {
    const chips = personChips(
      person({
        displayName: 'Petar Petrović',
        email: 'petar@firma.rs',
        passwordPending: true,
      }),
    );

    expect(JSON.stringify(chips)).not.toContain('Petar');
    expect(JSON.stringify(chips)).not.toContain('@');
    for (const chip of chips) {
      expect(Object.keys(chip).sort()).toEqual(['key', 'tone']);
    }
  });
});

describe('sortPeople', () => {
  const ana = person({
    displayName: 'Ana',
    companyName: 'Zlatibor Gradnja',
    passwordPending: true,
  });
  const cvetkovic = person({ displayName: 'Cvetković', companyName: 'Ada Gradnja' });
  const colic = person({ displayName: 'Čolić', companyName: 'Ada Gradnja', disabled: true });
  const milovan = person({ displayName: 'Milovan', role: 'super_admin', companyName: null });
  const zoran = person({
    displayName: 'Zoran',
    role: 'worker',
    companyName: 'Zlatibor Gradnja',
    passwordPending: true,
  });
  const all = [ana, cvetkovic, colic, milovan, zoran];

  it('never mutates what it was given', () => {
    const original = [...all];

    sortPeople(all, { key: 'company', direction: 'desc' });

    expect(all).toEqual(original);
  });

  /**
   * `Č`, `Ć`, `Š`, `Ž` and `Đ` are letters of their own in Serbian. The default collation folds
   * them onto `c`, `s`, `z` and `d`, which puts **Čolić between Cvetković and Ćirić** — wrong in a
   * way a Serbian reader notices at once.
   */
  it('sorts names the way Serbian sorts them', () => {
    expect(names(sortPeople(all, { key: 'name', direction: 'asc' }))).toEqual([
      'Ana',
      'Cvetković',
      'Čolić',
      'Milovan',
      'Zoran',
    ]);
    expect(names(sortPeople(all, { key: 'name', direction: 'desc' }))).toEqual([
      'Zoran',
      'Milovan',
      'Čolić',
      'Cvetković',
      'Ana',
    ]);
  });

  it('sorts by state, ties broken by name so the order is total', () => {
    expect(names(sortPeople(all, { key: 'state', direction: 'asc' }))).toEqual([
      // pending, then active, then removed — and inside each, A→Ž.
      'Ana',
      // Zoran is a worker and `passwordPending`, and sorts as **active**: the constraint makes
      // that flag permanently true for him, so treating it as "needs you" would pin every foreman
      // on the platform to the top of this column for ever. Fixed in the F7 review, where the
      // chips and the sort were found disagreeing about the same man.
      'Cvetković',
      'Milovan',
      'Zoran',
      'Čolić',
    ]);
    expect(names(sortPeople(all, { key: 'state', direction: 'desc' }))).toEqual([
      'Čolić',
      'Cvetković',
      'Milovan',
      'Zoran',
      'Ana',
    ]);
  });

  /**
   * **Teren's own staff sort last on the company column in both directions.** A super admin has no
   * company by construction (`ck_app_user_company_scope`); that is not "the empty company name",
   * and putting him at the top of an A→Ž list of customers would read as a customer whose name the
   * screen failed to load.
   */
  it('pins the people who belong to no customer below the named ones, in both directions', () => {
    const ascending = names(sortPeople(all, { key: 'company', direction: 'asc' }));
    const descending = names(sortPeople(all, { key: 'company', direction: 'desc' }));

    expect(ascending).toEqual(['Cvetković', 'Čolić', 'Ana', 'Zoran', 'Milovan']);
    expect(descending).toEqual(['Ana', 'Zoran', 'Cvetković', 'Čolić', 'Milovan']);

    expect(ascending.at(-1)).toBe('Milovan');
    expect(descending.at(-1)).toBe('Milovan');
  });

  it('keeps two members of staff in a stable order among themselves', () => {
    const staff = [
      person({ displayName: 'Milovan', role: 'super_admin' }),
      person({ displayName: 'Ana', role: 'super_admin' }),
    ];

    expect(names(sortPeople(staff, { key: 'company', direction: 'asc' }))).toEqual([
      'Ana',
      'Milovan',
    ]);
    expect(names(sortPeople(staff, { key: 'company', direction: 'desc' }))).toEqual([
      'Ana',
      'Milovan',
    ]);
  });

  /**
   * A comparator that answered 0 for a null-versus-name pair — the obvious shortcut — would be
   * intransitive, and `Array.prototype.sort` given an inconsistent comparator returns an arbitrary
   * order rather than an error. This is that bug asserted as a property: **every sort of the same
   * data is the same sort**, whatever order the rows arrived in.
   */
  it('is stable across repeated sorts of the same data', () => {
    for (const sort of [
      { key: 'name', direction: 'asc' },
      { key: 'name', direction: 'desc' },
      { key: 'state', direction: 'asc' },
      { key: 'state', direction: 'desc' },
      { key: 'company', direction: 'asc' },
      { key: 'company', direction: 'desc' },
    ] satisfies PeopleSort[]) {
      const once = names(sortPeople(all, sort));
      const twice = names(sortPeople([...all].reverse(), sort));
      expect(twice, `${sort.key}/${sort.direction} depends on the input order`).toEqual(once);
    }
  });

  it('starts each column in the direction that is worth a first tap', () => {
    // "Who needs me" is already ascending, and a name wants A→Ž.
    expect(DEFAULT_DIRECTION).toEqual({ name: 'asc', state: 'asc', company: 'asc' });
  });
});

describe('sortCustomers', () => {
  it('sorts customers the way Serbian sorts them, and never mutates the input', () => {
    const all = [customer('Zoran d.o.o.'), customer('Čolić'), customer('Cvetković'), customer('Ana')];
    const original = [...all];

    const sorted = sortCustomers(all);

    expect(sorted.map((one) => one.name)).toEqual([
      'Ana',
      'Cvetković',
      'Čolić',
      'Zoran d.o.o.',
    ]);
    expect(all).toEqual(original);
  });
});

describe('groupOf', () => {
  /**
   * The group order on screen is the order of *reach* — everything, one company, one day's work —
   * and the founder reads down the page outwards from himself. Which is which is decided here.
   */
  it('files each role under the question it answers', () => {
    expect(groupOf(person({ displayName: 'A', role: 'super_admin' }))).toBe('staff');
    expect(groupOf(person({ displayName: 'B', role: 'company_admin' }))).toBe('admins');
    expect(groupOf(person({ displayName: 'C', role: 'worker' }))).toBe('workers');
  });

  /**
   * A role this build has never heard of goes with the foremen — the group with the least reach.
   * The alternative, filing an unknown role with Teren's own staff, would put an account nobody
   * can describe in the group that can see everything.
   */
  it('files a role it does not recognise with the least privileged group', () => {
    expect(groupOf(person({ displayName: 'D', role: 'auditor' }))).toBe('workers');
  });
});
