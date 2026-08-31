/**
 * The wire shapes of the company-admin surface, **read off the endpoints rather than the plan**.
 *
 * Every interface here was written against `src/Teren.Api/Contracts/IdentityContracts.cs` and
 * checked against a live response from the running API (`GET /api/workers`, `GET /api/devices`),
 * not against `plans/profile-and-identity.md` §8. That is a rule this feature learned the
 * expensive way on 2026-08-31: §8 specified a nested `worker` object for `/auth/activate`, the
 * endpoint shipped a flat one, the client believed the plan, and a foreman was told his
 * single-use code was untouched after the server had spent it.
 *
 * snake_case throughout, because that is this API's canonical spelling in both directions
 * (`Program.cs` sets `JsonNamingPolicy.SnakeCaseLower`).
 *
 * Fields are declared optional where an older or newer server might not send them, and every
 * value is narrowed in `company.service.ts` before it reaches a screen. Nothing here is nullable
 * out of politeness: each `null` below is a state an admin has to be able to read — a worker with
 * no email cannot ask for his own replacement code, a phone with no `last_seen_at` has never
 * called home.
 */

/** One foreman, as `GET /api/workers` describes him. */
export interface WorkerResponse {
  id?: string | null;
  username?: string | null;
  display_name?: string | null;
  email?: string | null;
  language?: string | null;
  created_at?: string | null;
  /** Non-null means he has been taken out of service. Never a delete — evidence stays nameable. */
  disabled_at?: string | null;
  /** Phones still allowed to record as him. One, normally; zero until he has activated at all. */
  active_device_count?: number | null;
  last_seen_at?: string | null;
  /**
   * True when there is a code he could type right now.
   *
   * The admin's cue to **read** the code rather than issue a new one — issuing supersedes
   * whatever the man is holding, which is exactly the operational trap the plan reversed its
   * "hash only" design to avoid (§5).
   */
  has_live_activation_code?: boolean | null;
}

export interface WorkerListResponse {
  workers?: WorkerResponse[] | null;
  count?: number | null;
}

/** `POST /api/workers`. Username is deliberately not sent — see `CompanyService.addWorker`. */
export interface CreateWorkerRequest {
  display_name: string;
  email?: string;
  language?: string;
}

export interface CreateWorkerResponse {
  worker?: WorkerResponse | null;
  activation_code?: ActivationCodeResponse | null;
}

/** A live activation code, in the display form the admin reads aloud: `XKD4-7HMP`. */
export interface ActivationCodeResponse {
  code?: string | null;
  created_at?: string | null;
  expires_at?: string | null;
  /** `not_configured` | `no_address` | `queued`. Every environment answers the first today. */
  email_delivery?: string | null;
}

/** `GET /api/workers/{id}/share-text` — the ready-made message, in *his* language. */
export interface ShareTextResponse {
  text?: string | null;
  language?: string | null;
  activation_code?: ActivationCodeResponse | null;
}

/** One phone, as `GET /api/devices` describes it. */
export interface DeviceResponse {
  id?: string | null;
  name?: string | null;
  user_id?: string | null;
  worker_display_name?: string | null;
  worker_username?: string | null;
  created_at?: string | null;
  /** Throttled to five minutes server-side: "within the last few minutes", not a per-request stamp. */
  last_seen_at?: string | null;
  revoked_at?: string | null;
}

export interface DeviceListResponse {
  devices?: DeviceResponse[] | null;
  count?: number | null;
}
