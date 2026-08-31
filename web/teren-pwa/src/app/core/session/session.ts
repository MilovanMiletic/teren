/**
 * The credential this phone holds, and how it survives a reload.
 *
 * ## Why `localStorage` and not Dexie
 *
 * Everything else this app persists is evidence, and evidence lives in Dexie. A session is not
 * evidence — it is a credential, and losing one costs a single re-activation. Two properties
 * decide it:
 *
 * 1. **`db.open()` resolves after first paint.** The route guard that decides whether to show the
 *    record button or the activation screen has to answer synchronously, on the first frame, with
 *    no awaited promise (`plans/profile-and-identity.md` §10.3).
 * 2. **A database that will not open would become indistinguishable from "not activated".** That
 *    is the failure that matters: private mode, an exhausted quota or a corrupt store would send
 *    an activated foreman to a code screen he cannot complete, in a basement, holding a day of
 *    work. `localStorage` cannot fail that way, and when it does fail it fails to `null`, which
 *    costs one re-activation instead of a day.
 *
 * ## Why every read is narrowed field by field
 *
 * A row written by an older build must resolve to `null` — a whole session or none. A partially
 * recognised session is the worst outcome available: the app would believe it is activated and
 * send a bearer it cannot describe, and the failure would surface as a 401 on the upload path
 * rather than as a screen that asks for a code.
 */

/** What `POST /auth/activate` hands back, as this device remembers it. */
export interface Session {
  /** The bearer sent on every `/api` request. The only field the API layer reads. */
  token: string;
  /** The device row this token belongs to. Provenance; never sent by the client. */
  deviceId: string;
  userId: string;
  /** The worker's durable identity — it outlives any phone. */
  username: string;
  displayName: string;
  /** Which company's data this phone may see. A change here invalidates the cached project list. */
  companyId: string;
  companyName: string;
  /** When this phone was activated, ISO-8601. */
  activatedAt: string;
}

export const SESSION_STORAGE_KEY = 'teren.session';

/**
 * Read the stored session, or `null` if there is not a complete one.
 *
 * Every failure mode ends at `null` and none of them throws: `localStorage` itself can throw on
 * access in private mode, `JSON.parse` throws on a half-written value, and a row from an older
 * build can be missing fields this build requires. Bootstrap must never be able to fail
 * (`app.config.ts`), and this is read during construction of a root service — so a throw here
 * would be a blank app rather than a login screen.
 */
export function readStoredSession(): Session | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage unavailable. Indistinguishable, from here, from never having been activated.
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    return narrow(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Write the session. Best effort, and deliberately so.
 *
 * A quota error here means the credential will not survive a reload — one re-activation, once. It
 * must never take down the activation that produced it, because the token is already good and the
 * phone can record and upload with it for as long as the app stays open.
 */
export function persistSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // The credential just will not survive a reload.
  }
}

/** Every field, or nothing. See the file comment for why a half-session is the worst outcome. */
function narrow(value: unknown): Session | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;

  const token = text(row['token']);
  // A session whose token is blank is not a session: it would make `usable()` true while every
  // request went out with an empty bearer.
  if (!token) {
    return null;
  }

  const deviceId = text(row['deviceId']);
  const userId = text(row['userId']);
  const username = text(row['username']);
  const displayName = text(row['displayName']);
  const companyId = text(row['companyId']);
  const companyName = text(row['companyName']);
  const activatedAt = text(row['activatedAt']);

  if (
    !deviceId ||
    !userId ||
    !username ||
    !displayName ||
    !companyId ||
    !companyName ||
    !activatedAt
  ) {
    return null;
  }

  return {
    token,
    deviceId,
    userId,
    username,
    displayName,
    companyId,
    companyName,
    activatedAt,
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
