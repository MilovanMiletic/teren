import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { BufferedEvent } from '../db/models';
import { TEREN_DB } from '../db/teren-db';
import { AdminSessionService } from '../session/admin-session.service';
import { SessionService } from '../session/session.service';
import { describeClick } from './action-descriptor';
import { ACTIONS } from './actions';
import { ActionFacts, ClientEvent, buildEvent } from './client-event';
import { CLIENT_EVENT_GATEWAY } from './client-event-gateway';
import { LogSurface, guardedSurfaceFor } from './log-surface';

/**
 * How many recorded actions the phone will hold before it starts dropping the oldest.
 *
 * A day of heavy use is a few hundred presses. Five hundred rows is therefore roughly a day of
 * unsent log, which is the useful horizon — and it is small enough that the buffer can never be
 * the reason a photograph does not fit.
 */
export const MAX_BUFFERED_EVENTS = 500;

/** The server takes at most a hundred events in a batch. */
const MAX_BATCH_EVENTS = 100;

/** …and at most 64 KB. Held under it with room to spare, because the estimate is a JSON length. */
const MAX_BATCH_BYTES = 56_000;

/** How often the buffer is offered to the server, when there is anything in it. */
export const FLUSH_INTERVAL_MS = 30_000;

/** How many rows have to pile up before a flush is brought forward. */
const FLUSH_AT_ROWS = 25;

/**
 * Every action performed in this app, recorded on the phone and handed to the server when there is
 * a network for it (D5; contract §3, §4).
 *
 * ## Why it exists
 *
 * The founder asked for the log viewer, and a log viewer over server-side logs alone answers the
 * wrong question: it says what the *server* did. What he actually needs to see is what happened on
 * the glass — which button was pressed, on which screen, and what came of it — because every
 * support conversation this product will ever have starts with "I pressed it and nothing
 * happened". Without this service the log screen is a list of Hangfire jobs.
 *
 * ## What it may never do
 *
 * This is the first piece of code in the app that runs on **every** click, including the ones on
 * the money path, so the constraints are absolute rather than aspirational:
 *
 * - **It never blocks a click.** The listener is passive and capture-phase, it composes the event
 *   synchronously in memory and hands the write to a promise chain nobody awaits.
 * - **It never throws into a handler.** Every entry point is wrapped. A logger that can break the
 *   record button is worse than no logger, and it would break it silently on one device class.
 * - **It never competes with the upload queue.** A flush is skipped outright while an outbox row
 *   is `in_flight`: a day's evidence and a list of button presses must never be asking the same
 *   site connection for bandwidth, and there is no version of that contest telemetry should win.
 * - **It never keeps evidence from leaving the phone.** The buffer is bounded and drops its oldest
 *   rows, so it cannot take the storage quota a photograph needs.
 * - **It fails quietly.** The route it posts to does not exist yet in every deployment; a 404 puts
 *   the service to sleep for the session and empties the buffer rather than accumulating rows
 *   nobody will ever read. Offline is not even a failure — the rows wait.
 *
 * ## Which credential a batch is sent under
 *
 * The one decided by {@link guardedSurfaceFor} from the shipped route table, recorded on the row
 * at capture time and never re-derived at flush. That file carries the reasoning, and it is worth
 * reading before touching this: the founder's browser holds a device session and an admin session
 * at the same time, and picking "whichever token exists" would file either a foreman's day under
 * Teren staff or Teren's own activity inside a customer's company.
 */
@Injectable({ providedIn: 'root' })
export class ActionLogService {
  private readonly db = inject(TEREN_DB);
  private readonly gateway = inject(CLIENT_EVENT_GATEWAY);
  private readonly router = inject(Router);
  private readonly devices = inject(SessionService);
  private readonly admins = inject(AdminSessionService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * How many actions were dropped because the buffer was full, since the last time it was said.
   *
   * A counter and not a silence: a log with a hole in it that nobody mentions is a log that will
   * be trusted about the very minute it cannot describe. It is reported as one `app.error` event
   * on the next flush and cleared **only once that flush has been accepted** — a notice that was
   * composed into a batch the server refused has told nobody anything.
   */
  readonly dropped = signal(0);

  /** Whether anything is being recorded at all. False once the server has said there is no route. */
  readonly enabled = signal(true);

  private started = false;

  /** Every write and every flush runs on one chain, so a trim can never race an append. */
  private work: Promise<void> = Promise.resolve();

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Rows written since the last flush, so a burst can bring one forward. */
  private sinceFlush = 0;

  /**
   * Begin. Idempotent, and safe to call before there is a network, a session or a route.
   *
   * Called from `provideAppInitializer` and never awaited — bootstrap must not be able to fail
   * over telemetry, which is the same rule the sync loop and the rescue sweep are started under.
   */
  start(): void {
    if (this.started || typeof document === 'undefined') {
      return;
    }
    this.started = true;

    // Capture phase, so a handler that calls `stopPropagation()` — which several controls in this
    // app do — cannot make its own control invisible to the log. Passive, so the browser knows
    // this listener will never call `preventDefault()` and need not wait for it before scrolling.
    const onClick = (event: Event): void => this.onDocumentClick(event);
    document.addEventListener('click', onClick, { capture: true, passive: true });

    const onHidden = (): void => {
      // The last chance before a tab is discarded. Best effort by definition: the browser may kill
      // the page mid-request, which costs a batch and nothing else, because the rows are on disk
      // until the server has answered for them.
      if (document.visibilityState === 'hidden') {
        void this.flush();
      }
    };
    document.addEventListener('visibilitychange', onHidden);

    const onOnline = (): void => {
      this.record(ACTIONS.appOnline);
      void this.flush();
    };
    const onOffline = (): void => this.record(ACTIONS.appOffline);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }

    const navigations = this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      // `urlAfterRedirects`, not `url`: a guard that bounced a man to `/welcome` is the interesting
      // fact, and the URL he typed is the one the log would otherwise claim he reached.
      .subscribe((event) => this.record(ACTIONS.navRouteEnter, {}, event.urlAfterRedirects));

    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);

    this.destroyRef.onDestroy(() => {
      document.removeEventListener('click', onClick, { capture: true });
      document.removeEventListener('visibilitychange', onHidden);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
      navigations.unsubscribe();
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    });

    this.record(ACTIONS.appStart);
  }

  /**
   * Record one action. **Returns immediately and cannot throw.**
   *
   * The event is composed here, synchronously, because the route and the clock are only correct
   * now; the write is handed to the chain and nobody waits for it. A caller on the capture path
   * may use this in the middle of a handler without thinking about it, which is the only way this
   * gets used at all.
   *
   * @param route the URL the action happened on, when it is not the one the router is showing —
   *   which is only ever the case for the navigation event itself.
   */
  record(action: string, facts: ActionFacts = {}, route?: string): void {
    if (!this.enabled()) {
      return;
    }
    try {
      const url = route ?? this.router.url;
      const event = buildEvent(action, url, new Date().toISOString(), facts);
      if (!event) {
        return;
      }
      const surface = this.surfaceFor(url);
      if (!surface) {
        return;
      }
      this.sinceFlush += 1;
      this.enqueue({ surface, event });
    } catch {
      // Nothing a logger can be told is worth breaking the screen that told it. There is no
      // reporting channel here on purpose: reporting a logging failure through the logger is the
      // one shape that turns a bad click into a loop.
    }
  }

  /**
   * Offer the buffer to the server. Never throws, and never runs twice at once.
   *
   * Public because two callers outside this class need it — the visibility handler above, and
   * specs, which have no way to wait out a thirty-second timer.
   */
  async flush(): Promise<void> {
    this.work = this.work.then(() => this.flushOnce()).catch(() => undefined);
    return this.work;
  }

  /**
   * Every write that has been started, finished — **without provoking a flush.**
   *
   * The chain is private and `record()` returns before its write lands, which is the point of it.
   * A spec that wants to look at the buffer has no other way to know the writes have arrived, and
   * the obvious alternative — awaiting {@link flush} — would send the very rows it is about to
   * assert are still on the phone. Nothing in the app calls this.
   */
  async settled(): Promise<void> {
    await this.work;
  }

  // ---- The click listener --------------------------------------------------------------------

  /**
   * Name what was pressed, **structurally**.
   *
   * The descriptor comes from `data-log`, the tag and the class names, and from nothing else —
   * `action-descriptor.ts` is where that boundary is defended and where the spec that enforces it
   * lives. A click that is not on a control is not recorded.
   */
  private onDocumentClick(event: Event): void {
    try {
      const action = describeClick(event.target);
      if (action) {
        this.record(action);
      }
    } catch {
      // A DOM that answered oddly — a click inside a shadow root, a detached node. Never the
      // click's problem.
    }
  }

  // ---- The buffer ----------------------------------------------------------------------------

  /** Append, then trim. Both on the one chain, so a burst of clicks cannot interleave them. */
  private enqueue(row: BufferedEvent): void {
    this.work = this.work
      .then(async () => {
        await this.db.clientEvents.add(row);
        await this.trim();
        if (this.sinceFlush >= FLUSH_AT_ROWS) {
          this.sinceFlush = 0;
          await this.flushOnce();
        }
      })
      .catch(() => undefined);
  }

  /**
   * Keep the buffer under its ceiling by dropping the **oldest** rows.
   *
   * Oldest rather than newest, deliberately: a phone that has been offline for a week holds a
   * week-old first press and this morning's, and this morning's is the one somebody is asking
   * about. The count of what was lost is kept, so the gap is stated rather than inferred.
   */
  private async trim(): Promise<void> {
    const total = await this.db.clientEvents.count();
    if (total <= MAX_BUFFERED_EVENTS) {
      return;
    }
    const excess = total - MAX_BUFFERED_EVENTS;
    const keys = await this.db.clientEvents.orderBy(':id').limit(excess).primaryKeys();
    await this.db.clientEvents.bulkDelete(keys);
    this.dropped.update((was) => was + keys.length);
  }

  // ---- The flush -----------------------------------------------------------------------------

  private async flushOnce(): Promise<void> {
    if (!this.enabled()) {
      return;
    }

    // `navigator.onLine` only ever proves the *absence* of a network reliably, which is exactly
    // what is wanted here: it costs nothing to skip a request that certainly cannot succeed.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return;
    }

    // **The upload queue comes first, always.** A day of evidence and a list of button presses
    // must never contend for the same site connection, and there is no reading of this product
    // where the button presses win.
    if (await this.uploadInFlight()) {
      return;
    }

    const rows = await this.db.clientEvents.orderBy(':id').limit(MAX_BATCH_EVENTS).toArray();
    if (rows.length === 0) {
      return;
    }

    // One batch is one credential. The head row decides which, and the batch stops at the first
    // row that was captured under the other one — so a foreman's morning and an admin's afternoon
    // go to the server as themselves rather than as whoever happened to be signed in at teatime.
    const surface = rows[0].surface;
    // One slot held back when there is a hole to report, so the notice below cannot push the batch
    // over the server's hundred-event cap and cost every row in it.
    const cap = MAX_BATCH_EVENTS - (this.dropped() > 0 ? 1 : 0);
    const batch = this.take(
      rows.filter((row) => row.surface === surface),
      cap,
    );

    const bearer = this.bearerFor(surface);
    if (!bearer) {
      // Nothing will ever be able to send these: the credential they were captured under is gone
      // and cannot come back for these rows. Kept out of the way rather than blocking the head of
      // the queue for the rest of the session.
      await this.db.clientEvents.bulkDelete(batch.keys);
      return;
    }

    const { events, reported } = this.withOverflowNotice(batch.events, batch.route);

    try {
      await this.gateway.send(bearer, events);
      // Only now. A batch deleted before the answer is a batch lost to a timeout, and while these
      // rows are not evidence there is no reason to lose them to a hiccup.
      await this.db.clientEvents.bulkDelete(batch.keys);
      // …and only now is the hole forgotten, for the same reason and a sharper one: a counter
      // cleared before the send is a counter cleared by a *failed* send, and then the one flaky
      // first flush after a week offline destroys the only record that two hundred presses were
      // dropped. Subtracted rather than zeroed, because rows can be dropped while this request is
      // in flight and that is a second hole nobody has reported yet.
      if (reported > 0) {
        this.dropped.update((was) => Math.max(0, was - reported));
      }
    } catch (error) {
      await this.onSendFailed(error, batch.keys);
    }
  }

  /** Fill a batch up to the event and byte caps, in arrival order. */
  private take(
    rows: readonly BufferedEvent[],
    cap: number,
  ): {
    keys: number[];
    events: ClientEvent[];
    route: string;
  } {
    const keys: number[] = [];
    const events: ClientEvent[] = [];
    let bytes = 2;

    for (const row of rows) {
      const event = row.event as ClientEvent;
      const size = JSON.stringify(event).length + 1;
      if (events.length >= cap || (events.length > 0 && bytes + size > MAX_BATCH_BYTES)) {
        break;
      }
      bytes += size;
      keys.push(row.seq as number);
      events.push(event);
    }

    return { keys, events, route: events[0]?.route ?? '/' };
  }

  /**
   * Say out loud that the log has a hole in it.
   *
   * One `app.error` at the head of the next batch, carrying the count. It is composed rather than
   * buffered so it can never itself be the row that overflows the buffer, and it is an *error*
   * rather than a note because a log that silently skipped an afternoon is a log that will be
   * believed about that afternoon.
   *
   * **This does not clear the counter** — it says how many the notice claims, and the caller
   * forgets that many only once the server has taken them. Composing a notice is not reporting
   * one, and the difference is a whole hole.
   */
  private withOverflowNotice(
    events: ClientEvent[],
    route: string,
  ): { events: ClientEvent[]; reported: number } {
    const lost = this.dropped();
    if (lost === 0) {
      return { events, reported: 0 };
    }

    const notice = buildEvent(ACTIONS.appError, route, new Date().toISOString(), {
      outcome: 'fail',
      detail: { dropped: lost, cause: 'log-buffer-full' },
    });
    if (!notice) {
      return { events, reported: 0 };
    }

    return { events: [notice, ...events], reported: lost };
  }

  /**
   * What to do about a refusal — and the whole of it is "do no harm".
   *
   * - **404 / 501**: this deployment has no such route. Nothing changes until it is redeployed, so
   *   the service goes to sleep for the session and the buffer is emptied. Retrying would be a
   *   request every thirty seconds, for ever, against a server that has already answered.
   * - **401 / 403**: the credential these rows were captured under is not accepted. Dropped, not
   *   retried: a log line is not worth hammering an endpoint that has said no, and unlike an entry
   *   there is nothing here a re-activation would rescue.
   * - **Everything else** — offline, a timeout, any 5xx: the rows stay exactly where they are and
   *   the next tick tries again. This is the ordinary case on a building site.
   */
  private async onSendFailed(error: unknown, keys: readonly number[]): Promise<void> {
    const status = error instanceof HttpErrorResponse ? error.status : 0;

    if (status === 404 || status === 501) {
      this.enabled.set(false);
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      await this.db.clientEvents.clear().catch(() => undefined);
      return;
    }

    if (status === 401 || status === 403) {
      // Exactly the rows that were refused, never "the head of the queue": by the time this runs
      // another batch may have been written behind it, and deleting by position rather than by key
      // would throw away rows nobody has offered the server yet.
      await this.db.clientEvents.bulkDelete([...keys]).catch(() => undefined);
    }
  }

  /** Whether the outbox is busy. A read, and the only thing this file knows about evidence. */
  private async uploadInFlight(): Promise<boolean> {
    try {
      return (await this.db.outbox.where('state').equals('in_flight').count()) > 0;
    } catch {
      // A store that will not answer is not a reason to send anything. Skipping a flush costs a
      // log line; guessing "idle" costs the upload path its bandwidth.
      return true;
    }
  }

  /**
   * Which credential an action on this URL belongs to, or null when there is none to be had.
   *
   * The route's own guard decides it where there is one (`log-surface.ts`). Where there is not —
   * `/welcome`, `/activate`, `/login`, `/set-password` — this phone's device session wins if it
   * has one, because on the device this product is built around that answer is always right.
   */
  private surfaceFor(url: string): LogSurface | null {
    const guarded = guardedSurfaceFor(url);
    if (guarded) {
      return guarded;
    }
    if (this.devices.activated()) {
      return 'device';
    }
    return this.admins.signedIn() ? 'admin' : null;
  }

  private bearerFor(surface: LogSurface): string {
    return surface === 'admin' ? this.admins.token() : this.devices.token();
  }
}
