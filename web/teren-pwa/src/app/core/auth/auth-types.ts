/**
 * The wire shapes of the three unauthenticated routes (`plans/profile-and-identity.md` §8).
 *
 * snake_case, like every other body this API exchanges. Written out here rather than reused from
 * `core/api/api-types.ts` because these routes live under `/auth`, deliberately **not** under
 * `/api`: keeping them in a separate file is what keeps `TerenApiClient` — which attaches a
 * bearer to everything it sends — from ever growing a method that must not have one.
 *
 * Every response field is optional on the way in and narrowed before it becomes a `Session`. The
 * server half (D2/D3) is being built in parallel and is not merged; a client that assumed a field
 * it never received would store half a credential, which `core/session/session.ts` exists to make
 * impossible.
 */

/** `POST /auth/activate` — a worker binds this phone to his identity, once. */
export interface ActivateRequest {
  username: string;
  /** Canonical, folded, 8 characters. Never the raw string the field held. */
  activation_code: string;
  /** What the admin will see in his device list. Provenance, not a user-facing string. */
  device_name: string;
}

export interface ActivateWorkerResponse {
  user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
}

export interface ActivateCompanyResponse {
  id?: string | null;
  name?: string | null;
}

/**
 * **Two shapes, because the two halves of this feature disagree** — found 2026-08-31, while
 * fixing what the founder hit on a real phone.
 *
 * `plans/profile-and-identity.md` §8 specifies `{device_token, worker, company}` and this client
 * was written to it (F3). The endpoint that shipped (D3, `AuthEndpoints.cs` → `ActivateResponse`
 * in `Contracts/IdentityContracts.cs`) puts the worker's fields at the **top level** instead:
 * `user_id`, `username`, `display_name`, plus `device_name` and `language`. Nothing failed
 * loudly: `toSession` read `response.worker?.user_id`, got `undefined`, refused the half-session
 * exactly as it is designed to, and the screen told the foreman that joining had not worked and
 * that his code was not used up. **Both halves of that sentence were false** — the device row
 * existed and the single-use code was spent — and the founder, believing it, spent a second one.
 *
 * So this type carries both spellings and `toSession` reads whichever arrived. It is not
 * indecision: a client standing between a man and the record button must read what the server
 * actually sends, and tolerating a field in two places costs one `??`. **The divergence itself is
 * a doc question for the founder** — §8 and the endpoint have to be made to agree, and whichever
 * way that lands, this file already speaks it.
 */
export interface ActivateResponse extends ActivateWorkerResponse {
  device_token?: string | null;
  device_id?: string | null;
  /** What the admin will see in his device list. Echoed back; read by nothing yet. */
  device_name?: string | null;
  /** The worker's UI language as the server holds it. F5's subject; ignored here. */
  language?: string | null;
  /** The nested spelling, per plan §8. Absent from what the server sends today. */
  worker?: ActivateWorkerResponse | null;
  company?: ActivateCompanyResponse | null;
  /**
   * Whether the code was emailed. `not_configured` when no relay exists, which is every
   * environment today (§9) — read by nothing on this screen, kept because the field is part of
   * the contract and dropping it from the type would hide it from the next reader.
   *
   * Not sent by the endpoint that shipped either; optional, so its absence costs nothing.
   */
  email_delivery?: string | null;
}

/**
 * `POST /auth/activation-code` — decision 14's self-service path.
 *
 * **Always 202**, whether or not the username exists, because a login surface must not be an
 * account-enumeration oracle. There is no response body worth reading and the screen's sentence
 * is uniform.
 */
export interface RequestActivationCodeRequest {
  username: string;
}

/** `POST /auth/login` — the two admin roles. A worker never sees a password field. */
export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  session_token?: string | null;
  expires_at?: string | null;
  /** `company_admin` | `super_admin`. Which admin surface to open — `/company` exists since F6. */
  role?: string | null;
  /**
   * The person this session belongs to.
   *
   * Read off `LoginResponse` in `Contracts/IdentityContracts.cs` and confirmed against a live
   * `POST /auth/login` before being declared here — the discipline `auth-types.ts` learned when
   * the plan and the endpoint disagreed about `/auth/activate` and a foreman paid for it.
   */
  user_id?: string | null;
  display_name?: string | null;
  /** Null for a super admin, who has no company by construction (`ck_app_user_company_scope`). */
  company?: ActivateCompanyResponse | null;
}
