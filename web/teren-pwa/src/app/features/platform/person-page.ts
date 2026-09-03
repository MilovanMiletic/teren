import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import {
  Invite,
  Person,
  PlatformService,
  PlatformStatus,
  serverAnswered,
} from '../../core/platform/platform.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { SessionLink } from '../../ui/session-link';
import { SignInAgain } from '../../ui/sign-in-again';
import { platformReasonFor } from './platform-reason';
import { PersonChip, personChips } from './platform-people';

/**
 * A link, and the person it was minted for.
 *
 * The id is carried on the state rather than implied by it, for the same reason
 * `worker-page.ts` carries it: this is one route reused across people, so a late answer for the
 * man you have just navigated away from can otherwise paint his credential onto somebody else's
 * page. On the one screen in this surface that hands out a working credential, that is the worst
 * possible kind of wrong — it looks entirely plausible.
 */
interface IssuedLink {
  personId: string;
  invite: Invite;
}

/**
 * One account (`/platform/user/:userId`, F7): **what can be done to a single person.**
 *
 * ## Why a route and not a row action
 *
 * The same argument the office settled on 2026-09-01. Re-inviting mints a link that is a working
 * credential, and **it supersedes whatever live link that person already had** — so the moment a
 * list can show two of them, the screen can represent a state where two credentials are on the
 * glass at once and the founder is one mis-tap from sending the wrong one to the wrong person.
 * One URL, one man, one link makes the safe thing the only thing this code can express.
 *
 * ## Re-inviting an account that already has a password is not a small thing
 *
 * It is a `reset`, and `POST /auth/password` is unauthenticated and validates only the token —
 * so whoever holds that link can take the account. Plan §13.6 carries it as an open founder
 * decision rather than a solved problem, and this screen says what will happen before it happens
 * rather than presenting it as an ordinary button.
 *
 * ## What it deliberately cannot do
 *
 * No entry counts, no project detail, nothing about the person's work — the DTOs do not carry it
 * and `PlatformPrivacyTests` fails the build if one ever does. And **no delete**: disabling is a
 * stamp, because a person who authored evidence stays nameable for as long as that evidence does.
 */
@Component({
  selector: 'app-person-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeader,
    DatePipe,
    Icon,
    LanguageSwitcher,
    SessionLink,
    SignInAgain,
    TranslocoDirective,
  ],
  templateUrl: './person-page.html',
  styleUrl: './person-page.css',
})
export class PersonPage {
  private readonly platform = inject(PlatformService);
  private readonly router = inject(Router);
  private readonly actions = inject(ActionLogService);

  readonly userId = input.required<string>();

  protected readonly loading = signal(true);
  protected readonly person = signal<Person | null>(null);
  protected readonly status = signal<PlatformStatus>('ok');
  /** The server answered plainly that there is no such account — a fact, not a failure. */
  protected readonly missing = signal(false);

  protected readonly working = signal(false);
  protected readonly actionStatus = signal<PlatformStatus | null>(null);

  private readonly issuedState = signal<IssuedLink | null>(null);

  /**
   * The link, but only if it belongs to the man on screen.
   *
   * The second half of the freshness guard, and the cheap one: the write below already refuses a
   * late answer, and this refuses to *paint* one. Two lines of defence on a screen that hands out
   * credentials.
   */
  protected readonly issued = computed(() => {
    const state = this.issuedState();
    return state && state.personId === this.userId() ? state.invite : null;
  });

  protected readonly chips = computed<PersonChip[]>(() => {
    const person = this.person();
    return person ? personChips(person) : [];
  });

  protected readonly unconfirmed = computed(
    () => !this.loading() && this.status() !== 'ok' && !this.missing(),
  );

  protected readonly reasonKey = computed(() => platformReasonFor(this.status()));

  protected readonly actionReasonKey = computed(() => platformReasonFor(this.actionStatus()));

  /**
   * Whether a failed action leaves him able to press again, or having to reload first.
   *
   * Sharper here than anywhere else on this surface: **inviting supersedes a live link whether or
   * not the answer came back**. A founder told "it failed" after a request that in fact succeeded
   * will press again, and the second press retires a link that was already on its way to somebody.
   */
  protected mustReload(): boolean {
    const status = this.actionStatus();
    return status !== null && !serverAnswered(status);
  }

  /** A foreman has no password by construction, so there is no link to mint for him. */
  protected readonly canInvite = computed(() => {
    const person = this.person();
    return person !== null && person.role !== 'worker';
  });

  constructor() {
    // One effect on the input, exactly as `worker-page.ts` and `entry-detail.ts` do it: the route
    // reuses this component, so a different person arrives as a signal change rather than as a new
    // instance, and nothing may survive the change.
    effect(() => {
      const id = this.userId();
      this.reset();
      void this.load(id);
    });
  }

  private reset(): void {
    this.loading.set(true);
    this.person.set(null);
    this.missing.set(false);
    this.status.set('ok');
    this.issuedState.set(null);
    this.actionStatus.set(null);
    this.working.set(false);
  }

  /**
   * Read the directory and pick this man out of it.
   *
   * There is no per-account endpoint, and adding one to serve a screen that is already loading the
   * list for its other purposes would be a route to maintain for no gain. The filter is on the id,
   * so nothing is ever attributed to the wrong person.
   */
  protected async load(id = this.userId()): Promise<void> {
    this.loading.set(true);

    const result = await this.platform.listPeople();

    // A late answer for a man the founder has already navigated away from must not land on the one
    // now on screen.
    if (this.userId() !== id) {
      return;
    }

    const found = result.people.find((candidate) => candidate.id === id) ?? null;

    this.person.set(found);
    this.status.set(result.status);
    // "The list came back and he is not in it" is a fact. "The list did not come back" is not, and
    // saying "no such account" over a failed read would be the screen inventing a deletion.
    this.missing.set(result.status === 'ok' && found === null);
    this.loading.set(false);
  }

  /**
   * Mint a fresh link for this person.
   *
   * **This retires any live link he already had.** For an account that has never had a password
   * that is an ordinary invite; for one that has, it is a reset, and the screen says so before the
   * press rather than after.
   */
  protected async invite(): Promise<void> {
    const id = this.userId();
    if (this.working() || !this.canInvite()) {
      return;
    }

    this.working.set(true);
    this.actionStatus.set(null);

    const result = await this.platform.invite(id);

    if (this.userId() !== id) {
      return;
    }

    this.working.set(false);

    if (result.status !== 'ok' || !result.invite) {
      this.actionStatus.set(result.status === 'ok' ? 'unavailable' : result.status);
      // The outcome, never the link. A `trn_p_` token is a working credential to somebody's
      // account, and the whole point of D6 was that it never leaves the server; writing one into
      // a log table that Teren staff read would undo that in a single line.
      this.actions.record(ACTIONS.platformInviteSend, { outcome: 'fail' });
      return;
    }

    this.issuedState.set({ personId: id, invite: result.invite });
    this.actions.record(ACTIONS.platformInviteSend, { outcome: 'ok' });
  }

  protected async setDisabled(disabled: boolean): Promise<void> {
    const id = this.userId();
    if (this.working()) {
      return;
    }

    this.working.set(true);
    this.actionStatus.set(null);

    const result = await this.platform.setDisabled(id, disabled);

    if (this.userId() !== id) {
      return;
    }

    this.working.set(false);

    if (result.status !== 'ok') {
      this.actionStatus.set(result.status);
      this.actions.record(ACTIONS.platformUserDisable, {
        outcome: 'fail',
        detail: { disabled },
      });
      return;
    }

    // Which way it went is a boolean, so it is allowed to travel; who it was done to is not.
    // Withdrawing a man's access and restoring it are opposite acts and must not read alike.
    this.actions.record(ACTIONS.platformUserDisable, { outcome: 'ok', detail: { disabled } });

    // Reload rather than trusting the returned row: the list is where every other number on this
    // surface comes from, and one screen holding a different copy is how two of them disagree.
    void this.load(id);
  }

  // There was a copyLink() here. It is gone with the link it copied: the set-password token is
  // minted on the server, inside the job that mails it, and never reaches a response body — so it
  // can never reach a clipboard either.

  protected back(): void {
    void this.router.navigate(['/platform']);
  }
}
