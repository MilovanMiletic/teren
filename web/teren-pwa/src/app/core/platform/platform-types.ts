/**
 * The wire shapes of the platform surface, **read off the endpoints rather than the plan**.
 *
 * Every interface here was written against `src/Teren.Api/Contracts/PlatformContracts.cs`. That is
 * a rule this feature learned the expensive way on 2026-08-31: plan §8 specified a nested `worker`
 * object for `/auth/activate`, the endpoint shipped a flat one, the client believed the plan, and
 * a foreman was told his single-use code was untouched after the server had spent it.
 *
 * snake_case throughout (`Program.cs` sets `JsonNamingPolicy.SnakeCaseLower`).
 *
 * Fields are optional on the way in and narrowed in `platform.service.ts` before they reach a
 * screen. The `null`s are not politeness: a super admin has no company *by constraint*, an account
 * that has never signed in has no `last_login_at`, and a customer that was never suspended has no
 * `suspended_at`. Each is a state the founder has to be able to read.
 */

/** One customer, as `GET /api/platform/companies` describes it. */
export interface PlatformCompanyResponse {
  id?: string | null;
  name?: string | null;
  created_at?: string | null;
  /** Non-null means withdrawn: every credential of theirs 401s on next contact. */
  suspended_at?: string | null;
  /** People, not diaries. The platform never learns anything about a customer's work. */
  user_count?: number | null;
  active_user_count?: number | null;
}

export interface PlatformCompanyListResponse {
  companies?: PlatformCompanyResponse[] | null;
  /** Null on the last page. Opaque — built by the server, never parsed here. */
  next_cursor?: string | null;
}

/** One account, anywhere in the product. */
export interface PlatformUserResponse {
  id?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  /** `super_admin` | `company_admin` | `worker`. */
  role?: string | null;
  username?: string | null;
  display_name?: string | null;
  email?: string | null;
  language?: string | null;
  created_at?: string | null;
  last_login_at?: string | null;
  disabled_at?: string | null;
  /**
   * Never had a password set. **Never the hash, and never a hint about it beyond its existence** —
   * this is the `status=pending` filter's whole meaning and the state the founder looks for when
   * an onboarding has stalled.
   */
  password_pending?: boolean | null;
}

export interface PlatformUserListResponse {
  users?: PlatformUserResponse[] | null;
  next_cursor?: string | null;
}

/** `POST /api/platform/companies`. */
export interface CreateCompanyRequest {
  name: string;
}

/**
 * `POST /api/platform/users`.
 *
 * `company_id` is required for a `company_admin` and **must be absent for a `super_admin`** —
 * `ck_app_user_company_scope` makes "a super admin inside a tenant" unstorable, so the server
 * answers a sentence rather than letting a CHECK produce a 500.
 */
export interface CreateAdminRequest {
  role: string;
  display_name: string;
  email: string;
  company_id?: string;
  language?: string;
}

/**
 * What came of asking for an invite.
 *
 * **No token and no URL** (founder, 2026-09-01). The set-password link used to come back here so
 * it could be read down the phone; it is now minted inside the server's invite job and emailed to
 * exactly one address, so there is nothing in this body a credential could hide in.
 *
 * `emailed: false` is the honest half: with no relay configured nothing was sent and the account
 * has no way in, which the screen has to say rather than imply a mail is in flight.
 */
export interface InviteSentResponse {
  email?: string | null;
  emailed?: boolean | null;
}

/** `POST /api/platform/users` — the account, and whether his invite went out. */
export interface CreateAdminResponse {
  user?: PlatformUserResponse | null;
  emailed?: boolean | null;
}
