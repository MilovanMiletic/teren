import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { Account, CompanyService, CompanyStatus } from '../../core/company/company.service';
import { AdminSessionService } from '../../core/session/admin-session.service';
import { AppHeader } from '../../ui/app-header';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { SessionLink } from '../../ui/session-link';
import { companyReasonFor } from './company-reason';

/**
 * The company admin's own account (`/company/profile`).
 *
 * ## Why this screen exists
 *
 * **He was the one person in the product with no page.** A foreman has `/profile`; a super admin
 * opens his own row in the platform directory like anybody else's. The owner of a customer company
 * had a single static line at the top of his own people list — his name, and the words "signs in
 * with a password" — and no way to see the address he signs in with, when the account was opened,
 * or when it was last used. This is the missing third of decision 10, which gives *each role* its
 * own profile surface.
 *
 * ## Where the facts come from, and the rule between the two sources
 *
 * `GET /api/me` with the **admin** bearer, through `CompanyGateway` — the same seam every other
 * call on this surface goes through, so there is no path by which a screen for the office could
 * reach the phone's answer or the other way round.
 *
 * That route is not a convenience here, it is the only source available: he appears in no list he
 * may read. `/api/workers` is `WorkersOf(companyId)` — the men who record — and excludes him by
 * construction; `/api/platform/users` answers 403 to every role but Teren staff.
 *
 * The second source is the credential this browser stored when he signed in, which is why the
 * screen can name him with no network at all. **The rule is `profile-page.ts`'s, unchanged:
 * prefer the server, fall back to the session, and whenever the server was not reached say so —
 * once, plainly, above the data.** A screen that quietly showed a company name from a sign-in
 * three weeks ago would be believed.
 *
 * ## What it deliberately does not have
 *
 * **A sign-out of its own.** `session-link.ts` is already in this screen's chrome at every width —
 * the header from 768 up, the compact bar below it — and its whole argument is that sign-in and
 * sign-out are one affordance with one place. A second one here would be a second place to look.
 *
 * **A password change.** There is no authenticated route for it: `POST /auth/password` validates a
 * mailed `trn_p_` token and nothing else. Offering a control that could not work is worse than
 * not offering one, and the honest answer today is his super admin's invite.
 *
 * **Anything editable.** `PATCH` for an admin's own row is not built (`IdentityScope.cs`), and a
 * form that silently discarded what he typed is the failure mode this product keeps writing tests
 * against.
 *
 * ## Three layouts
 *
 *   compact   <768      one column: who he is, then what he can change.
 *   medium    768–1023  the same order on the 640 column, detail rows two-up.
 *   expanded  ≥1024     identity and details take 7 of 12 columns, language and the session 5.
 */
@Component({
  selector: 'app-account-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, Icon, LanguageSwitcher, SessionLink, TranslocoDirective],
  templateUrl: './account-page.html',
  styleUrl: './account-page.css',
})
export class AccountPage {
  private readonly company = inject(CompanyService);
  private readonly admins = inject(AdminSessionService);
  private readonly router = inject(Router);

  /** What this browser knows with no network: written once, at sign-in. */
  protected readonly session = this.admins.session;

  protected readonly loading = signal(true);
  protected readonly status = signal<CompanyStatus>('ok');
  private readonly remote = signal<Account | null>(null);

  /**
   * The role, only ever as the server said it.
   *
   * Deliberately not taken from the stored session, which also carries one. The session's copy is
   * what this browser was told at sign-in and would go on saying `company_admin` after a super
   * admin changed it; this is the one screen whose whole job is to report what is actually the
   * case, so where the two could differ it shows the server's or nothing.
   */
  protected readonly role = computed(() => this.remote()?.role ?? null);

  protected readonly displayName = computed(
    () => this.remote()?.displayName ?? this.session()?.displayName ?? null,
  );
  protected readonly companyName = computed(
    () => this.remote()?.companyName ?? this.session()?.companyName ?? null,
  );
  /** His login identity, and the admin's analogue of a foreman's username. Server-only. */
  protected readonly email = computed(() => this.remote()?.email ?? null);
  /** Null for an admin by constraint (§4). Rendered only if a server ever sends one. */
  protected readonly username = computed(() => this.remote()?.username ?? null);
  protected readonly createdAt = computed(() => this.remote()?.createdAt ?? null);
  protected readonly lastLoginAt = computed(() => this.remote()?.lastLoginAt ?? null);

  /** Local facts about this browser's credential. The server has no opinion about either. */
  protected readonly signedInAt = computed(() => this.session()?.signedInAt ?? null);
  protected readonly expiresAt = computed(() => this.session()?.expiresAt ?? null);

  /** Whether there is anything true to show. Nothing on this screen is a placeholder. */
  protected readonly known = computed(
    () => this.displayName() !== null || this.email() !== null || this.companyName() !== null,
  );

  /** The server was not reached, so what is on screen — if anything — is this browser's memory. */
  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');

  protected readonly reasonKey = computed(() => companyReasonFor(this.status()));

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    const result = await this.company.loadAccount();
    this.status.set(result.status);
    this.remote.set(result.account);
    this.loading.set(false);
  }

  /** Back to his people. The one door, at every width — the header's office control is off. */
  protected back(): void {
    void this.router.navigate(['/company']);
  }
}
