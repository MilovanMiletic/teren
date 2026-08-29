import { LocalEntryStatus } from '../core/db/models';

export type StatusTone = 'ok' | 'warn' | 'err' | 'neutral';

/**
 * What an entry's state is called, in one place.
 *
 * The phone and the server keep deliberately different vocabularies (ARCHITECTURE §6), and the
 * person holding the phone does not care which of the two answered — he cares whether the work is
 * safe, being looked at, or stuck. Three screens ask that question (Home's recent rows, the
 * archive list, the entry record) and three answers that disagreed would be worse than none, so
 * the mapping lives here rather than in each template.
 *
 * `local` is null for an entry this device never captured — a row that came back from
 * `GET /api/entries` alone. That is not an error state: it is the archive doing its job on a
 * second phone, or on the distributor's tablet.
 */
export function entryStatusKey(
  serverStatus: string | null,
  localStatus: LocalEntryStatus | null,
  sealed?: boolean | null,
): string {
  const fromServer = serverStatusKey(serverStatus);
  if (fromServer) {
    return fromServer;
  }
  if (localStatus) {
    return localStatusKey(localStatus);
  }
  // Nothing local to fall back on: the row exists only because the server listed it. `received`
  // means the JSON arrived; `received_at` means the *evidence* is sealed, and only the second one
  // is "we have it" (ARCHITECTURE §6). A half-uploaded entry from another phone claiming to be
  // received would be this screen vouching for evidence the server does not hold.
  return sealed === false ? 'entry.status.incomplete' : 'entry.status.received';
}

/**
 * The server's word, where it has one worth showing.
 *
 * `received` is deliberately absent: it means "the server has the evidence and has not started",
 * which is the same news as the phone's `confirmed_by_server` and is better said once, by the
 * fallback below.
 */
function serverStatusKey(serverStatus: string | null): string | null {
  switch (serverStatus) {
    case 'processing':
      return 'entry.status.processing';
    case 'awaiting_confirmation':
      return 'entry.status.awaitingReview';
    // Not the same thing as awaiting confirmation, and the archive is the screen where the
    // difference shows: transcription or extraction failed, and the record holds raw evidence
    // rather than a structured day.
    case 'needs_review':
      return 'entry.status.needsReview';
    case 'confirmed':
      return 'entry.status.confirmed';
    case 'reported':
      return 'entry.status.reported';
    default:
      return null;
  }
}

function localStatusKey(localStatus: LocalEntryStatus): string {
  switch (localStatus) {
    // Terminal. No screen may disguise it as ordinary waiting — the whole reason the state
    // exists is that "waiting to upload" would be a lie about this entry.
    case 'blocked':
      return 'pending.status.blocked';
    case 'failed':
      return 'pending.status.retrying';
    case 'uploading':
      return 'sync.uploadingToServer';
    case 'confirmed_by_server':
      return 'entry.status.received';
    // A draft says the same thing a queued entry says, because it is the same thing to the
    // person holding the phone: this has not reached the server yet.
    default:
      return 'pending.status.queued';
  }
}

export function entryStatusTone(
  serverStatus: string | null,
  localStatus: LocalEntryStatus | null,
  sealed?: boolean | null,
): StatusTone {
  if (serverStatus === 'reported') {
    return 'ok';
  }
  if (serverStatus === 'needs_review') {
    return 'err';
  }
  if (serverStatus === 'awaiting_confirmation') {
    return 'warn';
  }
  if (serverStatus === 'confirmed') {
    return 'neutral';
  }
  if (localStatus === 'blocked') {
    return 'err';
  }
  if (localStatus === null) {
    // A server row whose evidence is not sealed is still in motion, not at rest.
    return sealed === false ? 'warn' : 'neutral';
  }
  if (localStatus === 'confirmed_by_server') {
    return 'neutral';
  }
  return 'warn';
}
