/**
 * The wire shapes of the Teren API, exactly as the server spells them.
 *
 * **snake_case is the canonical spelling of this API** (`Program.cs` sets
 * `JsonNamingPolicy.SnakeCaseLower` for both directions), so these interfaces are written in
 * snake_case rather than being camelCased on the way in. A mapping layer would buy nothing and
 * would be one more place for a field name to be quietly wrong; the two conversions that matter
 * — local model → request, response → local model — live in `upload.service.ts`, in the open.
 *
 * Only the fields the PWA actually uses are declared. The server sends more (structure,
 * corrected, weather); adding them here is a one-line change when B5's confirmation screen needs
 * them.
 */

/** `GET /api/projects` */
export interface ProjectResponse {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  report_language: string;
}

/** `POST /api/entries` */
export interface CreateEntryRequest {
  /** The UUID the phone generated at capture time. The idempotency key. */
  id: string;
  project_id: string;
  /** The site day, `YYYY-MM-DD` — the day the work happened, not the day it was uploaded. */
  entry_date: string;
  /** When the phone captured it, ISO-8601. The server rejects anything more than a day ahead. */
  created_at: string;
  latitude?: number;
  longitude?: number;
  gps_accuracy_m?: number;
}

/**
 * The server's view of one entry. Returned by `POST /api/entries` (202 the first time, 200 on
 * every replay), by `GET /api/entries/{id}`, and nested inside the `/complete` response.
 */
export interface EntryResponse {
  id: string;
  project_id: string;
  entry_date: string;
  /** `received` | `processing` | `awaiting_confirmation` | `needs_review` | `confirmed` | `reported` */
  status: string;
  created_at: string;
  /**
   * **The one field that decides whether the phone's job is done.** Non-null means the server
   * holds the complete entry — JSON plus every declared object verified in storage — and the
   * evidence set is sealed (ARCHITECTURE §6). Null means uploads are still outstanding.
   */
  received_at: string | null;
  confirmed_at: string | null;
  reported_at: string | null;
  failure_reason: string | null;
  media: MediaResponse[];

  /*
   * ---- The archive's half of the response (C3) -------------------------------------------
   *
   * Every field below is declared **optional**, and that is a statement about the server rather
   * than about the screen: the upload path never reads them, older builds of the API do not send
   * them, and an archive that threw — or rendered `undefined` — because a field arrived late
   * would be worse than one that says "not extracted yet". The detail screen is built for the
   * absent case first, because today that *is* the common case: B4 has not populated a single
   * `structure` yet.
   */

  /**
   * The extracted day, schema v1 (ARCHITECTURE §6). Raw JSONB, passed through untouched — the
   * server never reshapes evidence on its way out, and neither does the client.
   * `parseEntryStructure` in `core/archive/entry-structure.ts` narrows it.
   */
  structure?: unknown;

  /**
   * What the human approved on the confirmation screen (B5). May equal `structure`. Where both
   * exist the archive shows this one: it is the version the report was built from, and the
   * archive's job is to show what was sent.
   */
  corrected?: unknown;

  /** Conditions for the entry's date and position (C2). */
  weather?: unknown;

  /**
   * The transcript — the evidence the whole product rests on. Latin script: the pipeline
   * transliterates at ingestion.
   *
   * Optional like the rest of this block, even though the API projects it today, because the
   * archive must survive an older or partially-deployed server without turning a missing field
   * into a broken screen. `undefined` and `null` both render as "the transcript has not arrived
   * from the server", which is true of each.
   */
  raw_transcript?: string | null;

  latitude?: number | null;
  longitude?: number | null;
  gps_accuracy_m?: number | null;

  /** Set when this entry is a correction of an earlier one (C4). */
  supersedes_entry_id?: string | null;
}

/**
 * One row of `GET /api/entries` — the archive list.
 *
 * Deliberately thinner than {@link EntryResponse}: no structure, no transcript, no media list.
 * A list of thirty days must not drag thirty extracted documents across a site connection, so
 * detail costs one more call, made only for the entry actually opened.
 */
export interface EntryListItemResponse {
  id: string;
  project_id: string;
  entry_date: string;
  status: string;
  created_at: string;
  received_at: string | null;
  reported_at: string | null;
  photo_count: number;
  has_audio: boolean;
}

export interface EntryListResponse {
  entries: EntryListItemResponse[];
  count: number;
}

/** Query parameters for `GET /api/entries`. All optional; the server clamps `limit` itself. */
export interface ListEntriesQuery {
  projectId?: string;
  /** Inclusive site-day bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  limit?: number;
}

export interface MediaResponse {
  id: string;
  kind: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  object_key: string;
  /** `pending` | `uploaded` | `verified` | `failed` */
  upload_status: string;
}

/** `POST /api/entries/{id}/media` */
export interface DeclareMediaRequest {
  files: DeclaredMedia[];
}

export interface DeclaredMedia {
  id: string;
  kind: 'audio' | 'photo';
  /** May carry parameters (`audio/ogg; codecs=opus`); the server normalises before signing. */
  content_type: string;
  byte_size: number;
  /** 64 lowercase hex characters over the exact bytes about to be uploaded. */
  sha256: string;
  captured_at: string;
}

export interface DeclareMediaResponse {
  entry_id: string;
  uploads: MediaUploadTarget[];
}

export interface MediaUploadTarget {
  media_id: string;
  kind: string;
  object_key: string;
  upload_status: string;
  /**
   * Null when the object is already verified in storage — verified evidence is never handed a
   * second write permission. A null url is therefore a *success* signal, not a failure: that
   * file is already where it belongs and must be skipped.
   */
  url: string | null;
  method: string | null;
  /**
   * Headers the PUT must reproduce **exactly**, because they are part of the SigV4 signature.
   * Today that is `Content-Type`, signed with the server's *normalised* type (`audio/ogg`), not
   * the parameterised one the recorder reported — which is precisely why the PUT must send these
   * back rather than letting the platform derive a type from the blob.
   */
  required_headers: Record<string, string> | null;
  expires_at: string | null;
}

/**
 * `POST /api/entries/{id}/confirm` — the mandatory gate before any report is sent
 * (PROJECT.md principle 5).
 *
 * **One field, and that is the whole design.** `raw_transcript` is evidence and write-once,
 * `structure` is what the model said, and `corrected` is what the person signed off; the three
 * together are the eval set and the only record of what extraction actually got wrong
 * (ARCHITECTURE §9.3). The API accepts nothing else on this route precisely so that no client can
 * make one of them overwrite another, and this interface is the client half of that promise.
 *
 * The payload must carry `schema_version`: the server's validator requires it and a Postgres
 * CHECK enforces it. It is built by `toCorrectedPayload` in `core/confirm/entry-draft.ts` and
 * never assembled by hand.
 */
export interface ConfirmEntryRequest {
  corrected: Record<string, unknown>;
}

/** `POST /api/entries/{id}/complete` */
export interface CompleteEntryResponse {
  /** True when the server holds the whole entry. Also true on a replay of an already-sealed entry. */
  ready: boolean;
  /** Human-readable diagnosis when `ready` is false. English, server-authored — never shown raw. */
  reason: string | null;
  /** Media declared but not yet found in storage. A waiting state, not a verdict. */
  pending_media: string[];
  /** Media present in storage at the wrong size. A real failure — the bytes must go up again. */
  failed_media: string[];
  entry: EntryResponse;
}

/**
 * `GET /api/entries/{id}/report` — the report PDF, as it comes off the wire.
 *
 * Not a JSON shape like the rest of this file, but it belongs beside them: it is what one route
 * answers. Deliberately raw — the bytes and the one header that names them — because turning
 * either into something a screen can use (a filename, a saved file) is policy, and policy lives
 * in `core/report/`.
 */
export interface ReportDownload {
  /**
   * The PDF. `null` is possible: `HttpClient` reports an empty 200 body that way, and an empty
   * body is a broken report rather than a report — the caller must not save it.
   */
  body: Blob | null;

  /**
   * The raw `Content-Disposition` header, carrying the server's human-readable Serbian filename.
   *
   * `null` when the browser would not expose it — it is not CORS-safelisted, so a cross-origin
   * API must send `Access-Control-Expose-Headers: Content-Disposition` for it to be readable at
   * all. That is a naming inconvenience, never a failed download.
   */
  contentDisposition: string | null;
}

/**
 * `GET /api/me` — who is holding this credential (`MeEndpoints.cs`).
 *
 * **Every field is optional on the way in**, and that is a statement about the server rather than
 * about the screen. The endpoint declares `role`, `user_id`, `display_name` and `language` as
 * non-null, but a phone can be pointed at an older build of the API — a stale staging box, a
 * cached origin — and a profile screen that rendered `undefined` where a man's name belongs would
 * be worse than one that says it could not read the answer. `ProfileService` narrows this into a
 * model whose absent fields are explicitly `null`, and the screen draws only the rows it has.
 *
 * `username`, `company` and `device` are legitimately null for a super admin, who belongs to no
 * company and holds no phone (§4, `ck_app_user_company_scope`). The screen must not assume a
 * worker.
 */
export interface MeResponse {
  /** `worker` | `company_admin` | `super_admin`. */
  role?: string | null;
  user_id?: string | null;
  display_name?: string | null;
  /**
   * **The worker's durable identity** (plan decision 7). It outlives any phone; the device
   * credential merely proves it. Null for the two admin roles, who sign in by email.
   */
  username?: string | null;
  /**
   * His own address.
   *
   * Null for a foreman who has none on file (optional by decision 6), and never null for an admin,
   * whom `ck_app_user_admin_has_email` refuses to store without one. It is here because a company
   * admin appears in no list he is allowed to read — `/api/workers` is the men who record and
   * excludes him by construction, and the platform directory is Teren staff only — so this route is
   * the only place `/company/profile` can learn anything about him beyond his name.
   */
  email?: string | null;
  /** The UI language the server holds for this person. Not this phone's setting. */
  language?: string | null;
  company?: CompanyRefResponse | null;
  device?: DeviceRefResponse | null;
  /** ISO-8601. When the account was made — not when this browser signed into it. */
  created_at?: string | null;
  /**
   * ISO-8601, and the **previous** sign-in rather than this one: `/auth/login` stamps it as it
   * mints the session. An admin reading his own account therefore always sees "a moment ago", which
   * is why the screen puts it beside the sign-in time the browser itself stored rather than instead
   * of it. Null for a foreman, who never signs in at all.
   */
  last_login_at?: string | null;
}

/** The company a person belongs to, by id and name. Null for a super admin. */
export interface CompanyRefResponse {
  id?: string | null;
  name?: string | null;
}

/** The phone this credential is bound to. Null for an admin, who has no device. */
export interface DeviceRefResponse {
  id?: string | null;
  /** What the admin sees in his device list — "Zoranov telefon". */
  name?: string | null;
}
