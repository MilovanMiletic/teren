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
  ActivationCode,
  CompanyService,
  CompanyStatus,
  Phone,
  Worker,
  serverAnswered,
} from '../../core/company/company.service';
import { AdminSessionService } from '../../core/session/admin-session.service';
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { Icon } from '../../ui/icon';
import { InfoPopover } from '../../ui/info-popover';
import { LanguageSwitcher } from '../../ui/language-switcher';
import { ModalSheet } from '../../ui/modal-sheet';
import { SessionLink } from '../../ui/session-link';
import { companyReasonFor } from './company-reason';
import { StatusChip, workerChips } from './people';

/**
 * The code, the message and how the last look at them went — for **one** worker at a time.
 *
 * Exported so `worker-page.spec.ts` can construct the one write this component's guards make
 * unreachable — a state belonging to another man — and prove that {@link WorkerPage.code} refuses
 * to paint it. A defence in depth with no witness is a comment, and this file has already been
 * caught carrying two of those.
 */
export interface CodeState {
  /**
   * The man this state was fetched for.
   *
   * Carried on the state rather than implied by it, because `/company/worker/:workerId` is one
   * route and Angular reuses this component across workers. See {@link WorkerPage.code}.
   */
  workerId: string;
  loading: boolean;
  status: CompanyStatus;
  code: ActivationCode | null;
  shareText: string | null;
  /** The server answered plainly that there is nothing he could type. Information, not failure. */
  noLiveCode: boolean;
  /**
   * This state is the result of an **issue**, not of a read.
   *
   * The two failures are not the same failure and must not share a sentence. A read that did not
   * answer changed nothing, so "the code could not be read" is the truth. An issue that did not
   * answer **may already have superseded the code the man is holding** — telling the admin it
   * failed invites him to press again, and the second press supersedes a code that exists. So the
   * screen has to know which act it is reporting on. {@link serverAnswered} decides the rest.
   */
  afterIssue: boolean;
}

/** What was just put on the clipboard, so the screen can confirm the right one. */
type Copied = 'code' | 'message' | null;

/**
 * One foreman: his code, the message that carries it, his phones, and the way to take one away.
 *
 * ## Why this is a route and not an expanded card
 *
 * It was a card that opened inside the people list until 2026-09-01, and everything below was
 * inside it: the code, the "good until" line, an explanatory paragraph and two full-width buttons.
 * At 375 px a single foreman produced a scroll nobody could read; ten would have been unusable.
 * The founder's note was "this genuinely now is a bad UI".
 *
 * Moving it out bought more than room. **Decision 13 — never two men's codes on one screen — used
 * to be arithmetic**: one worker id in `revealed`, one `codeState`, and a careful reset on every
 * open. It held, but "two codes on screen" was a state the component could represent, so it was one
 * edit away from not holding. One URL is one man; there is no state in this component that can hold
 * a second code, and the list it came from cannot render a code at all. The property is now
 * structural, and that is a genuine improvement rather than a relocation.
 *
 * The reason it matters, restated because it is easy to lose: **a code plus a username activates a
 * phone.** A message carrying several names and codes, pasted into a site group chat, lets any man
 * in that chat record evidence signed with another man's name — and attribution is the thing the
 * whole identity model exists to establish.
 *
 * ## Reading a code never spends it
 *
 * `CompanyService.readCode` is a GET and nothing else, which is why this page can show the code the
 * moment it opens. The admin sends it by Viber and comes back an hour later to read it aloud; if
 * looking re-issued, it would kill the code the man is at that moment typing. That is why the
 * database keeps the plaintext of a *live* code (§5) instead of making "see the code" mean "issue a
 * new one" — and why issuing has to be asked for, twice, when a live code already exists.
 *
 * ## The freshness guard, and why it is worse here than on the archive
 *
 * `/company/worker/:workerId` is **one** route, so Angular reuses this component instance across
 * workers: only the input signal changes and the effect below re-runs. An in-flight read for worker
 * A can therefore resolve *after* the admin has moved to worker B. On the archive that defect (fixed
 * 2026-09-01) put one day's header on another day's record. Here it would put **one man's live
 * activation code under another man's name** — and the admin would paste it into that man's chat,
 * where it would activate a phone signed with somebody else's name. So every asynchronous answer
 * checks that the input still names the worker it was asked about, and {@link code} refuses on the
 * way out as well.
 *
 * ## Honest failure, per call
 *
 * `CompanyStatus` keeps *offline*, *your sign-in has expired*, *your role may not do this* and *the
 * server is unwell* apart, because the remedy differs. And where the server gave **no verdict at
 * all** ({@link serverAnswered}), a mutation is never reported as failed: a revoke that timed out
 * may well have revoked, and an issue that timed out may well have superseded the code the man is
 * holding, so the screen says it could not confirm and asks him to reload before acting again.
 */
@Component({
  selector: 'app-worker-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppHeader,
    DatePipe,
    Icon,
    InfoPopover,
    LanguageSwitcher,
    ModalSheet,
    SessionLink,
    TranslocoDirective,
  ],
  templateUrl: './worker-page.html',
  styleUrl: './worker-page.css',
})
export class WorkerPage {
  private readonly company = inject(CompanyService);
  private readonly admins = inject(AdminSessionService);
  private readonly router = inject(Router);
  /**
   * The action log (D5).
   *
   * Issuing is recorded by hand because the outcome is the whole story: an issue that got no
   * verdict may already have superseded the code the man is holding, and "he pressed it" without
   * "and it failed" is the one shape of log line that would send an admin looking in the wrong
   * place. Copying and unfolding declare themselves in the template.
   */
  private readonly actions = inject(ActionLogService);

  /** From the route (`withComponentInputBinding`), so a reload lands on the same man. */
  readonly workerId = input.required<string>();

  protected readonly loading = signal(true);
  protected readonly worker = signal<Worker | null>(null);
  protected readonly status = signal<CompanyStatus>('ok');
  /**
   * The company's list came back and this id is not in it.
   *
   * A rendered state, not an error — the same way `ArchiveService.getEntry` models a 404. It covers
   * both "no such worker" and "another company's worker", which is deliberate: the server's own
   * doctrine is that a foreign id is indistinguishable from one that does not exist, and the client
   * must not invent a distinction the API refuses to make.
   */
  protected readonly missing = signal(false);

  protected readonly codeState = signal<CodeState | null>(null);

  private readonly devices = signal<Phone[]>([]);
  /**
   * How the phone list went, kept apart from the man's own status.
   *
   * Because "he has no phone joined yet" and "the phone list could not be read" are opposite
   * claims about the same empty card, and on this screen the second one decides whether an owner
   * believes a handset that walked off site is still able to record.
   */
  protected readonly devicesStatus = signal<CompanyStatus>('ok');

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

  /**
   * Whether his details are on screen.
   *
   * A dialog rather than a card in a rail (founder, 2026-09-01): every fact in it is reference
   * material an admin looks up rarely, and it was taking a fifth of a 1280 screen away from the two
   * things he came here to do. Closed on every navigation by {@link reset}, because a dialog left
   * open across a change of worker would describe the man he just left.
   */
  protected readonly detailsOpen = signal(false);

  protected readonly companyName = computed(() => this.admins.session()?.companyName ?? null);

  /**
   * The code state, **only if it belongs to the man on screen**.
   *
   * The second half of the freshness guard, and the cheap one: the writes below already refuse a
   * late answer, and this refuses to paint one. Two lines of defence on the one screen in the
   * product that can hand out a working credential.
   */
  protected readonly code = computed(() => {
    const state = this.codeState();
    return state && state.workerId === this.workerId() ? state : null;
  });

  /** The chips the list showed for this man, so the two screens say the same thing about him. */
  protected readonly chips = computed<StatusChip[]>(() => {
    const worker = this.worker();
    return worker ? workerChips(worker) : [];
  });

  /**
   * His phones, live ones first — the order the list is read in to answer "which of these am I
   * taking away".
   *
   * Filtered from the company's device list because there is no per-worker device endpoint. The
   * filter is on `userId`, so a phone belonging to nobody (a provisioned demo device) is not
   * silently attributed to the man whose page happens to be open.
   */
  protected readonly phones = computed(() => {
    const id = this.workerId();
    return this.devices()
      .filter((phone) => phone.userId === id)
      .sort((left, right) => Number(left.revokedAt !== null) - Number(right.revokedAt !== null));
  });

  /** The read could not be confirmed with the server, so what is on screen is not his company. */
  protected readonly unconfirmed = computed(
    () => !this.loading() && this.status() !== 'ok' && !this.missing(),
  );

  protected readonly reasonKey = computed(() => companyReasonFor(this.status()));

  constructor() {
    // One effect on the input, exactly as `entry-detail.ts` does it: the route reuses this
    // component, so a new worker arrives as a signal change rather than as a new instance.
    effect(() => {
      const id = this.workerId();
      this.reset();
      void this.load(id);
    });
  }

  /** Everything on screen belongs to the man we are leaving. Nothing survives the change. */
  private reset(): void {
    this.loading.set(true);
    this.worker.set(null);
    this.status.set('ok');
    this.missing.set(false);
    this.codeState.set(null);
    this.devices.set([]);
    this.devicesStatus.set('ok');
    this.revoking.set(null);
    this.revokeFailure.set(null);
    this.reissuing.set(false);
    this.copied.set(null);
    this.copyFailed.set(false);
    /*
     * **The busy flags belong to the man being left, not to the screen.** Navigate away from A
     * mid-issue and without these two lines B renders "Pravljenje koda…" over a disabled button
     * describing a call that was never about him — and if that request hangs, B is dead-buttoned
     * until a reload. The late `set(false)` in {@link issue} and {@link revoke} now happens *after*
     * the freshness guard, so clearing them here cannot be undone by the call that is still in
     * flight for somebody else.
     */
    this.codeBusy.set(false);
    this.revokeBusy.set(false);
    this.detailsOpen.set(false);
  }

  /**
   * The man, his code and his phones — three calls, and none of them can take the others down.
   *
   * The man is the screen: his read decides the status and the not-found state. The code and the
   * phones each report their own failure in their own card, because "the code could not be read"
   * and "the phone list could not be read" send an admin to two different remedies.
   */
  protected async load(id: string): Promise<void> {
    this.loading.set(true);
    void this.readWorker(id);
    void this.readCode(id);
    void this.readDevices(id);
  }

  /** The man himself: the read that decides the status and the not-found state. */
  private async readWorker(id: string): Promise<void> {
    const result = await this.company.getWorker(id);

    // The freshness guard. He may have gone back to the list and opened another man while this was
    // in flight; writing the answer anyway would put one worker's name over another worker's code.
    if (this.workerId() !== id) {
      return;
    }

    this.worker.set(result.worker);
    this.status.set(result.status);
    this.missing.set(result.missing);
    this.loading.set(false);
  }

  private async readDevices(id: string): Promise<void> {
    const result = await this.company.listDevices();
    if (this.workerId() !== id) {
      return;
    }
    this.devices.set(result.devices);
    this.devicesStatus.set(result.status);
  }

  /**
   * Re-read the man after a mutation, and **only overwrite him if the read answered**.
   *
   * {@link readWorker} is the page's own load: a failure there is the page's failure and the screen
   * says so. This is a background refresh after an issue or a revoke, and a refresh that failed
   * must never turn the page into an error and take a **freshly minted code off the screen** — the
   * admin has not sent it to anybody yet, and it is the only copy he will ever see of a value that
   * has already superseded the man's previous one.
   */
  private async refreshWorker(id: string): Promise<void> {
    const result = await this.company.getWorker(id);
    if (this.workerId() === id && result.status === 'ok' && result.worker) {
      this.worker.set(result.worker);
    }
  }

  /**
   * Read the live code. **A GET that never spends it** — see the class comment.
   *
   * The read starts as the page opens rather than behind a "show the code" tap: this is one man's
   * page, reached deliberately, and the whole reason an admin comes here is to send him his code.
   * Decision 13 is about never putting *several* codes in front of somebody, and a per-worker route
   * cannot.
   */
  private async readCode(id: string): Promise<void> {
    this.codeState.set({
      workerId: id,
      loading: true,
      status: 'ok',
      code: null,
      shareText: null,
      noLiveCode: false,
      afterIssue: false,
    });

    const result = await this.company.readCode(id);

    if (this.workerId() !== id) {
      return;
    }

    this.codeState.set({
      workerId: id,
      loading: false,
      status: result.status,
      code: result.code,
      shareText: result.shareText,
      noLiveCode: result.noLiveCode,
      afterIssue: false,
    });
  }

  protected openDetails(): void {
    this.detailsOpen.set(true);
  }

  protected closeDetails(): void {
    this.detailsOpen.set(false);
  }

  protected reload(): void {
    void this.load(this.workerId());
  }

  protected back(): void {
    void this.router.navigate(['/company']);
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
  protected async issue(): Promise<void> {
    const id = this.workerId();
    if (this.codeBusy()) {
      return;
    }
    this.codeBusy.set(true);
    this.reissuing.set(false);
    this.copied.set(null);

    const result = await this.company.issueCode(id);

    // Recorded before the mid-flight guard below returns, because an issue that landed on a screen
    // the admin has already left is exactly the event worth having a row for. The code itself is
    // never a fact here — only that one was minted, and whether the server said so.
    this.actions.record(ACTIONS.companyCodeIssue, {
      outcome: result.status === 'ok' ? 'ok' : 'fail',
    });

    if (this.workerId() !== id) {
      // He navigated away mid-flight. The code exists on the server and this screen is now about
      // somebody else, so nothing here may claim otherwise — least of all a live code under
      // another man's name. `reset()` has already cleared the busy flag for the screen he is on,
      // and clearing it here as well could unlock a button over *that* man's in-flight issue.
      return;
    }

    this.codeBusy.set(false);

    this.codeState.set({
      workerId: id,
      loading: false,
      status: result.status,
      code: result.code,
      shareText: result.shareText,
      noLiveCode: false,
      afterIssue: true,
    });

    if (result.status === 'ok') {
      // `has_live_activation_code` on the list row is now stale for this man, and the phone count
      // and last-contact line come from the same list. Re-read the man, not the code: the code is
      // in hand and re-reading it would be a second round trip for a value already on screen.
      void this.refreshWorker(id);
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
    const id = this.workerId();
    if (this.revokeBusy()) {
      return;
    }
    this.revokeBusy.set(true);
    const result = await this.company.revokeDevice(device.id);

    // Same as {@link issue}: the flag is cleared only for the man this call was about.
    if (this.workerId() !== id) {
      return;
    }

    this.revokeBusy.set(false);

    if (result.status === 'ok') {
      this.revoking.set(null);
      this.revokeFailure.set(null);
      // The man and his phones changed; the code did not, and re-reading it would blink a value
      // the admin may be in the middle of reading out.
      await Promise.all([this.refreshWorker(id), this.readDevices(id)]);
      return;
    }

    this.revokeFailure.set(result.status);
  }

  /** The sentence for a status, or null when there is nothing to explain. */
  protected reasonFor(status: CompanyStatus | null): string | null {
    return companyReasonFor(status);
  }

  /** Whether a failure happened without the server ever giving a verdict. */
  protected unconfirmedAction(status: CompanyStatus | null): boolean {
    return status !== null && !serverAnswered(status);
  }

  protected onCopyCode(): void {
    const code = this.code()?.code?.code;
    if (code) {
      void this.copy(code, 'code');
    }
  }

  protected onCopyMessage(): void {
    const message = this.code()?.shareText;
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
}
