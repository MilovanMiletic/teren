/**
 * The entry structure JSONB (ARCHITECTURE §6, schema v1), read for display.
 *
 * Two rules shape every line of this file.
 *
 * **The values are content, not chrome.** `work_done[].description`, a material name, a role —
 * these are the foreman's own Serbian, extracted from what he said, and they are never
 * translated, normalised, title-cased or otherwise improved on the way to the screen (PROJECT.md
 * principle 2). Only the section labels are localised, and those are translation keys, not data.
 *
 * **The shape is a model's output, so nothing in it is guaranteed.** `structure` is written by a
 * Claude call; a field can be missing, null, a number where a string was expected, or an object
 * where an array was. Parsing defensively is not paranoia here — a detail screen that throws on a
 * malformed extraction would hide the *raw transcript*, which is the evidence that actually
 * matters and is always there when the structure is not. So every reader below narrows, and
 * anything it cannot narrow is dropped rather than rendered as `[object Object]`.
 */

export interface Quantity {
  value: number | null;
  /** The unit exactly as extracted — `m`, `kom`, `m2`. Never converted. */
  unit: string | null;
}

export interface WorkItem {
  description: string;
  location: string | null;
  quantity: Quantity | null;
}

export interface HeadcountRole {
  role: string;
  count: number | null;
}

export interface Headcount {
  total: number | null;
  roles: HeadcountRole[];
}

export interface MaterialItem {
  name: string;
  quantity: Quantity | null;
  /** Null when the extraction did not say either way — which is not the same as "not delivered". */
  delivered: boolean | null;
}

export interface BlockerItem {
  description: string;
  waitingOn: string | null;
}

export interface HiddenWorkItem {
  description: string;
  mediaIds: string[];
}

export interface EntryStructure {
  /** Present from day one so a future trade template can evolve the shape without a migration. */
  schemaVersion: number | null;
  workDone: WorkItem[];
  headcount: Headcount | null;
  materials: MaterialItem[];
  blockers: BlockerItem[];
  /** The highest-value evidence in the product: what cannot be proven once the wall closes. */
  hiddenWork: HiddenWorkItem[];
  notes: string | null;
  /**
   * True when the object parsed but carries nothing to show.
   *
   * A present-but-empty extraction and a missing one are different facts and the screen says
   * different things about them: "the model found nothing in this recording" is a result,
   * "nothing has been extracted yet" is a stage of the pipeline.
   */
  empty: boolean;
}

/**
 * Read a structure payload. Returns null when there is nothing to read at all — no extraction has
 * run yet, which is the normal state of every entry captured before B4 populates it.
 */
export function parseEntryStructure(raw: unknown): EntryStructure | null {
  const root = asRecord(raw);
  if (!root) {
    return null;
  }

  const workDone = asArray(root['work_done']).map(readWorkItem).filter(isPresent);
  const headcount = readHeadcount(root['headcount']);
  const materials = asArray(root['materials']).map(readMaterial).filter(isPresent);
  const blockers = asArray(root['blockers']).map(readBlocker).filter(isPresent);
  const hiddenWork = asArray(root['hidden_work']).map(readHiddenWork).filter(isPresent);
  const notes = asText(root['notes']);

  return {
    schemaVersion: asNumber(root['schema_version']),
    workDone,
    headcount,
    materials,
    blockers,
    hiddenWork,
    notes,
    empty:
      workDone.length === 0 &&
      materials.length === 0 &&
      blockers.length === 0 &&
      hiddenWork.length === 0 &&
      notes === null &&
      (headcount === null || (headcount.total === null && headcount.roles.length === 0)),
  };
}

/** Weather as the enrichment job writes it (C2). Same defensive treatment, same reasons. */
export interface EntryWeather {
  conditions: string | null;
  temperatureMinC: number | null;
  temperatureMaxC: number | null;
  precipitationMm: number | null;
  source: string | null;
}

export function parseEntryWeather(raw: unknown): EntryWeather | null {
  const root = asRecord(raw);
  if (!root) {
    return null;
  }
  const weather: EntryWeather = {
    conditions: asText(root['conditions']),
    temperatureMinC: asNumber(root['temperature_min_c']),
    temperatureMaxC: asNumber(root['temperature_max_c']),
    precipitationMm: asNumber(root['precipitation_mm']),
    source: asText(root['source']),
  };
  const hasReading =
    weather.conditions !== null ||
    weather.temperatureMinC !== null ||
    weather.temperatureMaxC !== null ||
    weather.precipitationMm !== null;
  return hasReading ? weather : null;
}

// ---------------------------------------------------------------------------- section readers

function readWorkItem(raw: unknown): WorkItem | null {
  const item = asRecord(raw);
  const description = item && asText(item['description']);
  // An entry with no description is not a work item, whatever else it carries.
  if (!item || !description) {
    return null;
  }
  return {
    description,
    location: asText(item['location']),
    quantity: readQuantity(item['quantity']),
  };
}

function readHeadcount(raw: unknown): Headcount | null {
  const item = asRecord(raw);
  if (!item) {
    return null;
  }
  const roles = asArray(item['roles'])
    .map((entry) => {
      const role = asRecord(entry);
      const name = role && asText(role['role']);
      return name ? { role: name, count: asNumber(role['count']) } : null;
    })
    .filter(isPresent);
  return { total: asNumber(item['total']), roles };
}

function readMaterial(raw: unknown): MaterialItem | null {
  const item = asRecord(raw);
  const name = item && asText(item['name']);
  if (!item || !name) {
    return null;
  }
  return {
    name,
    quantity: readQuantity(item['quantity']),
    delivered: typeof item['delivered'] === 'boolean' ? item['delivered'] : null,
  };
}

function readBlocker(raw: unknown): BlockerItem | null {
  const item = asRecord(raw);
  const description = item && asText(item['description']);
  if (!item || !description) {
    return null;
  }
  return { description, waitingOn: asText(item['waiting_on']) };
}

function readHiddenWork(raw: unknown): HiddenWorkItem | null {
  const item = asRecord(raw);
  const description = item && asText(item['description']);
  if (!item || !description) {
    return null;
  }
  return {
    description,
    mediaIds: asArray(item['media_ids'])
      .map((id) => asText(id))
      .filter(isPresent),
  };
}

function readQuantity(raw: unknown): Quantity | null {
  const item = asRecord(raw);
  if (!item) {
    return null;
  }
  const value = asNumber(item['value']);
  const unit = asText(item['unit']);
  // `"quantity": {"value": null, "unit": null}` is how the extraction says "he did not say a
  // number". Rendering an empty quantity row would invent a fact.
  return value === null && unit === null ? null : { value, unit };
}

// ------------------------------------------------------------------------------- narrowing

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/** A string with something in it. Whitespace-only is the same as absent for display purposes. */
function asText(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
