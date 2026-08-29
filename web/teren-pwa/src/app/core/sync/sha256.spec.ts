import { UploadFailure } from '../api/api-failure';
import { canComputeDigests, sha256Hex } from './sha256';

describe('sha256Hex', () => {
  it('produces the 64 lowercase hex characters the server validates', async () => {
    // The published SHA-256 of "abc" — a fixed vector, so this fails if the algorithm or the
    // hex encoding is ever wrong, not merely if it changes.
    const digest = await sha256Hex(new Blob([new TextEncoder().encode('abc')]));

    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the bytes, not the container type', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const asAudio = await sha256Hex(new Blob([bytes], { type: 'audio/ogg;codecs=opus' }));
    const asPhoto = await sha256Hex(new Blob([bytes], { type: 'image/jpeg' }));

    expect(asAudio).toBe(asPhoto);
  });

  it('pads a byte below 0x10 to two hex digits', async () => {
    // A hand-rolled hex encoder that forgets to pad produces a 63-character string for roughly
    // one blob in four, which the server rejects with a 400 that says nothing about padding.
    const digest = await sha256Hex(new Blob([new Uint8Array([7])]));

    expect(digest).toHaveLength(64);
  });

  describe('when the origin is not a secure context', () => {
    // `crypto.subtle` is undefined on a plain-http origin that is not localhost — which is
    // exactly what a phone reaches a dev machine through. The absence is a missing property, not
    // a thrown error, so without this guard the first symptom is a TypeError deep in the upload
    // loop that names neither crypto nor the address bar.
    let subtle: SubtleCrypto;

    beforeEach(() => {
      subtle = globalThis.crypto.subtle;
      Object.defineProperty(globalThis.crypto, 'subtle', {
        value: undefined,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(globalThis.crypto, 'subtle', { value: subtle, configurable: true });
    });

    it('reports it', () => {
      expect(canComputeDigests()).toBe(false);
    });

    it('fails with a terminal `insecure_context`, not a TypeError', async () => {
      const failure = await sha256Hex(new Blob([new Uint8Array([1])])).catch((error) => error);

      expect(failure).toBeInstanceOf(UploadFailure);
      expect(failure.kind).toBe('insecure_context');
      // Terminal on purpose: no number of retries turns http:// into https://.
      expect(failure.terminal).toBe(true);
    });
  });

  it('reports a usable secure context in a normal environment', () => {
    expect(canComputeDigests()).toBe(true);
  });
});
