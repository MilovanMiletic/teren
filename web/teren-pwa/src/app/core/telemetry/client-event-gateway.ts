import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import { ClientEvent, ClientEventReceipt } from './client-event';

/**
 * How long a batch of log lines may hang before it is abandoned.
 *
 * Short on purpose, and shorter than every other call in the app. Nothing here is evidence: a
 * batch that does not go through is re-sent on the next tick or dropped, and holding a socket open
 * for thirty seconds over telemetry is exactly the kind of competition with the upload path that
 * `ActionLogService` promises never to create.
 */
const CLIENT_EVENT_TIMEOUT_MS = 10_000;

/**
 * `POST /api/client-events` behind a seam — **the one client in this app that is handed its
 * bearer instead of choosing one.**
 *
 * ## Why that is safe here and nowhere else
 *
 * `TerenApiClient` carries the device token and `PlatformGateway` carries the admin session, and
 * the two are separate classes precisely so that no call site can pick the wrong one on the upload
 * path (`platform-gateway.ts` says why). This is a third client and it takes the credential as an
 * argument, which looks like the thing that rule forbids and is not: it has exactly one method, it
 * can reach exactly one route, and that route accepts **either** credential by contract. The
 * choosing happens in one place, {@link ActionLogService}, over a pure function of the route table
 * ({@link guardedSurfaceFor}), with a spec on it. There is no path from here to `/api/entries`.
 *
 * ## A token rather than a bare service
 *
 * The same precedent as `PLATFORM_GATEWAY`, `COMPANY_GATEWAY` and `TEREN_DB`: the buffering,
 * batching and drop-on-overflow behaviour is what has to be specced, and it is specced against a
 * double that can be told to answer 404 — which is the answer this route gives until the backend
 * increment lands, and the answer the phone must survive without noticing.
 */
export interface ClientEventGateway {
  /**
   * Hand a batch over.
   *
   * @param bearer the credential the events were captured under. Never chosen here.
   * @throws whatever the platform threw. What a 404 or a 401 *means* is policy, and policy lives
   *   with the buffer that has to decide whether to keep the rows.
   */
  send(bearer: string, events: readonly ClientEvent[]): Promise<ClientEventReceipt>;
}

export const CLIENT_EVENT_GATEWAY = new InjectionToken<ClientEventGateway>(
  'CLIENT_EVENT_GATEWAY',
  { providedIn: 'root', factory: () => inject(HttpClientEventGateway) },
);

@Injectable({ providedIn: 'root' })
export class HttpClientEventGateway implements ClientEventGateway {
  private readonly http = inject(HttpClient);

  /** Never ends in a slash: the path below starts with one, and a double slash is another route. */
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  async send(bearer: string, events: readonly ClientEvent[]): Promise<ClientEventReceipt> {
    return firstValueFrom(
      this.http
        .post<ClientEventReceipt>(
          `${this.baseUrl}/api/client-events`,
          { events },
          { headers: new HttpHeaders({ Authorization: `Bearer ${bearer}` }) },
        )
        .pipe(timeout(CLIENT_EVENT_TIMEOUT_MS)),
    );
  }
}
