import { Injectable, computed, signal } from '@angular/core';

import { Session, persistSession, readStoredSession } from './session';

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
 * ## There is no sign-out
 *
 * Re-activation *replaces* the credential; nothing here ever deletes evidence. A "sign out" that
 * cleared Dexie would break PROJECT.md principle 3 on the one device that is the source of truth.
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
   * Take on a credential. The only writer, and the event the outbox listens for.
   *
   * Persisted first, then published: a signal update that outlived the write would leave the app
   * believing it is activated in a way that does not survive the next reload.
   */
  adopt(session: Session): void {
    persistSession(session);
    this.state.set(session);
  }
}
