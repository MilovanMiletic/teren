import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import {
  Customer,
  Invite,
  Person,
  PlatformService,
  PlatformStatus,
  serverAnswered,
} from '../../core/platform/platform.service';
import { AppHeader } from '../../ui/app-header';
import { Icon } from '../../ui/icon';
import { InfoPopover } from '../../ui/info-popover';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { ModalSheet } from '../../ui/modal-sheet';
import { SelectField } from '../../ui/select-field';
import { SessionLink } from '../../ui/session-link';
import { ViewportService } from '../../ui/viewport.service';
import { platformReasonFor } from './platform-reason';
import {
  DEFAULT_DIRECTION,
  PeopleGroupKey,
  PeopleSort,
  PeopleSortKey,
  PersonChip,
  groupOf,
  personChips,
  sortCustomers,
  sortPeople,
} from './platform-people';

/** One line of the directory: the person, and the chips that say how he stands. */
interface PersonRow {
  person: Person;
  chips: PersonChip[];
}

/** One group of the directory, in the order the screen shows them. */
interface PeopleGroup {
  key: PeopleGroupKey;
  rows: PersonRow[];
}

/** Which tab of the add dialog is showing. The two are different requests, not one with a flag. */
type AddTab = 'company_admin' | 'super_admin';

/**
 * Teren's own surface (`plans/profile-and-identity.md` §8, §10.3 — F7): **every account in the
 * product, and the way to add one.**
 *
 * ## What this screen is, and what it deliberately is not
 *
 * It is the directory of *people*: Teren's own staff, the customers' administrators, and the
 * foremen — grouped by role, because "who is on my staff" and "who is stuck at a customer" are two
 * questions and one alphabetical list of everybody answers neither. Customers themselves live on
 * `/platform/companies`, which is where one is created and suspended.
 *
 * **It shows nothing about anybody's work.** No entry counts, no project detail, no transcript,
 * no photograph — the platform DTOs do not carry them and `PlatformPrivacyTests` fails the build
 * if one ever does. Teren staff can see which companies and accounts exist and what is failing;
 * they cannot read a customer's diary.
 *
 * ## The add dialog has two tabs because they are two different requests
 *
 * A company admin needs a `company_id`; a member of staff **must not have one** —
 * `ck_app_user_company_scope` makes "a super admin inside a tenant" unstorable, and the server
 * answers 400 rather than letting a CHECK produce a 500. Tabs rather than a role dropdown with a
 * conditionally-shown company field, because the two forms genuinely differ and a stale company
 * selection left behind by a dropdown is exactly the 400 nobody would understand. Switching tabs
 * clears the company for the same reason.
 *
 * **The first super admin is never created here.** He is seeded (founder, 2026-09-01) — this
 * screen adds the second and every one after. That is why an account with no `admin_created` audit
 * row is the bootstrap one.
 *
 * ## The link is shown once, and that is the whole onboarding
 *
 * Creating an admin mints his set-password link in the same transaction, and it comes back in the
 * response because **there is no SMTP relay yet**: the founder reads it down the phone or pastes
 * it into a chat. The dialog therefore stays open on success showing the link, rather than closing
 * with a cheerful toast over the one value the screen existed to produce.
 *
 * ## Three deliberate layouts
 *
 *   compact   <768      tappable rows: name and email on top, chips beneath.
 *   medium    768–1023  a real `<table>` on the 640 column.
 *   expanded  ≥1024     the table claims all twelve columns; no rail.
 *
 * Which rendering is drawn is decided in TypeScript ({@link ViewportService}), never by
 * `display: none`: a `<table>` whose cells are forced to `display: block` loses its table role in
 * every browser, so one markup restyled would give a phone the semantics of a table and a screen
 * reader the semantics of neither.
 */
@Component({
  selector: 'app-platform-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeader,
    Icon,
    InfoPopover,
    LanguageSwitcher,
    ModalSheet,
    SelectField,
    SessionLink,
    TranslocoDirective,
  ],
  templateUrl: './platform-page.html',
  styleUrls: ['../../ui/field.css', './platform-page.css'],
})
export class PlatformPage {
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);

  protected readonly viewport = inject(ViewportService);

  protected readonly loading = signal(true);
  protected readonly people = signal<Person[]>([]);
  protected readonly customers = signal<Customer[]>([]);
  protected readonly status = signal<PlatformStatus>('ok');

  /** The list could not be confirmed with the server, so it is not a list of the product. */
  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');

  protected readonly reasonKey = computed(() => platformReasonFor(this.status()));

  protected readonly sort = signal<PeopleSort>({ key: 'state', direction: 'asc' });

  protected readonly ascending = computed(() => this.sort().direction === 'asc');

  /**
   * The directory, grouped and sorted.
   *
   * The group order is fixed rather than sorted: staff, then customers' administrators, then
   * foremen. It is the order of *reach* — the people who can see everything, then the people who
   * can see one company, then the people who can see one day's work — and an owner reading down
   * the page is reading outwards from himself.
   */
  protected readonly groups = computed<PeopleGroup[]>(() => {
    const sorted = sortPeople(this.people(), this.sort());
    const order: PeopleGroupKey[] = ['staff', 'admins', 'workers'];

    return order
      .map((key) => ({
        key,
        rows: sorted
          .filter((person) => groupOf(person) === key)
          .map((person) => ({ person, chips: personChips(person) })),
      }))
      .filter((group) => group.rows.length > 0);
  });

  protected readonly staffCount = computed(
    () => this.people().filter((person) => groupOf(person) === 'staff').length,
  );

  protected readonly adminCount = computed(
    () => this.people().filter((person) => groupOf(person) === 'admins').length,
  );

  /**
   * Administrators who were invited and never finished.
   *
   * Workers are excluded and it is not an oversight: a foreman's password is unstorable by
   * constraint, so counting him here would put a permanent, unfixable number on the screen.
   */
  protected readonly pendingCount = computed(
    () =>
      this.people().filter(
        (person) => person.role !== 'worker' && person.passwordPending && !person.disabled,
      ).length,
  );

  // ---- the add dialog ------------------------------------------------------------------------

  protected readonly addOpen = signal(false);
  protected readonly tab = signal<AddTab>('company_admin');
  protected readonly newName = signal('');
  protected readonly newEmail = signal('');
  protected readonly newCompanyId = signal('');
  protected readonly adding = signal(false);
  protected readonly addStatus = signal<PlatformStatus | null>(null);
  /** The link the founder reads down the phone. Present only after a successful create. */
  protected readonly issued = signal<Invite | null>(null);
  protected readonly issuedFor = signal<Person | null>(null);

  /**
   * How the customers list went, kept apart from the directory's own status.
   *
   * The dropdown said **"No customers yet. Add one first."** whenever the list was empty — which
   * is a lie when it is empty because the request failed. The founder would go and add a customer
   * he already has. Two different sentences, so the screen never claims to know the product is
   * empty when what it actually knows is that it could not ask. Found by the F7 review.
   */
  protected readonly customersStatus = signal<PlatformStatus>('ok');

  protected readonly customersUnreadable = computed(() => this.customersStatus() !== 'ok');

  protected readonly customerOptions = computed(() => sortCustomers(this.customers()));

  protected readonly addReasonKey = computed(() => platformReasonFor(this.addStatus()));

  /** Whether the form as it stands could possibly succeed. Mirrors the server's own rules. */
  protected readonly canSubmit = computed(() => {
    if (this.adding() || this.newName().trim() === '' || this.newEmail().trim() === '') {
      return false;
    }
    // A company admin without a company is a 400 the server would have to explain. The button
    // simply does not fire, which is the same answer arriving sooner.
    return this.tab() === 'super_admin' || this.newCompanyId() !== '';
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);

    // Both lists, together: the add dialog cannot offer a company to put an administrator in
    // unless the customers are already on hand, and asking for them only when the dialog opens
    // would make the first tap wait on a round trip.
    const [people, customers] = await Promise.all([
      this.platform.listPeople(),
      this.platform.listCustomers(),
    ]);

    this.people.set(people.people);
    this.customers.set(customers.customers);
    this.customersStatus.set(customers.status);
    // The people list is the screen; a customers list that failed on its own only costs the
    // dialog its dropdown, and saying "the server is unwell" over a directory that loaded fine
    // would be the screen claiming something it does not know.
    this.status.set(people.status);
    this.loading.set(false);
  }

  protected sortBy(key: PeopleSortKey): void {
    const current = this.sort();
    this.sort.set(
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: DEFAULT_DIRECTION[key] },
    );
  }

  protected sortedBy(key: PeopleSortKey): boolean {
    return this.sort().key === key;
  }

  protected ariaSort(key: PeopleSortKey): 'ascending' | 'descending' | 'none' {
    if (!this.sortedBy(key)) {
      return 'none';
    }
    return this.ascending() ? 'ascending' : 'descending';
  }

  /**
   * To one man's page: his link, and the switch that takes him out of service.
   *
   * The id goes in the path rather than the state, so a reload and a shared URL both land on the
   * same person — and so the route table, not this call site, owns the shape of the address.
   */
  protected openPerson(person: Person): void {
    void this.router.navigate(['/platform/user', person.id]);
  }

  /** To the customers. Both screens point at each other, so neither is a dead end. */
  protected openCompanies(): void {
    void this.router.navigate(['/platform/companies']);
  }

  protected openAdd(): void {
    this.resetAdd();
    this.addOpen.set(true);
  }

  protected cancelAdd(): void {
    this.addOpen.set(false);
    this.resetAdd();
  }

  /**
   * Switching tabs clears the company.
   *
   * Not tidiness: a company id left behind from the other tab is exactly the 400 the server
   * answers for a super admin who has one, and it would arrive as a refusal the founder could not
   * account for because the field that caused it is no longer on screen.
   */
  protected showTab(tab: AddTab): void {
    this.tab.set(tab);
    this.newCompanyId.set('');
    this.addStatus.set(null);
  }

  protected async onAdd(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) {
      return;
    }

    this.adding.set(true);
    this.addStatus.set(null);

    const result = await this.platform.createAdmin({
      role: this.tab(),
      displayName: this.newName(),
      email: this.newEmail(),
      companyId: this.tab() === 'company_admin' ? this.newCompanyId() : null,
    });

    this.adding.set(false);

    if (result.status !== 'ok') {
      this.addStatus.set(result.status);
      return;
    }

    // Held on screen rather than closed over: the link is the whole product of this dialog, and
    // there is no relay to send it — so a dialog that closed on success would destroy the one
    // value the founder came here for.
    this.issued.set(result.invite);
    this.issuedFor.set(result.person);
    void this.load();
  }

  /** Whether a failed create is worth another press, or whether the founder must reload first. */
  protected mustReload(): boolean {
    const status = this.addStatus();
    return status !== null && !serverAnswered(status);
  }

  // There was a copyLink() here, and its removal is the point of the change: there is no link on
  // this screen to copy any more. The set-password token is minted on the server, inside the job
  // that mails it, and never reaches a response body — so it never reaches a clipboard either.

  private resetAdd(): void {
    this.tab.set('company_admin');
    this.newName.set('');
    this.newEmail.set('');
    this.newCompanyId.set('');
    this.addStatus.set(null);
    this.adding.set(false);
    this.issued.set(null);
    this.issuedFor.set(null);
  }
}
