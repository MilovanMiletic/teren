import { entryStatusKey, entryStatusTone } from './entry-status';

describe('entryStatusKey', () => {
  it('lets the server have the last word once it has one', () => {
    expect(entryStatusKey('reported', 'confirmed_by_server')).toBe('entry.status.reported');
    expect(entryStatusKey('confirmed', 'confirmed_by_server')).toBe('entry.status.confirmed');
    expect(entryStatusKey('awaiting_confirmation', 'confirmed_by_server')).toBe(
      'entry.status.awaitingReview',
    );
  });

  it('keeps "needs review" apart from "awaiting confirmation"', () => {
    // One is a day waiting for a person to approve it; the other is a pipeline failure where the
    // record holds raw evidence and no structure. The archive is where that difference shows.
    expect(entryStatusKey('needs_review', null)).toBe('entry.status.needsReview');
    expect(entryStatusTone('needs_review', null)).toBe('err');
  });

  it('never disguises a blocked entry as ordinary waiting', () => {
    // The whole reason the blocked state exists is that "waiting to upload" would be a lie.
    expect(entryStatusKey(null, 'blocked')).toBe('pending.status.blocked');
    expect(entryStatusTone(null, 'blocked')).toBe('err');
  });

  it('says the same thing about a draft as about a queued entry', () => {
    // To the person holding the phone they are the same fact: this has not reached the server.
    expect(entryStatusKey(null, 'draft')).toBe(entryStatusKey(null, 'queued'));
  });

  it('answers for an entry this device never captured', () => {
    // A row that came back from the archive list alone — a second phone, or a pruned local copy.
    expect(entryStatusKey('received', null)).toBe('entry.status.received');
    expect(entryStatusTone('received', null)).toBe('neutral');
    expect(entryStatusKey('processing', null)).toBe('entry.status.processing');
  });

  it('gives a sent entry the only "ok" tone in the set', () => {
    expect(entryStatusTone('reported', null)).toBe('ok');
    expect(entryStatusTone('confirmed', null)).toBe('neutral');
    expect(entryStatusTone(null, 'queued')).toBe('warn');
  });
});
