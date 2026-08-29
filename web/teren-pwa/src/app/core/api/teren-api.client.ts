import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { API_CONFIG } from './api-config';
import { UploadFailure } from './api-failure';
import {
  CompleteEntryResponse,
  CreateEntryRequest,
  DeclareMediaRequest,
  DeclareMediaResponse,
  EntryListResponse,
  EntryResponse,
  ListEntriesQuery,
  MediaUploadTarget,
  ProjectResponse,
} from './api-types';

/**
 * Every call this app makes to its own server, and the one call it makes to object storage.
 *
 * Thin on purpose: it speaks HTTP and returns wire shapes, and it decides nothing. What a failure
 * *means* (retry, give up, or "the server already had it") is policy, and policy lives in
 * `UploadService` where the outbox row that has to record it also lives. Keeping the two apart is
 * what lets the upload loop be specced without a server and the transport be read without
 * following a state machine.
 *
 * Media bytes never pass through the API (ARCHITECTURE §2, rule 1) — {@link putObject} talks
 * straight to object storage with a presigned URL and, crucially, **no bearer token**: a
 * presigned request carries its signature in the query string, and an `Authorization` header
 * alongside it is how S3 is told to reject the request.
 */
/**
 * How long a small JSON call may hang before it is abandoned.
 *
 * Not a performance knob — a liveness one. Every attempt runs on one serialised chain, so a
 * connection that is neither answering nor failing (a tower handoff, site Wi-Fi with no uplink)
 * holds up every later wake behind it until the platform eventually kills the socket, which can
 * take minutes. From outside that is indistinguishable from "the app stopped uploading".
 * Unsubscribing aborts the underlying fetch, so this really does release the chain.
 */
const API_TIMEOUT_MS = 30_000;

/**
 * The same guard for the presigned PUT, with a much longer budget.
 *
 * There is no resumable upload here: an aborted PUT is re-sent from the first byte on the next
 * attempt, so a timeout that fires on a slow-but-progressing upload throws away real work. The
 * budget is therefore set well past any plausible honest transfer of a compressed photo or a
 * voice note (the server caps them at 10 MB and 25 MB) and is aimed only at a connection that has
 * genuinely stopped moving.
 */
const STORAGE_TIMEOUT_MS = 180_000;

@Injectable({ providedIn: 'root' })
export class TerenApiClient {
  private readonly http = inject(HttpClient);
  private readonly config = inject(API_CONFIG);

  /**
   * Whether this build can talk to a server at all.
   *
   * A missing token is not a network problem and no amount of retrying invents one, so the loop
   * checks this first and fails terminally rather than hammering an endpoint that will only ever
   * answer 401.
   */
  get configured(): boolean {
    return this.config.deviceToken.length > 0;
  }

  async listProjects(): Promise<ProjectResponse[]> {
    return this.get<ProjectResponse[]>('/api/projects');
  }

  /**
   * Hand an entry over. **Idempotent on the client UUID**: 202 the first time, 200 on every
   * replay, and the first declaration wins — so the loop can start every attempt here without
   * checking whether a previous attempt got through.
   */
  async createEntry(request: CreateEntryRequest): Promise<EntryResponse> {
    return this.post<EntryResponse>('/api/entries', request);
  }

  /** Declare files and receive one presigned PUT target per file. */
  async declareMedia(entryId: string, request: DeclareMediaRequest): Promise<DeclareMediaResponse> {
    return this.post<DeclareMediaResponse>(
      `/api/entries/${encodeURIComponent(entryId)}/media`,
      request,
    );
  }

  /** All uploads finished: the server verifies each object and, if all are there, seals the entry. */
  async completeEntry(entryId: string): Promise<CompleteEntryResponse> {
    return this.post<CompleteEntryResponse>(
      `/api/entries/${encodeURIComponent(entryId)}/complete`,
      {},
    );
  }

  /** The poll target, and the tie-breaker that turns a `409` into "the server already has it". */
  async getEntry(entryId: string): Promise<EntryResponse> {
    return this.get<EntryResponse>(`/api/entries/${encodeURIComponent(entryId)}`);
  }

  /**
   * The archive list (C3).
   *
   * `project_id` is spelled snake_case because that is this API's canonical spelling everywhere
   * else; the server also accepts `projectId`, and picking one and staying with it is worth more
   * than the tolerance.
   */
  async listEntries(query: ListEntriesQuery = {}): Promise<EntryListResponse> {
    const params = new URLSearchParams();
    if (query.projectId) {
      params.set('project_id', query.projectId);
    }
    if (query.from) {
      params.set('from', query.from);
    }
    if (query.to) {
      params.set('to', query.to);
    }
    if (query.limit !== undefined) {
      params.set('limit', String(query.limit));
    }
    const suffix = params.size > 0 ? `?${params}` : '';
    return this.get<EntryListResponse>(`/api/entries${suffix}`);
  }

  /**
   * Put one file where the server said to put it.
   *
   * `required_headers` is echoed back **verbatim and instead of** anything derived from the blob.
   * The server signs the *normalised* content type (`audio/ogg`), while the blob carries what
   * `MediaRecorder` actually reported (`audio/ogg; codecs=opus`) — letting the platform fill the
   * header in from `blob.type` would produce a request whose signature does not match, for a
   * reason nothing in the error message would explain.
   */
  async putObject(target: MediaUploadTarget, blob: Blob): Promise<void> {
    if (!target.url) {
      throw new UploadFailure('storage', 'no upload URL was issued for this file');
    }

    let headers = new HttpHeaders();
    for (const [name, value] of Object.entries(target.required_headers ?? {})) {
      headers = headers.set(name, value);
    }

    await firstValueFrom(
      this.http
        .request(target.method ?? 'PUT', target.url, {
          body: blob,
          headers,
          // The store answers an empty body; asking for JSON would turn success into a parse
          // error.
          responseType: 'text',
          observe: 'response',
        })
        .pipe(timeout(STORAGE_TIMEOUT_MS)),
    );
  }

  private async get<T>(path: string): Promise<T> {
    return firstValueFrom(
      this.http
        .get<T>(this.url(path), { headers: this.authHeaders() })
        .pipe(timeout(API_TIMEOUT_MS)),
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return firstValueFrom(
      this.http
        .post<T>(this.url(path), body, { headers: this.authHeaders() })
        .pipe(timeout(API_TIMEOUT_MS)),
    );
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.config.deviceToken}` });
  }
}
