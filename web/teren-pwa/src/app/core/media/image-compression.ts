import { InjectionToken } from '@angular/core';

/** Long edge in CSS pixels after compression (CLAUDE.md engineering conventions). */
export const PHOTO_LONG_EDGE = 1600;

/** JPEG quality after compression. */
export const PHOTO_QUALITY = 0.8;

export interface CompressedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Downscale a captured photo to 1600 px on the long edge and re-encode it as JPEG ~0.8.
 *
 * Orientation: the source is decoded with `imageOrientation: 'from-image'`, so a photo taken with
 * the phone sideways is rotated into its upright form before it is drawn. Without that, a canvas
 * re-encode silently drops the orientation tag and every landscape shot arrives rotated.
 *
 * This throws away metadata by design — which is exactly why every caller reads the timestamp and
 * requests a position fix from the *original* file before calling this.
 */
export async function compressImage(
  file: Blob,
  options: { longEdge?: number; quality?: number } = {},
): Promise<CompressedImage> {
  const longEdge = options.longEdge ?? PHOTO_LONG_EDGE;
  const quality = options.quality ?? PHOTO_QUALITY;

  const source = await decode(file);
  try {
    const scale = Math.min(1, longEdge / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas 2D context unavailable');
    }
    context.drawImage(source.image, 0, 0, width, height);

    const blob = await toJpeg(canvas, quality);
    return { blob, mimeType: 'image/jpeg', width, height };
  } finally {
    source.release();
  }
}

export type ImageCompressor = (
  file: Blob,
  options?: { longEdge?: number; quality?: number },
) => Promise<CompressedImage>;

/**
 * The compressor as a dependency. Canvas encoding is a browser capability with no jsdom
 * equivalent, so the specs that assert *when* compression happens replace it here rather than
 * pretending a canvas exists.
 */
export const IMAGE_COMPRESSOR = new InjectionToken<ImageCompressor>('IMAGE_COMPRESSOR', {
  providedIn: 'root',
  factory: () => compressImage,
});

interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decode(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Safari has historically rejected the options bag; fall through to the <img> path.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    // Browsers that lack `createImageBitmap` options still apply EXIF orientation to an <img>
    // when it is told to.
    image.decoding = 'sync';
    (image as HTMLImageElement & { style: CSSStyleDeclaration }).style.imageOrientation =
      'from-image';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Image could not be decoded'));
      image.src = url;
    });
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas produced no image'))),
      'image/jpeg',
      quality,
    );
  });
}
