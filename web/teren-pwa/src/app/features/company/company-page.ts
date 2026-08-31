import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

import {
  ActivationCode,
  CompanyService,
  CompanyStatus,
  Phone,
  Worker,
  serverAnswered,
} from '../../core/company/company.service';
import { AdminSessionService } from '../../core/session/admin-session.service';
import { AppHeader } from '../../ui/app-header';
import { Icon } from '../../ui/icon';
import { LanguageSwitcher } from '../../ui/language-switcher';

/**
 * Why the company could not be read, in the words this screen is allowed to use.
 *
 * A literal map rather than a concatenation, so `i18n.spec.ts` sees every key by reading the
 * source — the same reason `profile-page.ts` and `archive-page.ts` write theirs out in full. The
 * `Record<Exclude<CompanyStatus, 'ok'>, string>` is what the compiler checks: a new status does
 * not build until it has a sentence, and `ok` is excluded because "it worked" is not a reason.
 */
export const COMPANY_REASON_KEYS: Record<Exclude<CompanyStatus, 'ok'>, string> = {
  offline: 'company.reason.offline',
  signedOut: 'company.reason.signedOut',
  forbidden: 'company.reason.forbidden',
  notSignedIn: 'company.reason.notSignedIn',
  refused: 'company.reason.refused',
  unavailable: 'company.reason.unavailable',
};

/** The code, the message and how the last look at them went — for **one** worker at a time. */
interface CodeState {
  workerId: string;
  loading: boolean;
  status: CompanyStatus;
  code: ActivationCode | null;
  shareText: string | null;
  /** The server answered plainly that there is nothing he could type. Information, not failure. */
  noLiveCode: boolean;
}

/** What was just put on the clipboard, so the screen can confirm the right one. */
type Copied = 'code' | 'message' | null;

/** One shared empty array, so a worker with no phone does not churn `@for` on every check. */
const NO_PHONES: readonly Phone[] = [];

/**
 * The company admin's one screen (`plans/profile-and-identity.md` §10.3, decisions 3, 9, 10, 13).
 *
 * ## What it replaces
 *
 * A `psql` session. Until this screen existed the only way to give a foreman an activation code
 * was to insert a row by hand — which is how activation was proved end to end on 2026-08-31, and
 * which is not a thing a customer can do. Everything here exists to make that one act — *this man,
 * this code, into his chat* — take a minute.
 *
 * ## The constraint that shapes every decision below: one worker at a time
 *
 * Decision 13, and it is a security property rather than a preference. A code plus a **username**
 * is what activates a phone, so a code alone is worth little; but a message carrying six codes
 * and six names, pasted into a site group chat, lets any man in that chat activate a phone under
 * another man's name — and every entry he then records is signed with that name. Attribution is
 * the thing the whole identity model exists to establish, so there is deliberately **no bulk
 * export, and no state in which two workers' codes are on the screen at once**: {@link revealed}
 * holds at most one worker id, and {@link codeState} holds at most one code. The server's own
 * `GET /api/workers/{id}/share-text` is what makes the right thing the easy thing — one worker's
 * ready-made Serbian message, in *his* language, for the admin to paste into *his* chat.
 *
 * ## Reading a code never spends it
 *
 * `CompanyService.readCode` is a GET and nothing else. The admin sends a code by Viber and taps
 * back an hour later to look at it; if looking re-issued, it would kill the code the man is at
 * that moment typing. That is precisely why the database stores the plaintext of a *live* code
 * (§5) instead of making "see the code" mean "issue a new one" — and why issuing has to be asked
 * for, twice, when a live code already exists.
 *
 * ## Three real layouts, and the hard one is 390
 *
 * The plan names a worker list with per-row actions at 390 px as one of the two hardest layouts in
 * this project, and the answer is not a shrunken table. Each worker is a **card that opens**: the
 * summary is a name, a username and two or three chips; the actions appear inside the opened card
 * as full-width controls a gloved thumb can hit. Exactly one card is open at a time, which is the
 * same mechanism the one-worker-at-a-time rule already requires — the layout and the security
 * property want the same thing.
 *
 * ## Honest failure, per call
 *
 * Nothing here says "something went wrong". `CompanyStatus` keeps *offline*, *your sign-in has
 * expired*, *your role may not do this* and *the server is unwell* apart, because the remedy
 * differs and offering the wrong one is a screen lying. And where the server gave **no verdict at
 * all** ({@link serverAnswered}), a mutation is never reported as failed: a revoke that timed out
 * may well have revoked, and an issue that timed out may well have superseded the code the man is
 * holding, so the screen says it could not confirm and asks him to reload before acting again.
 */
@Component({
  selector: 'app-company-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DatePipe, Icon, LanguageSwitcher, TranslocoDirective],
  templateUrl: './company-page.html',
  styleUrl: './company-page.css',
})
export class CompanyPage {
  private readonly router = inject(Router);
  private readonly company = inject(CompanyService);
  private readonly admins = inject(AdminSessionService);

  /** Who is signed in, from the credential itself — no network, and true before the first paint. */
  protected readonly session = this.admins.session;

  protected readonly loading = signal(true);
  protected readonly workers = signal<Worker[]>([]);
  protected readonly devices = signal<Phone[]>([]);
  /** How the last look at the list went. `ok` is the only value that lets the screen claim it. */
  protected readonly status = signal<CompanyStatus>('ok');

  /** The one worker whose code may be on screen. Never a set — see the class comment. */
  protected readonly revealed = signal<string | null>(null);
  protected readonly codeState = signal<CodeState | null>(null);

  /** The phone an admin has asked to revoke and not yet confirmed. */
  protected readonly revoking = signal<string | null>(null);
  protected readonly revokeBusy = signal(false);
  protected readonly revokeFailure = signal<CompanyStatus | null>(null);

  /** Set while a fresh code has been asked for but not yet confirmed — it supersedes a live one. */
  protected readonly reissuing = signal(false);
  protected readonly codeBusy = signal(false);

  protected readonly copied = signal<Copied>(null);
  /**
   * The clipboard refused or does not exist.
   *
   * Not a failure worth an apology: the code and the message are on screen as selectable text
   * either way, and a hint that says so is more use than an error. `navigator.clipboard` is absent
   * in insecure contexts and can reject when the document is not focused.
   */
  protected readonly copyFailed = signal(false);

  protected readonly addOpen = signal(false);
  protected readonly newName = signal('');
  protected readonly newEmail = signal('');
  protected readonly addBusy = signal(false);
  protected readonly addFailure = signal<CompanyStatus | null>(null);
  protected readonly addConflict = signal<'username' | 'email' | null>(null);

  protected readonly companyName = computed(() => this.session()?.companyName ?? null);

  /** The list could not be confirmed with the server, so it is not a list of his company. */
  protected readonly unconfirmed = computed(() => !this.loading() && this.status() !== 'ok');

  protected readonly reasonKey = computed(() => this.reasonFor(this.status()));

  /** Phones that can still record, across the company. The number an owner actually asks about. */
  protected readonly activePhoneCount = computed(
    () => this.devices().filter((device) => device.revokedAt === null).length,
  );

  constructor() {
    void this.load();
  }

  /**
   * Both lists, in parallel, and neither can take the other down.
   *
   * The workers list is the screen; the devices list decorates it. So the screen's status is the
   * workers' status, and a devices call that failed on its own leaves the phones section quiet
   * rather than turning a readable list of men into an error page.
   */
  protected async load(): Promise<void> {
    this.loading.set(true);
    const [workers, devices] = await Promise.all([
      this.company.listWorkers(),
      this.company.listDevices(),
    ]);
    this.workers.set(workers.workers);
    this.devices.set(devices.devices);
    this.status.set(workers.status);
    this.loading.set(false);
  }

  /**
   * The company's phones, grouped by the man they belong to, live ones first — the order the list
   * is read in to answer "which of these am I taking away".
   *
   * A computed map rather than a filter per call: the template asks for one worker's phones three
   * times while drawing his card, and a fresh array on every ask would re-run `@for`'s diff for
   * nothing.
   */
  private readonly phonesByWorker = computed(() => {
    const grouped = new Map<string, Phone[]>();
    for (const phone of this.devices()) {
      if (!phone.userId) {
        continue;
      }
      grouped.set(phone.userId, [...(grouped.get(phone.userId) ?? []), phone]);
    }
    for (const phones of grouped.values()) {
      phones.sort((left, right) => Number(left.revokedAt !== null) - Number(right.revokedAt !== null));
    }
    return grouped;
  });

  protected phonesOf(workerId: string): Phone[] {
    return this.phonesByWorker().get(workerId) ?? (NO_PHONES as Phone[]);
  }

  protected isOpen(workerId: string): boolean {
    return this.revealed() === workerId;
  }

  /**
   * Open one worker, closing whoever was open.
   *
   * The single assignment is the mechanism behind decision 13: there is no code path that leaves
   * two workers' codes on the screen, because there is only one place a code can be.
   */
  protected async open(worker: Worker): Promise<void> {
    if (this.revealed() === worker.id) {
      this.close();
      return;
    }

    this.close();
    this.revealed.set(worker.id);
    this.codeState.set({
      workerId: worker.id,
      loading: true,
      status: 'ok',
      code: null,
      shareText: null,
      noLiveCode: false,
    });

    const result = await this.company.readCode(worker.id);

    // He may have closed the card, or opened another man's, while this was in flight. Writing the
    // answer anyway would put one worker's code under another worker's name.
    if (this.revealed() !== worker.id) {
      return;
    }

    this.codeState.set({
      workerId: worker.id,
      loading: false,
      status: result.status,
      code: result.code,
      shareText: result.shareText,
      noLiveCode: result.noLiveCode,
    });
  }

  protected close(): void {
    this.revealed.set(null);
    this.codeState.set(null);
    this.revoking.set(null);
    this.revokeFailure.set(null);
    this.reissuing.set(false);
    this.copied.set(null);
    this.copyFailed.set(false);
  }

  /** Ask before superseding a code the man may already be holding. */
  protected askReissue(): void {
    this.reissuing.set(true);
  }

  protected cancelReissue(): void {
    this.reissuing.set(false);
  }

  /**
   * Issue a fresh code.
   *
   * Reached directly when he has none — there is nothing to destroy — and only through
   * {@link askReissue} when he has one, because issuing kills the code he is holding.
   */
  protected async issue(worker: Worker): Promise<void> {
    if (this.codeBusy()) {
      return;
    }
    this.codeBusy.set(true);
    this.reissuing.set(false);
    this.copied.set(null);

    const result = await this.company.issueCode(worker.id);
    this.codeBusy.set(false);

    if (this.revealed() !== worker.id) {
      // He navigated away mid-flight. The code exists on the server; the list reload below is what
      // makes that visible rather than this screen pretending nothing happened.
      void this.load();
      return;
    }

    this.codeState.set({
      workerId: worker.id,
      loading: false,
      status: result.status,
      code: result.code,
      shareText: result.shareText,
      noLiveCode: false,
    });

    if (result.status === 'ok') {
      // `has_live_activation_code` on the list row is now stale for this man, and it is the cue
      // that decides whether the next admin to look reads a code or issues one over it.
      void this.load();
    }
  }

  protected askRevoke(device: Phone): void {
    this.revoking.set(device.id);
    this.revokeFailure.set(null);
  }

  protected cancelRevoke(): void {
    this.revoking.set(null);
    this.revokeFailure.set(null);
  }

  /**
   * Withdraw a phone's credential.
   *
   * **Never reported as failed when the server did not answer.** Revoking is idempotent, so a
   * retry is harmless — but telling an owner "it did not work" about a revoke that in fact went
   * through would leave him believing a phone he has taken away can still record.
   */
  protected async revoke(device: Phone): Promise<void> {
    if (this.revokeBusy()) {
      return;
    }
    this.revokeBusy.set(true);
    const result = await this.company.revokeDevice(device.id);
    this.revokeBusy.set(false);

    if (result.status === 'ok') {
      this.revoking.set(null);
      this.revokeFailure.set(null);
      await this.load();
      return;
    }

    this.revokeFailure.set(result.status);
  }

  /** The sentence for a status, or null when there is nothing to explain. */
  protected reasonFor(status: CompanyStatus | null): string | null {
    return status === null || status === 'ok' ? null : COMPANY_REASON_KEYS[status];
  }

  /** Whether a failure happened without the server ever giving a verdict. */
  protected unconfirmedAction(status: CompanyStatus | null): boolean {
    return status !== null && !serverAnswered(status);
  }

  protected onCopyCode(): void {
    const code = this.codeState()?.code?.code;
    if (code) {
      void this.copy(code, 'code');
    }
  }

  protected onCopyMessage(): void {
    const message = this.codeState()?.shareText;
    if (message) {
      void this.copy(message, 'message');
    }
  }

  private async copy(value: string, what: Exclude<Copied, null>): Promise<void> {
    this.copyFailed.set(false);
    try {
      await navigator.clipboard.writeText(value);
      this.copied.set(what);
    } catch {
      // An insecure context, a browser without the API, or a document that lost focus. The value
      // is on screen and selectable either way, so this is a hint and not an error.
      this.copied.set(null);
      this.copyFailed.set(true);
    }
  }

  protected openAdd(): void {
    this.addOpen.set(true);
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected cancelAdd(): void {
    this.addOpen.set(false);
    this.newName.set('');
    this.newEmail.set('');
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected onName(value: string): void {
    this.newName.set(value);
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected onEmail(value: string): void {
    this.newEmail.set(value);
    this.addFailure.set(null);
    this.addConflict.set(null);
  }

  protected onAdd(event: Event): void {
    event.preventDefault();
    void this.add();
  }

  /**
   * Add a foreman, and open his first code straight away.
   *
   * Adding a man you cannot then activate is not a finished action, which is why the endpoint
   * returns the worker and his first code together — and why this ends by opening his card rather
   * than by congratulating the admin and leaving him to find the button.
   */
  protected async add(): Promise<void> {
    const name = this.newName().trim();
    if (this.addBusy() || name.length === 0) {
      return;
    }

    this.addBusy.set(true);
    this.addFailure.set(null);
    this.addConflict.set(null);

    const result = await this.company.addWorker(name, this.newEmail());
    this.addBusy.set(false);

    if (result.status !== 'ok' || !result.worker) {
      this.addFailure.set(result.status);
      this.addConflict.set(result.conflict);
      return;
    }

    const worker = result.worker;
    this.addOpen.set(false);
    this.newName.set('');
    this.newEmail.set('');

    await this.load();

    // His code is already in the response, so this opens on the code rather than fetching it
    // again — and it is the *only* code on screen, exactly as every other reveal is.
    this.revealed.set(worker.id);
    this.codeState.set({
      workerId: worker.id,
      loading: false,
      status: 'ok',
      code: result.code,
      shareText: null,
      noLiveCode: result.code === null,
    });

    if (result.code) {
      // The ready-made message is a second call and its failure costs nothing: the code is in
      // hand, and the admin can still read it out.
      const withText = await this.company.readCode(worker.id);
      if (this.revealed() === worker.id && withText.status === 'ok' && withText.shareText) {
        this.codeState.update((state) =>
          state ? { ...state, shareText: withText.shareText, code: withText.code ?? state.code } : state,
        );
      }
    }
  }

  /**
   * Sign out of the office.
   *
   * **The one sign-out in this product, and it deletes no evidence.** A worker has none
   * (PROJECT.md principle 3: a day of unsent entries outranks a wrong name on a screen); an admin
   * session is a password-backed credential on what is often a shared office tablet, guards
   * nothing local, and removing it touches exactly one `localStorage` row — never Dexie.
   */
  protected signOut(): void {
    this.admins.signOut();
    void this.router.navigate(['/login']);
  }
}
