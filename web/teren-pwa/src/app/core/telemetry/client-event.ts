/**
 * The wire shape of `POST /api/client-events`, and the rules that decide what may travel on it.
 *
 * ## Why the validation lives on the phone as well as on the server
 *
 * The server validates and **rejects rather than sanitises** — that is the security boundary and
 * it is not this file's job to be it. What this file is for is the other half: the phone must not
 * *compose* an event it knows the server will refuse, because a rejected event is a lost log line
 * and a batch that fails on one bad row is a batch that gets retried for ever. So the same rules
 * are applied here, at the moment an event is recorded, where the offending field can still be
 * dropped without losing the rest of the event.
 *
 * ## The rule the whole feature rests on
 *
 * **Nothing a person typed or read may reach this shape.** An `action` is a slug from a closed
 * vocabulary; a `route` is a path with its query string and fragment cut off; a `detail` value may
 * only be a number, a boolean, or a slug. There is no field here that free text fits into, and
 * that is deliberate: a site diary's content is a customer's commercial record, and an action log
 * that could carry a transcript would be a second, unguarded copy of it.
 *
 * Snake_case on the wire, as everywhere else in this product.
 */

/** How far a `detail` map may go: ten keys, matching the server's cap exactly. */
export const MAX_DETAIL_KEYS = 10;

/** The longest an action slug may be. Longer is refused whole by the server. */
export const MAX_ACTION_LENGTH = 80;

/**
 * `area.thing.verb` — one bare first segment, then one to four dotted segments.
 *
 * Copied character for character from the contract. Hyphens are allowed after the first segment
 * and not in it, which is why a structural descriptor is `ui.app-column-menu.button` and never
 * `app-column-menu.button`.
 */
export const ACTION_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9-]+){1,4}$/;

/**
 * A route may carry an id. It may never carry what somebody typed.
 *
 * No `?`, no `#`, and no character outside the set the contract names — so a Cyrillic segment or
 * a search term smuggled into a path fails here and the event is dropped rather than trimmed.
 */
export const ROUTE_PATTERN = /^\/[A-Za-z0-9/_:.\-]{0,120}$/;

/** A `detail` key: lower snake, at most 31 characters. */
const DETAIL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

/** A `detail` string value: a slug, so a value can never be a sentence. */
const DETAIL_SLUG_PATTERN = /^[a-z0-9_.\-]{1,40}$/;

/** The longest an action may claim to have taken — an hour, as the server caps it. */
const MAX_DURATION_MS = 3_600_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How an action ended, when the answer is not implied by the action itself. */
export type ActionOutcome = 'ok' | 'fail' | 'cancel' | 'blocked';

/** What a `detail` map may hold, before scrubbing. Anything else is dropped key and all. */
export type DetailValue = string | number | boolean | null | undefined | object;

/**
 * One recorded action, exactly as it goes on the wire.
 *
 * `id` is generated on the device, like an entry's: it is the correlation the server files the
 * row under, so a founder reading a log line and a phone that sent it twice name the same thing.
 */
export interface ClientEvent {
  id: string;
  at: string;
  action: string;
  route: string;
  outcome?: ActionOutcome;
  duration_ms?: number;
  entry_id?: string;
  project_id?: string;
  detail?: Record<string, string | number | boolean>;
}

/** What the caller of {@link buildEvent} supplies. Everything but the action is optional. */
export interface ActionFacts {
  outcome?: ActionOutcome;
  durationMs?: number;
  entryId?: string | null;
  projectId?: string | null;
  detail?: Record<string, DetailValue> | null;
}

/** `202 { accepted, rejected }` — never a 4xx for a partly bad batch. */
export interface ClientEventReceipt {
  accepted?: number | null;
  rejected?: number | null;
}

/** Whether a string is an action the server will accept. */
export function isAction(value: string): boolean {
  return value.length <= MAX_ACTION_LENGTH && ACTION_PATTERN.test(value);
}

/**
 * The path of a URL, with everything the contract forbids removed — or `null`.
 *
 * `null` is a real answer and the caller drops the whole event on it. A route this app cannot
 * express safely is not worth a log line, and the alternative — substituting `/` — would file the
 * action under a screen it did not happen on, which is worse than not knowing.
 */
export function safeRoute(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const path = url.split('#')[0].split('?')[0];
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return ROUTE_PATTERN.test(normalised) ? normalised : null;
}

/**
 * Keep only what the server would keep of a `detail` map.
 *
 * A bad key is dropped and the event survives — the same rule the server applies — because the
 * interesting half of an event is the action and the route, and throwing those away over a stray
 * object in `detail` would lose the line for the sake of tidiness.
 *
 * **A string with a space in it is not a slug and does not survive.** That is the clause that
 * makes it structurally impossible for a project name, an address or a transcript fragment to
 * ride along in a detail value, however carelessly a future call site is written.
 */
export function scrubDetail(
  detail: Record<string, DetailValue> | null | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!detail) {
    return undefined;
  }

  const kept: Record<string, string | number | boolean> = {};
  let count = 0;

  for (const [key, value] of Object.entries(detail)) {
    if (count >= MAX_DETAIL_KEYS || !DETAIL_KEY_PATTERN.test(key)) {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        continue;
      }
      kept[key] = value;
    } else if (typeof value === 'boolean') {
      kept[key] = value;
    } else if (typeof value === 'string' && DETAIL_SLUG_PATTERN.test(value)) {
      kept[key] = value;
    } else {
      continue;
    }
    count += 1;
  }

  return count > 0 ? kept : undefined;
}

/**
 * Compose one event, or refuse to.
 *
 * `null` means the action or the route could not be expressed within the contract, which is the
 * one case where the honest thing is to record nothing at all. Every other field is narrowed
 * rather than refused: a duration out of range is dropped, an `entryId` that is not a UUID is
 * dropped, a bad `detail` key is dropped, and the event still describes what was pressed and
 * where.
 */
export function buildEvent(
  action: string,
  route: string | null,
  at: string,
  facts: ActionFacts = {},
): ClientEvent | null {
  if (!isAction(action)) {
    return null;
  }
  const path = safeRoute(route);
  if (path === null) {
    return null;
  }

  const event: ClientEvent = { id: crypto.randomUUID(), at, action, route: path };

  if (facts.outcome) {
    event.outcome = facts.outcome;
  }

  const duration = facts.durationMs;
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    // Rounded and clamped rather than dropped: a stopwatch that read 3 600 001 ms still says
    // something true about how long a man waited, and the server would refuse the event whole.
    event.duration_ms = Math.min(Math.max(Math.round(duration), 0), MAX_DURATION_MS);
  }

  if (facts.entryId && UUID_PATTERN.test(facts.entryId)) {
    event.entry_id = facts.entryId;
  }
  if (facts.projectId && UUID_PATTERN.test(facts.projectId)) {
    event.project_id = facts.projectId;
  }

  const detail = scrubDetail(facts.detail);
  if (detail) {
    event.detail = detail;
  }

  return event;
}
