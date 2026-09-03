import { EntryStore } from '../core/db/entry-store';
import { LocalEntry, Project } from '../core/db/models';

export const TEST_PROJECT: Project = {
  id: 'project-1',
  name: 'Stambena zgrada Vojvode Stepe 212',
  address: 'Vojvode Stepe 212, Voždovac, Beograd',
};

export interface CaptureFixtureOptions {
  entryId?: string;
  project?: Project;
  capturedAt?: string;
  mimeType?: string;
  /** One entry per chunk the recorder would have handed over. */
  chunks?: Uint8Array<ArrayBuffer>[];
  durationMs?: number;
  photoCount?: number;
  /**
   * The entry this take corrects, when the fixture is producing a correction (2026-09-03).
   *
   * Handed to `beginCapture` and not written onto the finished row, deliberately: the link lives on
   * the **session** so that a take the tab dies in the middle of is still assembled as a correction
   * by the start-up sweep. A fixture that set it afterwards would prove nothing about that path.
   */
  supersedesEntryId?: string | null;
}

/**
 * Drive a capture through the same path the recorder uses — open a session, write chunks, finish.
 * Specs that need an entry on disk go through this rather than reaching into the tables, so what
 * they assert on is what the app actually produces.
 */
export async function captureEntry(
  store: EntryStore,
  options: CaptureFixtureOptions = {},
): Promise<LocalEntry> {
  const entryId = options.entryId ?? crypto.randomUUID();
  const chunks = options.chunks ?? [new Uint8Array([1, 2, 3, 4])];

  await store.beginCapture({
    entryId,
    project: options.project ?? TEST_PROJECT,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    mimeType: options.mimeType ?? 'audio/ogg;codecs=opus',
    supersedesEntryId: options.supersedesEntryId ?? null,
  });

  for (const chunk of chunks) {
    await store.appendChunk(entryId, new Blob([chunk], { type: 'audio/ogg;codecs=opus' }));
  }

  const entry = await store.finishCapture(entryId, { durationMs: options.durationMs ?? 41_000 });
  if (!entry) {
    throw new Error('captureEntry produced no entry — did you pass zero chunks on purpose?');
  }

  for (let index = 0; index < (options.photoCount ?? 0); index += 1) {
    await store.addPhoto(entryId, {
      blob: new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' }),
      mimeType: 'image/jpeg',
      width: 1600,
      height: 1200,
      capturedAt: new Date().toISOString(),
      originalByteSize: 4_000_000,
      originalMimeType: 'image/heic',
      geo: null,
    });
  }

  return (await store.getEntry(entryId)) as LocalEntry;
}
