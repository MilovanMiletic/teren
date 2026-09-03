import { Injectable, computed, signal } from '@angular/core';

import { Session, clearSession, persistSession, readStoredSession } from './session';

/**
 * Who this phone is, as far as the server is concerned.
 *
 * ## It injects nothing, and that is a constraint rather than a coincidence
 *
 * `API_CONFIG` depends on this service, so a dependency *back* into the API client would be a
 * cycle. Orchestration — calling `/auth/activate`, clearing the cached project list when the
 * company changes — belongs to `ActivationService`, which is free to inject whatever it likes and
 * writes the result here through {@link adopt}.
 *
 * ## The read is synchronous, and must stay that way
 *
 * The credential is read from `localStorage` **during construction**, so the route guard that
 * decides between the record button and the activation screen is a pure boolean over one signal
 * read: no awaited promise, no network call, no frame in which the app does not know who it is.
 * That is what lets an activated phone render Home offline, on the first frame, in a basement.
 *
 * There is no async token acquisition anywhere in this design and there must not be one. The token
 * changes exactly once per activation, while a human watches a screen. Anyone tempted to add a
 * refresh interceptor should read that sentence again: it would put a network round trip in front
 * of the record button, which is invariant 1 broken for a problem this product does not have.
 *
 * ## There are two writers, and the second one is new (founder decision, 2026-09-03)
 *
 * {@link adopt} takes a credential on; {@link discard} gives one up. Until 2026-09-03 there was
 * only the first, and this comment said so — "there is no sign-out" — because
 * `plans/profile-and-identity.md` §10.3 and F8 held that a revoked phone keeps its session and
 * keeps reaching the record button. **The founder reversed that on 2026-09-03**, after revoking a
 * worker's phone from the office screen and watching the phone carry on as if nothing had
 * happened: a credential the server refuses is cleared, the man lands on `/welcome`, and the
 * record button goes with it. He was offered the milder policies and the old reasoning (an admin's
 * mis-tap must not cost a foreman the day's capture) explicitly, and chose this. It is a decision,
 * not drift.
 *
 * **Nothing here deletes evidence, and that half of §10.3 is untouched.** `discard()` removes one
 * `localStorage` row; PROJECT.md principle 3 holds, the unsent day stays on the phone, and
 * re-activating as the same worker sets it moving again. Re-activation still *replaces* rather
 * than clears — `adopt()` is the ordinary path and `discard()` is only ever the server's refusal.
 *
 * The policy — what a refusal is, when to leave the screen, what to do while the microphone is
 * live — is **not** here. It lives in `device-refusal.service.ts`, which can inject the router and
 * the recorder; this file must go on injecting nothing (see above).
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly state = signal<Session | null>(readStoredSession());

  /** The whole session, for the screens that name the worker or his company. */
  readonly session = this.state.asReadonly();

  /**
   * The bearer to send, or `''` when this phone holds no credential of its own.
   *
   * **There is no build-time fallback, and its absence is the whole of D7/F9.** Through F2–F6 this
   * fell back to `environment.deviceToken`, which kept every existing install and the
   * distributor's demo working byte-identically while the identity model was built underneath
   * them — and which also meant a working credential was compiled into the bundle, readable from
   * devtools by anyone who opened them, `usable()` was true on every install, and the login
   * screens were decoration over a door that was never shut. The fallback and the constant's value
   * both went on 2026-08-31; the read went with them on 2026-09-02, so nothing here can be
   * reopened by putting a string back in `environment.ts`.
   *
   * An empty string is the honest answer: `UploadService` treats "no credential" as structurally
   * the same condition as "no signal" and attempts nothing, rather than sending a bearer the
   * server will refuse.
   */
  readonly token = computed(() => this.state()?.token ?? '');

  /**
   * Whether there is a credential worth making an attempt with.
   *
   * The sync loop reads this *before* it touches the queue, so "no credential" is structurally the
   * same condition as "no signal" — nothing is attempted, nothing is recorded, nothing is blamed.
   * The alternative, which is what the code did before F1, was to let the attempt run and fail
   * `not_configured`, which is terminal, which strands the morning.
   */
  readonly usable = computed(() => this.token().length > 0);

  /**
   * Whether this phone holds a credential **of its own**. The route gate's single question.
   *
   * Now that the build-time fallback is gone this answers the same as {@link usable} for every
   * session the narrower will accept, and the two are still deliberately separate questions. This
   * one is "has a man bound this phone to himself" — a property of the stored row — while
   * `usable()` is "is there a bearer worth sending", a property of the string. F4 was written
   * because those two came apart: the fallback made `usable()` true on every install, so a gate
   * built on it was inert and `/welcome` was a page nobody could reach. Reuniting them by
   * accident is not a reason to collapse them; the next credential that arrives from somewhere
   * other than an activation would separate them again.
   *
   * Read synchronously, from a signal that was populated during construction. No promise, no
   * request, no frame in which the app does not know the answer.
   */
  readonly activated = computed(() => this.state() !== null);

  /**
   * Take on a credential. The writer for every ordinary path, and the event the outbox listens
   * for. ({@link discard} is the other one, and it only ever runs on the server's refusal.)
   *
   * Persisted first, then published: a signal update that outlived the write would leave the app
   * believing it is activated in a way that does not survive the next reload.
   */
  adopt(session: Session): void {
    persistSession(session);
    this.state.set(session);
  }

  /**
   * Give the credential up, because the server refused it (founder decision, 2026-09-03).
   *
   * The twin of `AdminSessionService.signOut`, and it carries that method's guarantee word for
   * word: **it touches `localStorage` and nothing else — never Dexie, never evidence.** Not one
   * entry, not one outbox row, not one audio chunk. PROJECT.md principle 3 is about what the phone
   * *holds*, and this only forgets who the phone *is*; the unsent day survives and moves again the
   * moment the same worker re-activates.
   *
   * Idempotent by construction — clearing an already-cleared row and re-setting `null` are both
   * no-ops — which is what lets a screen's parallel loads all report the same 401 without
   * signing out twice.
   *
   * Cleared first, then published, so a signal update cannot outlive the write it describes: the
   * same ordering `adopt()` uses, for the mirror-image reason.
   */
  discard(): void {
    clearSession();
    this.state.set(null);
  }
}
