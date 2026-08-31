import { Injectable, computed, signal } from '@angular/core';

import { environment } from '../../../environments/environment';
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
   * The bearer to send, falling back to the build-time token.
   *
   * The fallback is what keeps every existing install working and the distributor's demo
   * byte-identical: a phone with no stored session behaves exactly as it did before F2, because
   * `environment.deviceToken` is what it was already sending. It is removed at D7/F9, when the
   * static token retires and an un-activated phone genuinely has no credential.
   */
  readonly token = computed(() => this.state()?.token ?? environment.deviceToken);

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
   * Deliberately not {@link usable}, and the difference is the whole of F4. `usable()` asks "is
   * there a bearer worth sending", and until D7/F9 it is true on every install because of the
   * build-time fallback above — a gate written on it would be inert, and the welcome screen would
   * be a page nobody could ever reach. This asks "has a man bound this phone to himself", which is
   * the question the screens are about.
   *
   * The consequence, stated plainly because it is the increment's cost: **a phone that has never
   * been activated now meets `/welcome` instead of Home**, even though the baked-in token would
   * still authenticate it against the API. The API door stays open until D7/F9 empties that
   * token; this is the UI door, and it closes first.
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
