import { parseEntryStructure } from '../archive/entry-structure';

/**
 * The entry structure while a human is editing it.
 *
 * This is deliberately **not** the v1 wire shape (ARCHITECTURE §6) and not the read model in
 * `core/archive/entry-structure.ts`. Three differences, each of them the reason this file exists:
 *
 * 1. **Every field is a string.** `40` and `"40,"` are the same keystroke apart, and a foreman
 *    typing a quantity passes through half a dozen states that are not numbers. Binding an
 *    `<input>` to a `number | null` means either rejecting his keystrokes or storing `NaN`; a
 *    string stores exactly what he typed and is parsed once, on the way to the server. It also
 *    lets **`40,5` work**, which matters — the decimal separator in Serbian is a comma, and an
 *    input that silently drops the fractional part of a quantity is worse than one that refuses
 *    it.
 *
 * 2. **Every row carries an id.** Editable rows may never be tracked by index: removing the first
 *    of three materials would leave Angular reusing the DOM of row 0 for the old row 1, which
 *    moves the caret and the text the user is halfway through typing into a different line. The
 *    id is local to the session and is never sent.
 *
 * 3. **Blank rows are allowed to exist.** "Add a material" has to put an empty row on screen
 *    before there is anything to put in it. {@link toCorrectedPayload} is what decides that a row
 *    with no name is not a material, so the screen never has to.
 *
 * The whole file is pure: no Angular, no Dexie, no HTTP. It is the part of the confirmation
 * screen that is worth testing without a screen.
 */

/** A quantity as typed: `"40"` / `"40,5"` / `""`, and a free-text unit (`m`, `kom`, `m2`). */
export interface DraftQuantity {
  value: string;
  unit: string;
}

export interface DraftWorkItem {
  id: string;
  description: string;
  location: string;
  quantity: DraftQuantity;
}

export interface DraftRole {
  id: string;
  role: string;
  count: string;
}

export interface DraftMaterial {
  id: string;
  name: string;
  quantity: DraftQuantity;
  /**
   * Three states, not two. `null` is "he did not say", which is what the extraction produces for
   * most lines and is a different fact from "ordered and not delivered" — a distinction a report
   * has to carry, so the screen cycles through all three rather than offering a checkbox.
   */
  delivered: boolean | null;
}

export interface DraftBlocker {
  id: string;
  description: string;
  waitingOn: string;
}

export interface DraftHiddenWork {
  id: string;
  description: string;
  /**
   * Carried through untouched. The screen never edits these — they are references to media the
   * extraction attached — but dropping them on a round trip would quietly detach the photograph
   * from the covered-up work it proves, which is the single highest-value link in the product.
   */
  mediaIds: string[];
}

export interface EntryDraft {
  workDone: DraftWorkItem[];
  /** The whole crew, as typed. Separate from `roles` because most days only ever say a number. */
  headcountTotal: string;
  roles: DraftRole[];
  materials: DraftMaterial[];
  blockers: DraftBlocker[];
  hiddenWork: DraftHiddenWork[];
  notes: string;
}

/** The schema version every `corrected` payload must carry (ARCHITECTURE §6; the API validates it). */
export const ENTRY_SCHEMA_VERSION = 1;

export function emptyDraft(): EntryDraft {
  return {
    workDone: [],
    headcountTotal: '',
    roles: [],
    materials: [],
    blockers: [],
    hiddenWork: [],
    notes: '',
  };
}

/**
 * A row id that is unique within this session.
 *
 * `crypto.randomUUID` is not reachable on an insecure origin in every browser, and a row id is
 * not evidence — it never leaves the screen — so a counter is both sufficient and immune to the
 * secure-context problem that bites hashing (`core/sync/sha256.ts`).
 */
let rowSeq = 0;
export function draftRowId(): string {
  rowSeq += 1;
  return `r${rowSeq}`;
}

// ------------------------------------------------------------------- building the empty rows

export function newWorkItem(): DraftWorkItem {
  return { id: draftRowId(), description: '', location: '', quantity: { value: '', unit: '' } };
}

export function newRole(): DraftRole {
  return { id: draftRowId(), role: '', count: '' };
}

export function newMaterial(): DraftMaterial {
  return { id: draftRowId(), name: '', quantity: { value: '', unit: '' }, delivered: null };
}

export function newBlocker(): DraftBlocker {
  return { id: draftRowId(), description: '', waitingOn: '' };
}

export function newHiddenWork(): DraftHiddenWork {
  return { id: draftRowId(), description: '', mediaIds: [] };
}

// ------------------------------------------------------------------------------ from the model

/**
 * Seed a draft from whatever the pipeline produced — `corrected` if a person has already been
 * here, `structure` otherwise, and `null` when extraction never ran.
 *
 * `null` is not an error case to be handled at the edges: with no Anthropic key configured every
 * entry reaches this screen with no structure at all, and after B4 ships it is still what happens
 * whenever extraction fails. So the null path returns a perfectly usable empty draft and the
 * screen behaves identically — that is the typed fallback the founder asked for, and it is the
 * everyday path, not the exception.
 */
export function draftFromStructure(raw: unknown): EntryDraft {
  const parsed = parseEntryStructure(raw);
  if (!parsed) {
    return emptyDraft();
  }

  return {
    workDone: parsed.workDone.map((item) => ({
      id: draftRowId(),
      description: item.description,
      location: item.location ?? '',
      quantity: quantityToDraft(item.quantity),
    })),
    headcountTotal: numberToDraft(parsed.headcount?.total ?? null),
    roles: (parsed.headcount?.roles ?? []).map((role) => ({
      id: draftRowId(),
      role: role.role,
      count: numberToDraft(role.count),
    })),
    materials: parsed.materials.map((item) => ({
      id: draftRowId(),
      name: item.name,
      quantity: quantityToDraft(item.quantity),
      delivered: item.delivered,
    })),
    blockers: parsed.blockers.map((item) => ({
      id: draftRowId(),
      description: item.description,
      waitingOn: item.waitingOn ?? '',
    })),
    hiddenWork: parsed.hiddenWork.map((item) => ({
      id: draftRowId(),
      description: item.description,
      mediaIds: item.mediaIds,
    })),
    notes: parsed.notes ?? '',
  };
}

// --------------------------------------------------------------------------- to the wire shape

/**
 * The `corrected` payload for `POST /api/entries/{id}/confirm`.
 *
 * **All seven v1 keys are always present**, empty arrays included. The server's validator only
 * insists on `schema_version`, but the extraction schema declares every key required and nullable
 * on purpose (`EntryStructureSchema`): "no materials today" is `materials: []`, a fact, while a
 * missing key is an absence of one. Since these payloads become the *corrected* third of the
 * eval triple (ARCHITECTURE §9.3), a human answer that omitted a section would read, months
 * later, as the model having been right about a section nobody checked.
 *
 * Blank rows are dropped rather than sent: a row with no description is the screen's scaffolding,
 * not the foreman's answer.
 */
export function toCorrectedPayload(draft: EntryDraft): Record<string, unknown> {
  return {
    schema_version: ENTRY_SCHEMA_VERSION,
    work_done: draft.workDone
      .filter((item) => text(item.description) !== null)
      .map((item) => ({
        description: text(item.description),
        location: text(item.location),
        quantity: quantityToWire(item.quantity),
      })),
    headcount: headcountToWire(draft),
    materials: draft.materials
      .filter((item) => text(item.name) !== null)
      .map((item) => ({
        name: text(item.name),
        quantity: quantityToWire(item.quantity),
        delivered: item.delivered,
      })),
    blockers: draft.blockers
      .filter((item) => text(item.description) !== null)
      .map((item) => ({
        description: text(item.description),
        waiting_on: text(item.waitingOn),
      })),
    hidden_work: draft.hiddenWork
      .filter((item) => text(item.description) !== null)
      .map((item) => ({
        description: text(item.description),
        media_ids: item.mediaIds,
      })),
    notes: text(draft.notes),
  };
}

// ------------------------------------------------------- approving the transcript as the record

/**
 * The top-level flag that marks a `corrected` payload as *the foreman's own words*, approved
 * as-is, rather than a day somebody typed out.
 *
 * The structure column is JSONB precisely so fields can differ per trade (CLAUDE.md), so an extra
 * key is legitimate. This one is load-bearing in two places at once:
 *
 * - **the report** renders the day as his description instead of as an empty structured day,
 *   which is what an entry with `work_done: []` and nothing else would otherwise produce — a
 *   report saying nothing happened;
 * - **the eval set** (ARCHITECTURE §9.3) stays honest. `extracted` is null and `corrected` now
 *   records *approval-as-is*, which is a different fact from a human having typed those same
 *   words into the notes field. Without the flag the two are byte-identical, and months later a
 *   replay would read every transcript-shaped note as a person's independent answer. That is the
 *   same reason B5 refused to auto-fill the notes field.
 */
export const DESCRIBED_VERBATIM = 'described_verbatim';

/**
 * The `corrected` payload for "these are my words, send them" — the pinned contract the report
 * generator is built against.
 *
 * `notes` carries the transcript exactly as it was handed in, with every other section empty and
 * `headcount` null, because nothing was extracted and nothing was typed. The string is **not
 * touched here**: what the caller passes is what goes on the wire, and the caller passes the same
 * string the screen is displaying, so what he approved is character-for-character what is sent.
 *
 * All seven v1 keys are present for the reason {@link toCorrectedPayload} gives — "no materials
 * today" is `materials: []`, a fact, while a missing key is an absence of one.
 */
export function verbatimCorrectedPayload(transcript: string): Record<string, unknown> {
  return {
    schema_version: ENTRY_SCHEMA_VERSION,
    work_done: [],
    headcount: null,
    materials: [],
    blockers: [],
    hidden_work: [],
    notes: transcript,
    [DESCRIBED_VERBATIM]: true,
  };
}

/**
 * Whether a stored `corrected` was an approval of the transcript rather than a typed day.
 *
 * Read when the screen re-opens an entry that has already been confirmed this way. Such a payload
 * must **not** seed the editable form: putting the transcript into the notes box would present
 * his approved words as text he typed, which is precisely the distinction the flag exists to
 * keep — and confirming again from that seeded draft would send them back without the flag,
 * quietly demoting a verbatim record to a typed one.
 */
export function isVerbatimCorrected(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)[DESCRIBED_VERBATIM] === true
  );
}

/**
 * Whether the draft would send the server an entry with nothing in it.
 *
 * The confirmation gate exists so a person vouches for a day's record; vouching for a blank one
 * produces a report with no content and a `confirmed` status claiming somebody checked it.
 * ARCHITECTURE §6 already says an entry with no audio and no text parks in `needs_review` rather
 * than flowing into a report empty — this is the same rule one step later, at the human.
 */
export function draftIsEmpty(draft: EntryDraft): boolean {
  const payload = toCorrectedPayload(draft);
  return (
    (payload['work_done'] as unknown[]).length === 0 &&
    (payload['materials'] as unknown[]).length === 0 &&
    (payload['blockers'] as unknown[]).length === 0 &&
    (payload['hidden_work'] as unknown[]).length === 0 &&
    payload['headcount'] === null &&
    payload['notes'] === null
  );
}

// --------------------------------------------------------------------- reading a stored draft

/**
 * Narrow a draft read back from the local store.
 *
 * Same reasoning as `parseEntryStructure`: what comes out of IndexedDB was written by *some*
 * build of this app, not necessarily this one, and a screen that threw while restoring a draft
 * would lose exactly the typing it exists to protect. Anything unrecognisable is dropped, and
 * fresh row ids are minted so the restored rows track correctly in a list that is about to be
 * edited again.
 */
export function readStoredDraft(raw: unknown): EntryDraft | null {
  const root = asRecord(raw);
  if (!root) {
    return null;
  }
  return {
    workDone: asArray(root['workDone'])
      .map((entry) => {
        const item = asRecord(entry);
        return item
          ? {
              id: draftRowId(),
              description: asString(item['description']),
              location: asString(item['location']),
              quantity: readQuantity(item['quantity']),
            }
          : null;
      })
      .filter(isPresent),
    headcountTotal: asString(root['headcountTotal']),
    roles: asArray(root['roles'])
      .map((entry) => {
        const item = asRecord(entry);
        return item
          ? { id: draftRowId(), role: asString(item['role']), count: asString(item['count']) }
          : null;
      })
      .filter(isPresent),
    materials: asArray(root['materials'])
      .map((entry) => {
        const item = asRecord(entry);
        return item
          ? {
              id: draftRowId(),
              name: asString(item['name']),
              quantity: readQuantity(item['quantity']),
              delivered: typeof item['delivered'] === 'boolean' ? item['delivered'] : null,
            }
          : null;
      })
      .filter(isPresent),
    blockers: asArray(root['blockers'])
      .map((entry) => {
        const item = asRecord(entry);
        return item
          ? {
              id: draftRowId(),
              description: asString(item['description']),
              waitingOn: asString(item['waitingOn']),
            }
          : null;
      })
      .filter(isPresent),
    hiddenWork: asArray(root['hiddenWork'])
      .map((entry) => {
        const item = asRecord(entry);
        return item
          ? {
              id: draftRowId(),
              description: asString(item['description']),
              mediaIds: asArray(item['mediaIds'])
                .map((id) => (typeof id === 'string' ? id : null))
                .filter(isPresent),
            }
          : null;
      })
      .filter(isPresent),
    notes: asString(root['notes']),
  };
}

// ----------------------------------------------------------------------------------- internals

function headcountToWire(draft: EntryDraft): Record<string, unknown> | null {
  const total = parseDraftNumber(draft.headcountTotal);
  const roles = draft.roles
    .filter((role) => text(role.role) !== null)
    .map((role) => ({ role: text(role.role), count: parseDraftNumber(role.count) }));
  // "Nobody said how many people were on site" is not "zero people on site". A headcount object
  // with nothing in it would claim the second.
  return total === null && roles.length === 0 ? null : { total, roles };
}

function quantityToWire(quantity: DraftQuantity): Record<string, unknown> | null {
  const value = parseDraftNumber(quantity.value);
  const unit = text(quantity.unit);
  return value === null && unit === null ? null : { value, unit };
}

function quantityToDraft(
  quantity: { value: number | null; unit: string | null } | null,
): DraftQuantity {
  return {
    value: numberToDraft(quantity?.value ?? null),
    unit: quantity?.unit ?? '',
  };
}

/**
 * A number back into the box it was typed in.
 *
 * Printed with a comma, because that is the separator the value will be re-typed and re-read
 * with, and a field that shows `40.5` after showing `40,5` looks like the app corrected the
 * foreman.
 */
function numberToDraft(value: number | null): string {
  return value === null ? '' : String(value).replace('.', ',');
}

/**
 * Read a typed quantity. Accepts both separators, tolerates spaces, and refuses anything that is
 * not a plain number — `"oko 40"` is a note, not a quantity, and inventing 40 from it would be
 * the screen making up evidence.
 */
export function parseDraftNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Trimmed, or null when there is nothing there. Whitespace is not content. */
function text(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readQuantity(raw: unknown): DraftQuantity {
  const item = asRecord(raw);
  return { value: asString(item?.['value']), unit: asString(item?.['unit']) };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
