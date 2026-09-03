import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import { Profile, ProfileService, ProfileStatus } from '../../core/identity/profile.service';
import { SessionService } from '../../core/session/session.service';
import { AppHeader } from '../../ui/app-header';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';

/**
 * Why the profile could not be confirmed, in the words this screen is allowed to use.
 *
 * A literal map rather than a concatenation, so `i18n.spec.ts` sees every key by reading the
 * source — the same reason `archive-page.ts` writes its partial-list reasons out in full.
 */
const REASON_KEYS: Record<Exclude<ProfileStatus, 'ok'>, string> = {
  offline: 'profile.reason.offline',
  unauthorized: 'profile.reason.unauthorized',
  not_configured: 'profile.reason.notConfigured',
  unavailable: 'profile.reason.unavailable',
};

/**
 * The worker's own account (`plans/profile-and-identity.md` §10.3, decision 10).
 *
 * ## What this screen is for
 *
 * **The username is the durable identity** (decision 7). It outlives any phone; the device
 * credential merely proves it. That is the fact this screen exists to make visible, and it is not
 * a technicality — it is what a foreman standing next to a phone that fell off a scaffold needs to
 * know in order to get his next one working. So the username is displayed as a value in its own
 * right, with the sentence that says what it is for, and the re-activation door sits underneath
 * it.
 *
 * ## Two sources, and the rule between them
 *
 * `/api/me` is the truth. The session this phone stored at activation is what it knows without a
 * network. The screen prefers the server and **falls back to the phone**, because a foreman in a
 * basement asking "what is my username again" must not meet a spinner or an empty card.
 *
 * The rule that makes that honest: **whenever the server was not reached, the screen says so** —
 * once, plainly, above the data. This product has shipped a screen claiming to know something it
 * did not more than once; a profile is exactly the kind of screen where a stale company name would
 * be believed. There is no third state where it shows old data silently.
 *
 * When there is no server answer *and* no stored session — which is every demo phone still running
 * on the build-time token, and any phone whose `localStorage` was cleared — the screen shows
 * nothing about the man at all and says why. An empty profile and a profile that failed to load
 * look identical unless one of them says which it is.
 *
 * ## It must not assume a worker
 *
 * `/api/me` answers for all three roles, and `username`, `company` and `device` are null for a
 * super admin by construction (§4, `ck_app_user_company_scope`). Every block here is conditional
 * on its own value, so an admin gets a smaller screen rather than a broken one.
 *
 * ## What it deliberately does not have
 *
 * **A sign-out control.** PROJECT.md principle 3: nothing is ever deleted locally, and a day of
 * unsent evidence outranks a wrong name on a screen. The answer to "this is not me" is
 * re-activation through `/activate` — which replaces the credential and touches no evidence — so
 * that is the affordance this screen offers. **A phone the *server* refuses does now sign itself
 * out** (founder decision, 2026-09-03), and that is a different thing entirely: nobody presses it,
 * and it still deletes nothing.
 *
 * **A revocation check.** This screen never asks whether the credential is still good, and the
 * guard on this route stays a pure boolean over one signal read (hazard H3). What it does is make
 * the ordinary calls any screen makes — and the first of those to be answered 401 is what triggers
 * the sign-out, one layer down in `TerenApiClient`. The comment here used to end "a revoked device
 * keeps reaching the record button... never as a locked door"; that was decision 8 and the founder
 * reversed it on 2026-09-03.
 */
@Component({
  selector: 'app-profile-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, Icon, LanguageSwitcher, TranslocoDirective],
  templateUrl: './profile-page.html',
  styleUrl: './profile-page.css',
})
export class ProfilePage {
  private readonly router = inject(Router);
  private readonly profiles = inject(ProfileService);
  private readonly sessions = inject(SessionService);

  /** What this phone knows with no network: written once, at activation. */
  protected readonly session = this.sessions.session;

  protected readonly loading = signal(true);
  protected readonly status = signal<ProfileStatus>('ok');
  private readonly remote = signal<Profile | null>(null);

  /**
   * The role, only ever as the server said it.
   *
   * Deliberately not inferred from the stored session. A device credential does belong to a worker
   * today, but "this phone holds a session, therefore he is a worker" is the app deciding
   * something it was not told — and this is the one screen whose whole job is to report what is
   * actually the case.
   */
  protected readonly role = computed(() => this.remote()?.role ?? null);

  protected readonly displayName = computed(
    () => this.remote()?.displayName ?? this.session()?.displayName ?? null,
  );
  protected readonly username = computed(
    () => this.remote()?.username ?? this.session()?.username ?? null,
  );
  protected readonly companyName = computed(
    () => this.remote()?.companyName ?? this.session()?.companyName ?? null,
  );
  /** Only the server knows what the phone is called; the session stores an id, not a name. */
  protected readonly deviceName = computed(() => this.remote()?.deviceName ?? null);
  /** A local fact, and the only one the server has no opinion about. */
  protected readonly activatedAt = computed(() => this.session()?.activatedAt ?? null);

  /** Whether there is anything true to show. Nothing here is a placeholder. */
  protected readonly known = computed(
    () => this.displayName() !== null || this.username() !== null || this.companyName() !== null,
  );

  /** The server was not reached, so what is on screen — if anything — is the phone's memory. */
  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');

  protected readonly reasonKey = computed(() => {
    const status = this.status();
    return status === 'ok' ? null : REASON_KEYS[status];
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const result = await this.profiles.load();
    this.status.set(result.status);
    this.remote.set(result.profile);
    this.loading.set(false);
  }

  protected back(): void {
    void this.router.navigate(['/']);
  }

  /**
   * The answer to "this is not me", and to "my phone is broken and this is the new one".
   *
   * It navigates and does nothing else. **It must never clear Dexie**: an unsent day of evidence
   * outranks a wrong name on a screen (PROJECT.md principle 3), and `/activate` replaces the
   * credential without touching a single row.
   */
  protected reactivate(): void {
    void this.router.navigate(['/activate']);
  }
}
