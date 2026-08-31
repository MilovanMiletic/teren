/**
 * The credential an **admin** holds in this browser, and how it survives a reload.
 *
 * ## Why it is not `Session`
 *
 * `Session` (`session.ts`) describes a *device bound to a worker*: it carries a device id and a
 * username, and `API_CONFIG` hands its token to every `/api` call as this phone's bearer. An admin
 * session is a different credential entirely — it proves a *person* signed in with a password, it
 * has an expiry, and it belongs to nobody's phone. Writing one into the device slot would make the
 * app claim a device it does not have on the one path where provenance ends up on an evidence row,
 * which is why `ActivationService.login` deliberately stored nothing until this file existed.
 *
 * They are therefore two keys, two services and two bearers, and **the two never mix**: the
 * company screen's gateway sends this token, `TerenApiClient` sends the device one, and no code
 * path can fall back from one to the other.
 *
 * ## Why `localStorage`, and why the read is synchronous
 *
 * Same two reasons as the device session, and one more. The route gate for `/company` has to
 * answer on the first frame with no awaited promise (hazard H3), so the credential is read during
 * construction of a root service, exactly as `readStoredSession()` is.
 *
 * ## Why every read is narrowed field by field
 *
 * A row written by an older build must resolve to `null` — a whole session or none. Half a
 * credential would have the app believing it is signed in and sending a bearer it cannot describe,
 * and the failure would surface as a 401 in the middle of an admin's work rather than as a login
 * screen.
 *
 * ## An admin session may be discarded, and a worker's may not
 *
 * PROJECT.md principle 3 forbids deleting anything *local* — evidence. This holds no evidence: it
 * is a password-backed credential on what may well be a shared office tablet, and signing out
 * removes exactly one `localStorage` row and touches not a single Dexie record. That asymmetry is
 * deliberate and is why `discard()` lives here and nowhere near `SessionService`.
 */

/** The three roles the server may report at login. Only one of them has a screen today. */
export type AdminRole = 'company_admin' | 'super_admin';

/** What `POST /auth/login` handed back, as this browser remembers it. */
export interface AdminSession {
  /** The bearer sent on every admin `/api` request. */
  token: string;
  /** ISO-8601. The server decides it — 30 days for a company admin, 8 hours for Teren staff. */
  expiresAt: string;
  role: AdminRole;
  userId: string;
  displayName: string;
  /**
   * The company he administers. **Null if and only if he is a super admin** — the database makes
   * a super admin inside a tenant impossible (`ck_app_user_company_scope`), so a null here is the
   * correct answer rather than a missing one.
   */
  companyId: string | null;
  companyName: string | null;
  /** When this browser signed in, ISO-8601. Shown back to him, never sent. */
  signedInAt: string;
}

export const ADMIN_SESSION_STORAGE_KEY = 'teren.admin';

/**
 * Read the stored admin session, or `null` if there is not a complete, unexpired one.
 *
 * Every failure mode ends at `null` and none of them throws: `localStorage` can throw on access in
 * private mode, `JSON.parse` throws on a half-written value, and a row from an older build can be
 * missing fields this build requires. This runs during construction of a root service, so a throw
 * would be a blank app rather than a login screen.
 *
 * **An expired session is read as no session.** It is the one narrowing rule that is about time
 * rather than shape: a token the server will refuse is worth exactly as much as no token, and
 * resolving it to `null` here means the guard sends him to sign in again instead of letting him
 * reach a screen that can only show him errors.
 */
export function readStoredAdminSession(now = new Date()): AdminSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ADMIN_SESSION_STORAGE_KEY);
  } catch {
    // Storage unavailable. Indistinguishable, from here, from never having signed in.
    return null;
  }
  if (!raw) {
    return null;
  }

  let session: AdminSession | null;
  try {
    session = narrow(JSON.parse(raw));
  } catch {
    return null;
  }

  return session && !hasExpired(session, now) ? session : null;
}

/** Whether the server would still accept this session, as far as its own expiry can say. */
export function hasExpired(session: AdminSession, now = new Date()): boolean {
  const expiry = Date.parse(session.expiresAt);
  // An unparseable expiry is treated as expired. The alternative — trusting a value this build
  // cannot read — is how a screen ends up insisting it is signed in against every 401 it meets.
  return Number.isNaN(expiry) || expiry <= now.getTime();
}

/**
 * Write the session. Best effort, and deliberately so: a quota error means one more sign-in after
 * the next reload, and it must never take down the sign-in that produced it.
 */
export function persistAdminSession(session: AdminSession): void {
  try {
    localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // The credential just will not survive a reload.
  }
}

/** Forget it. The only credential in this app that may be forgotten — see the file comment. */
export function clearAdminSession(): void {
  try {
    localStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
  } catch {
    // Private mode; there was nothing persisted to remove.
  }
}

/** Every field, or nothing. See the file comment for why half a credential is the worst outcome. */
function narrow(value: unknown): AdminSession | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;

  const token = text(row['token']);
  const expiresAt = text(row['expiresAt']);
  const role = text(row['role']);
  const userId = text(row['userId']);
  const displayName = text(row['displayName']);
  const signedInAt = text(row['signedInAt']);

  if (!token || !expiresAt || !userId || !displayName || !signedInAt) {
    return null;
  }
  if (role !== 'company_admin' && role !== 'super_admin') {
    // A role this build has never heard of is not a role it may act on. There is no `unknown`
    // member here as there is on the profile screen: that one *describes* a person and can say
    // "a role this app does not recognise", while this one *authorises* a screen.
    return null;
  }

  // The company is nullable by construction, so it is narrowed but never required.
  return {
    token,
    expiresAt,
    role,
    userId,
    displayName,
    companyId: text(row['companyId']),
    companyName: text(row['companyName']),
    signedInAt,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
