import { Injectable, effect, inject, signal } from '@angular/core';
import { ActivatedRouteSnapshot, Router } from '@angular/router';

import { classifyApiError } from '../api/api-failure';
import { AudioRecorderService } from '../media/audio-recorder.service';
import { ActionLogService } from '../telemetry/action-log.service';
import { ACTIONS } from '../telemetry/actions';
import { markDeviceRefusal } from './device-refusal';
import { requiresDevice } from './device.guard';
import { SessionService } from './session.service';

/**
 * What happens when the server refuses this phone's credential.
 *
 * ## The decision this file implements
 *
 * **Founder decision, 2026-09-03: full sign-out.** He revoked a worker's phone from
 * `/company/worker/:workerId` and the phone carried on as if nothing had happened — recording,
 * queueing, showing the record button — because that was the shipped policy:
 * `plans/profile-and-identity.md` §10.3 and F8 said revocation surfaces "as a notice on Home and
 * the pending screen, never as a locked door". He was offered three policies (notice only; notice
 * plus a stopped upload loop; full sign-out) with the old reasoning stated — an admin's mis-tap
 * must not cost a foreman the day's capture — and chose the sign-out. **This reverses a documented
 * decision deliberately; it is not drift**, and every comment in the tree that asserted the old
 * policy was rewritten in the same change.
 *
 * ## What was actually broken, and why it needed a new seam
 *
 * The server was already right: `DbCredentialAuthenticator` has no cache and joins
 * `device.revoked_at`, `app_user.disabled_at` and `company.suspended_at` on every request, so a
 * refused phone is refused on first contact. **The phone threw the answer away.**
 * `EntryStatusRefresher` polls `GET /api/entries` every twenty seconds from Home and is documented
 * as "best effort, and silent about it"; `requiresDevice` is a pure `localStorage` read that never
 * checks revocation; and the only revocation notice in the product needs an **outbox row** that
 * has failed eight times with `unauthenticated` — roughly half an hour of backoff. With an empty
 * outbox, which is the ordinary case, the phone said nothing at all, ever.
 *
 * ## Why the policy is here and the detection is in `TerenApiClient`
 *
 * The client reports a fact — *this bearer was refused* — and owns no policy, which is what its
 * own file comment has promised since B3. Everything that is a *decision* is here: what counts as
 * a refusal, whether to leave the screen, what to do while the microphone is live, and what to
 * leave behind for `/welcome` to read.
 *
 * **Deliberately not an `HttpInterceptor`**, for `core/api/api-config.ts`'s reasons, of which the
 * second is fatal on this path too: in production `baseUrl` is `''`, so an interceptor matching on
 * a URL prefix matches the presigned PUT to object storage as well — and an S3 refusal says
 * nothing whatsoever about this phone's credential.
 *
 * **And deliberately not scattered across the four services that make device calls**
 * (`ArchiveService`, `ProfileService`, `UploadService`, `ApiProjectSource`). Four call sites is
 * four chances to miss the fifth, and the fifth arrives with the next screen.
 *
 * ## The two 401s that must not do this
 *
 * **A 403 never signs anybody out.** A role refusal is not a dead credential: waiting cannot fix a
 * wrong company and neither can typing a code, and signing a man out over one would answer "you
 * may not do this" with "prove who you are again". Nor does `offline`, nor any 5xx, nor
 * `not_configured`, nor `insecure_context` — the classification is `classifyApiError`'s, never a
 * bare `status === 401` read here, because the B3 taxonomy is binding and two places deciding what
 * a status means is how two screens come to disagree about whether the server is down.
 *
 * **An admin 401 must never clear the device session, and a device 401 must never clear the admin
 * one.** The two credentials are independent, and the founder's browser holds both at once — it is
 * the demo phone and the office console. `CompanyService.classify` and `PlatformService.classify`
 * own the admin half and call `AdminSessionService.signOut`; this file is the device half and
 * cannot reach the admin session. Nothing here injects `AdminSessionService`.
 */
@Injectable({ providedIn: 'root' })
export class DeviceRefusalService {
  private readonly sessions = inject(SessionService);
  private readonly router = inject(Router);
  private readonly recorder = inject(AudioRecorderService);
  private readonly actions = inject(ActionLogService);

  /**
   * A navigation that is owed but must not happen yet, because the microphone is live.
   *
   * Written when a refusal lands during a take and read by the effect below. A signal rather than
   * a boolean field so the effect can depend on it and on the recorder's state together.
   */
  private readonly navigationDeferred = signal(false);

  constructor() {
    // The deferred half of the policy. See `leaveDeviceScreen()` for why the *navigation* waits
    // while the sign-out does not.
    effect(() => {
      const busy = this.recording();
      if (!this.navigationDeferred() || busy) {
        return;
      }
      this.navigationDeferred.set(false);
      this.goToWelcome();
    });
  }

  /**
   * The server refused a bearer. Called by `TerenApiClient` and by nothing else.
   *
   * @param error whatever the HTTP layer threw, unread. Classified here, so a caller can never be
   *   the thing that decides a 403 counts.
   * @param bearer the credential the refused request actually carried. **The guard against a
   *   stale refusal**: an attempt started before a re-activation can resolve after it, and
   *   without this the phone would sign a man out seconds after he had just typed a good code, on
   *   the strength of an answer about a token it no longer holds. Omitted, the check is skipped —
   *   which is only ever a spec's choice, because the client always knows what it sent.
   */
  report(error: unknown, bearer?: string): void {
    if (classifyApiError(error).kind !== 'unauthenticated') {
      return;
    }

    const session = this.sessions.session();
    // Idempotent, and this is the whole of it: a screen's parallel load produces three or four
    // 401s in the same tick, and after the first one there is no session left to discard. No
    // separate "already signed out" flag, because a flag is a second answer to a question the
    // session itself answers.
    if (!session) {
      return;
    }
    if (bearer !== undefined && bearer !== session.token) {
      return;
    }

    // **Recorded before the discard, not after**, and the order is load-bearing:
    // `ActionLogService` files an event under the credential it was captured with, and asks
    // `SessionService.activated()` which one that is. Recorded a line later, the event would have
    // no surface at all and would be dropped on the floor — the one log line that explains why a
    // phone went quiet, lost to the event it describes.
    //
    // **On a foreman's phone this line is written and never delivered, and that is worth stating
    // plainly rather than calling it best effort.** `record()` and `discard()` are two statements
    // of one synchronous call, so no flush can interleave between them; the row is filed under the
    // `device` surface, and every later `flushOnce` finds `bearerFor('device')` empty and
    // `bulkDelete`s it as unsendable. There is no "a flush might catch it first" — there is no gap
    // for one.
    //
    // It reaches the log in exactly one shape: a browser holding an admin session as well, sitting
    // on an admin-guarded URL, where `guardedSurfaceFor` files the row under `admin` and the office
    // bearer is still good. That is the founder's own machine, which is where somebody actually
    // reads the stream — so the line is worth keeping, and the slug belongs in the vocabulary. What
    // it is not is a mechanism a foreman's revocation can be diagnosed through, and nothing on this
    // path is load-bearing on it.
    //
    // Delivering it from a refused phone would need the log to be able to send a row under a
    // credential that has since been replaced. That is a change to `ActionLogService`, not to this
    // file, and it is not in this increment.
    this.actions.record(ACTIONS.sessionDeviceRefused, {
      outcome: 'blocked',
      // Whether he was mid-sentence when it happened. It is the one fact a founder reading the
      // stream would want and cannot reconstruct.
      detail: { recording: this.recording() },
    });

    // The note `/welcome` explains itself with, written before the screen can possibly be shown.
    markDeviceRefusal();

    // The credential is dead whatever happens next, so it goes now. `usable()` turns false with
    // it, which is what makes the upload loop attempt nothing rather than hammer a 401 — and the
    // queue itself is untouched, so it resumes on re-activation.
    this.sessions.discard();

    this.leaveDeviceScreen();
  }

  /**
   * Leave, but only if he is standing somewhere the credential was the reason he could.
   *
   * ## Why this is asked of the route table and not of a list of paths
   *
   * **The founder's browser is the demo phone and the office console at once**, which CLAUDE.md
   * records as a trap the product has fallen into repeatedly. If he revokes Zoran's phone while
   * working in `/company`, the device session must be cleared silently and he must stay exactly
   * where he is: navigating him to `/welcome` — a foreman's join-by-code screen — in the middle of
   * administering his own company would be the app answering a successful action with a lost
   * screen.
   *
   * So the question is whether the deepest active route is gated by `requiresDevice`, asked **by
   * function reference** against the shipped route table. That is `src/app/testing/route-table.ts`'s
   * discipline and `core/telemetry/log-surface.ts`'s: the build renames things, so a name-keyed or
   * path-keyed lookup is a string coupling wearing a disguise, and a route rename is producer-side
   * only — it builds clean, type-checks, and shows up weeks later as a man stranded on a screen.
   * A hand-kept list of paths, or a `data:` flag on the route, would be a second source of truth
   * beside the guard; this reads the guard itself.
   *
   * ## Why the deepest snapshot
   *
   * `canMatch` can sit on any route in the chain and this app's gated routes are leaves. Walking
   * to the leaf is what a nested layout route would need, and costs nothing today.
   */
  private leaveDeviceScreen(): void {
    if (!this.onDeviceGatedScreen()) {
      return;
    }

    /*
     * **The navigation waits for the microphone, and the sign-out does not.**
     *
     * `core/update/app-update.service.ts` makes this argument in full and it applies here without
     * a word changed: everything this app persists is in Dexie before it is anywhere else —
     * entries, chunks written a second at a time, the outbox, a confirmation draft — and all of it
     * survives leaving the screen. The one thing that does not is the live `MediaRecorder`, and
     * that is thirty seconds of a man's afternoon that exists nowhere else yet. `starting` counts
     * as busy exactly as it does there: the permission sheet is up and his attention is on it.
     *
     * The credential is already gone by the time this runs, which is the correct half to do
     * immediately — it is dead either way, `usable()` is false, and the upload loop attempts
     * nothing. Only the screen change waits, and the effect in the constructor performs it the
     * moment the recorder goes idle, by which time `capture-recording-page.ts` has written the
     * take to Dexie.
     */
    if (this.recording()) {
      this.navigationDeferred.set(true);
      return;
    }

    this.goToWelcome();
  }

  /** Whether the deepest active route is one `requiresDevice` let him through. */
  private onDeviceGatedScreen(): boolean {
    let route: ActivatedRouteSnapshot = this.router.routerState.snapshot.root;
    while (route.firstChild) {
      route = route.firstChild;
    }
    // By reference. Never by name, never by path — see the method comment above.
    return (route.routeConfig?.canMatch ?? []).some((guard) => guard === requiresDevice);
  }

  private recording(): boolean {
    const state = this.recorder.state();
    return state === 'starting' || state === 'recording' || state === 'stopping';
  }

  /**
   * To `/welcome`, with no `?next=`.
   *
   * A return URL would be a promise this screen cannot keep: he is not coming back in a moment
   * with the same credential, he is coming back as a phone that has been joined again — possibly
   * to a different company's site list — and the entry or the archive page he was looking at may
   * not be his to see. `requiresDevice` carries `?next=` for the man who was *interrupted*; this
   * is the man who was refused.
   */
  private goToWelcome(): void {
    void this.router.navigate(['/welcome']);
  }
}
