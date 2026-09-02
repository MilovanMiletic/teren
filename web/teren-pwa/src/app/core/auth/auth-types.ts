/**
 * The wire shapes of the three unauthenticated routes (`plans/profile-and-identity.md` §8).
 *
 * snake_case, like every other body this API exchanges. Written out here rather than reused from
 * `core/api/api-types.ts` because these routes live under `/auth`, deliberately **not** under
 * `/api`: keeping them in a separate file is what keeps `TerenApiClient` — which attaches a
 * bearer to everything it sends — from ever growing a method that must not have one.
 *
 * Every response field is optional on the way in and narrowed before it becomes a `Session`. That
 * was written when the server half (D2/D3) was unmerged, and it is not relaxed now that it has
 * shipped: a phone outlives a deploy, so this build will meet a response an older or newer server
 * shaped differently, and a client that assumed a field it never received would store half a
 * credential — which `core/session/session.ts` exists to make impossible.
 */

/** `POST /auth/activate` — a worker binds this phone to his identity, once. */
export interface ActivateRequest {
  username: string;
  /** Canonical, folded, 8 characters. Never the raw string the field held. */
  activation_code: string;
  /** What the admin will see in his device list. Provenance, not a user-facing string. */
  device_name: string;
}

export interface ActivateCompanyResponse {
  id?: string | null;
  name?: string | null;
}

/**
 * **One shape. It was two, and the story is worth keeping** — because of how the divergence hid.
 *
 * `plans/profile-and-identity.md` §8 originally specified `{device_token, worker, company}` and
 * this client was written to it (F3). The endpoint that shipped (D3, `AuthEndpoints.cs` →
 * `ActivateResponse` in `Contracts/IdentityContracts.cs`) put the worker's fields at the **top
 * level** instead. Nothing failed loudly: `toSession` read `response.worker?.user_id`, got
 * `undefined`, refused the half-session exactly as it is designed to, and the screen told the
 * foreman that joining had not worked and that his code was not used up. **Both halves of that
 * sentence were false** — the device row existed and the single-use code was spent — and the
 * founder, believing it, spent a second one.
 *
 * The stopgap was to read both spellings. That is gone as of F4's last gating item, in the only
 * order that was safe: **§8 was amended to the flat shape first, then the serialized field names
 * were pinned server-side** — `ActivationTests.The_activate_response_carries_exactly_the_field_
 * names_the_client_reads` asserts the whole property-name set, so a rename or a re-nesting fails
 * there rather than here. Dropping the tolerance before that pin existed would only have restored
 * the original failure mode.
 *
 * **The lesson, which outlives the fix:** every field below is optional and narrowed before it
 * becomes a `Session`, so a server that stops sending one produces `null` — a screen asking for a
 * code — and never a half-credential. That is the right failure, but it is a *silent* one on the
 * client, which is why the loud half now lives in a backend test.
 */
export interface ActivateResponse {
  device_token?: string | null;
  device_id?: string | null;
  /** What the admin will see in his device list. Echoed back; read by nothing yet. */
  device_name?: string | null;
  user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
  /** The worker's UI language as the server holds it. F5's subject; ignored here. */
  language?: string | null;
  company?: ActivateCompanyResponse | null;
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

/**
 * `POST /auth/password` — an invited administrator choosing his own passphrase.
 *
 * **Unauthenticated, and validated on the token alone.** That is what makes the link work for a man
 * who has never signed in, and it is also why the link is a credential: whoever opens it first sets
 * the password. Twelve characters minimum, no composition rules — length is what matters
 * (`PasswordPolicy`).
 */
export interface SetPasswordRequest {
  token: string;
  password: string;
}

/**
 * The address is echoed back so the screen can hand it to the login form he is about to see.
 * Not a leak: the caller has just proved he holds a single-use token issued for that account.
 */
export interface SetPasswordResponse {
  email?: string | null;
  role?: string | null;
}
