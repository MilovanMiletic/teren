import { Injectable, inject } from '@angular/core';

import { CapturedPhoto } from '../db/entry-store';
import { GeolocationService } from './geolocation.service';
import { IMAGE_COMPRESSOR } from './image-compression';

/**
 * Turns a file straight off the camera into a photo ready for the local store.
 *
 * The ordering here is a product rule, not a style choice (CLAUDE.md): **metadata is taken from
 * the original file, and the position fix is requested, before the image is compressed.**
 * Compression re-encodes through a canvas and throws every scrap of metadata away, so anything
 * read afterwards is already gone. Web capture carries no EXIF either way, which is why the
 * location comes from the Geolocation API instead.
 */
@Injectable({ providedIn: 'root' })
export class PhotoCaptureService {
  private readonly geolocation = inject(GeolocationService);
  private readonly compress = inject(IMAGE_COMPRESSOR);

  async prepare(file: File): Promise<CapturedPhoto> {
    // 1. Metadata, from the original file, before anything touches the pixels.
    const originalByteSize = file.size;
    const originalMimeType = file.type || 'image/jpeg';
    // `lastModified` is the moment the camera wrote the file. Some pickers report 0; falling back
    // to "now" keeps the record honest to within seconds rather than claiming 1970.
    const capturedAt = new Date(
      file.lastModified > 0 ? file.lastModified : Date.now(),
    ).toISOString();

    // 2. Ask for the fix now, so the request is in flight while the CPU is busy re-encoding.
    const fixPromise = this.geolocation.currentFix();

    // 3. Only now compress.
    const compressed = await this.compress(file);
    const geo = await fixPromise;

    return {
      blob: compressed.blob,
      mimeType: compressed.mimeType,
      width: compressed.width,
      height: compressed.height,
      capturedAt,
      originalByteSize,
      originalMimeType,
      geo,
    };
  }
}
