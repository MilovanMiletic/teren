import { Injectable, inject } from '@angular/core';

import { EntryListItemResponse, EntryResponse } from '../api/api-types';
import { classifyApiError } from '../api/api-failure';
import { TerenApiClient } from '../api/teren-api.client';

/**
 * How the last look at the server went.
 *
 * `ok` includes "the server answered with nothing", which is a real and common answer. What this
 * type exists to keep apart is the three ways a *reachable* archive can be incomplete — no
 * network, no credentials, a server that is unwell — because the screen says something different
 * about each, and because none of them is allowed to look like "there are no entries".
 */
export type RemoteStatus = 'ok' | 'offline' | 'unauthorized' | 'not_configured' | 'unavailable';

export interface RemoteList {
  status: RemoteStatus;
  items: EntryListItemResponse[];
}

export interface RemoteEntry {
  status: RemoteStatus;
  entry: EntryResponse | null;
  /** True when the server answered plainly that it has no such entry. */
  missing: boolean;
}

/**
 * The archive's connection to the server.
 *
 * Everything here is **best effort by construction**: no method throws, and every one of them
 * returns a status alongside whatever it managed to get. That is not defensive habit, it is the
 * screen's contract — the archive reads from Dexie first and works completely offline, and a
 * rejected promise from an enrichment call must never be able to empty a list that the phone
 * could have drawn on its own.
 *
 * The counterpart to that promise is that a partial archive says so. A silent failure here would
 * show a foreman four entries when the company has forty, with nothing on screen to suggest the
 * difference, and the archive is the screen the *buyer* trusts to win disputes. So the failure is
 * classified with the same taxonomy the upload path uses (B3, ARCHITECTURE §11) and handed up.
 */
@Injectable({ providedIn: 'root' })
export class ArchiveService {
  private readonly api = inject(TerenApiClient);

  /**
   * The company's entries for a project, as the server has them.
   *
   * `limit` is generous rather than paged: an archive is read by scrolling back through days, and
   * a foreman looking for the week the pipes went in should not meet a "load more" button. Real
   * paging arrives when a project actually has more days than this, which is a year of daily work.
   */
  async listEntries(projectId: string, limit = 200): Promise<RemoteList> {
    if (!this.api.configured) {
      return { status: 'not_configured', items: [] };
    }
    try {
      const response = await this.api.listEntries({ projectId, limit });
      return { status: 'ok', items: response.entries ?? [] };
    } catch (error) {
      return { status: toRemoteStatus(error), items: [] };
    }
  }

  /**
   * One entry in full: status, structure, transcript, weather, position.
   *
   * A 404 is reported as `missing` rather than as a failure, because on this screen it is
   * information: the entry is on this phone and the server has never seen it. That is the normal
   * state of everything still in the outbox, and the detail screen renders it as an entry that
   * has not been sent yet — not as an error.
   */
  async getEntry(entryId: string): Promise<RemoteEntry> {
    if (!this.api.configured) {
      return { status: 'not_configured', entry: null, missing: false };
    }
    try {
      return { status: 'ok', entry: await this.api.getEntry(entryId), missing: false };
    } catch (error) {
      const failure = classifyApiError(error);
      // `rejected` covers 400/404/409/422; only a 404 means "no such entry".
      if (failure.kind === 'rejected' && failure.status === 404) {
        return { status: 'ok', entry: null, missing: true };
      }
      return { status: toRemoteStatus(failure), entry: null, missing: false };
    }
  }
}

/**
 * The upload path's failure taxonomy, reduced to the four things this screen can say.
 *
 * Reusing `classifyApiError` rather than reading statuses again is deliberate: the rules about
 * what a status means — status 0 is a network failure and not the server's answer, every 5xx is
 * the server being unwell — were settled at B3 and are binding for B4+. Two places deciding that
 * independently is how two screens end up disagreeing about whether the server is down.
 */
function toRemoteStatus(error: unknown): RemoteStatus {
  // `classifyApiError` returns an `UploadFailure` unchanged, so passing one back in is free and
  // keeps this function's contract to a single input type.
  switch (classifyApiError(error).kind) {
    case 'offline':
      return 'offline';
    // 401 and 403 are one answer to this screen: the server would not show us the archive. The
    // upload path splits them because only it has to decide whether to keep retrying; here the
    // sentence is the same either way, so `unauthenticated` falls through deliberately rather
    // than landing in `default` and degrading to "the server is unwell".
    case 'unauthenticated':
    case 'unauthorized':
      return 'unauthorized';
    case 'not_configured':
    case 'insecure_context':
      return 'not_configured';
    default:
      return 'unavailable';
  }
}
