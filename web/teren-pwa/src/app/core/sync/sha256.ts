import { UploadFailure } from '../api/api-failure';

/**
 * SHA-256 over the exact bytes about to be uploaded, as the 64 lowercase hex characters the
 * server's validator demands.
 *
 * ## The secure-context trap
 *
 * `crypto.subtle` **only exists in a secure context**. `https://…`, `http://localhost` and
 * `http://127.0.0.1` qualify; `http://192.168.1.x` and a plain-http tunnel do not — and the
 * failure mode is not an exception from the algorithm but `crypto.subtle` being `undefined`, so
 * naive code dies with "cannot read properties of undefined" somewhere unrelated to the cause.
 *
 * This bites precisely where it is least convenient: **the phone**. Reaching the dev machine from
 * a real device means a tunnel or a LAN address, and the moment that address is not https there
 * is no digest, therefore no media declaration, therefore no upload — while everything else in
 * the app keeps working, which makes it look like an upload bug. So the absence is detected up
 * front and reported as its own terminal failure kind (`insecure_context`) with its own message,
 * rather than as a mystery crash or a retry that can never succeed.
 *
 * The whole blob is read into memory: `crypto.subtle.digest` has no streaming form. At the sizes
 * this product produces (a ~30 s Opus note is ~100 KB, a compressed photo ~300 KB, and the server
 * caps audio at 25 MB / photos at 10 MB) that is fine, and the alternative — a hand-rolled
 * incremental SHA-256 in JavaScript — would be slower and less trustworthy than the platform's.
 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const subtle = subtleCrypto();
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return toHex(new Uint8Array(digest));
}

/** True when this origin can hash at all. Cheap; safe to call on every pass. */
export function canComputeDigests(): boolean {
  return typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle;
}

function subtleCrypto(): SubtleCrypto {
  if (!canComputeDigests()) {
    throw new UploadFailure(
      'insecure_context',
      'crypto.subtle is unavailable: this origin is not a secure context (https or localhost)',
    );
  }
  return globalThis.crypto.subtle;
}

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}
