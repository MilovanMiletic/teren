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

export interface ActivateResponse {
  device_token?: string | null;
  device_id?: string | null;
  worker?: ActivateWorkerResponse | null;
  company?: ActivateCompanyResponse | null;
  /**
   * Whether the code was emailed. `not_configured` when no relay exists, which is every
   * environment today (§9) — read by nothing on this screen, kept because the field is part of
   * the contract and dropping it from the type would hide it from the next reader.
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
  /** `company_admin` | `super_admin`. Which admin surface to open, once one exists. */
  role?: string | null;
  display_name?: string | null;
  company?: ActivateCompanyResponse | null;
}
