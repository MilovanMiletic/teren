import { TestBed } from '@angular/core/testing';

import { GeolocationService } from './geolocation.service';
import { IMAGE_COMPRESSOR } from './image-compression';
import { PhotoCaptureService } from './photo-capture.service';

/**
 * The invariant under test is a product rule, not an implementation detail: metadata comes off
 * the original file and the position fix is requested **before** the image is compressed.
 * Compression re-encodes through a canvas and destroys everything else.
 *
 * The compressor itself is replaced here — canvas encoding has no jsdom equivalent, so the real
 * 1600 px / JPEG 0.8 path is verified in a browser, not in this suite.
 */
describe('PhotoCaptureService', () => {
  let calls: string[];
  let service: PhotoCaptureService;

  const fix = {
    latitude: 44.77,
    longitude: 20.48,
    accuracyM: 9,
    fixedAt: '2026-08-29T14:06:00.000Z',
  };

  function configure(currentFix: () => Promise<typeof fix | null>): PhotoCaptureService {
    TestBed.configureTestingModule({
      providers: [
        { provide: GeolocationService, useValue: { currentFix } },
        {
          provide: IMAGE_COMPRESSOR,
          useValue: async () => {
            calls.push('compress');
            return {
              blob: new Blob([new Uint8Array([7, 7, 7])], { type: 'image/jpeg' }),
              mimeType: 'image/jpeg',
              width: 1600,
              height: 1200,
            };
          },
        },
      ],
    });
    return TestBed.inject(PhotoCaptureService);
  }

  beforeEach(() => {
    calls = [];
    service = configure(async () => {
      calls.push('geolocation');
      return fix;
    });
  });

  function cameraFile(lastModified: number): File {
    return new File([new Uint8Array(new Array(64).fill(1))], 'IMG_0042.jpg', {
      type: 'image/jpeg',
      lastModified,
    });
  }

  it('requests the position fix before compressing', async () => {
    await service.prepare(cameraFile(Date.parse('2026-08-29T14:05:30.000Z')));
    expect(calls).toEqual(['geolocation', 'compress']);
  });

  it('takes the timestamp from the original file, not from the compressed result', async () => {
    const photo = await service.prepare(cameraFile(Date.parse('2026-08-29T14:05:30.000Z')));
    expect(photo.capturedAt).toBe('2026-08-29T14:05:30.000Z');
  });

  it('records what compression achieved: original size and type alongside the JPEG', async () => {
    const photo = await service.prepare(cameraFile(Date.parse('2026-08-29T14:05:30.000Z')));

    expect(photo.originalByteSize).toBe(64);
    expect(photo.originalMimeType).toBe('image/jpeg');
    expect(photo.mimeType).toBe('image/jpeg');
    expect(photo.width).toBe(1600);
    expect(photo.geo).toEqual(fix);
  });

  it('falls back to now when the picker reports no timestamp, never to 1970', async () => {
    const before = Date.now();
    const photo = await service.prepare(cameraFile(0));
    expect(Date.parse(photo.capturedAt)).toBeGreaterThanOrEqual(before);
  });

  it('keeps the photo when there is no position fix — location is evidence, not a gate', async () => {
    TestBed.resetTestingModule();
    calls = [];
    const withoutFix = configure(async () => null);

    const photo = await withoutFix.prepare(cameraFile(Date.now()));
    expect(photo.geo).toBeNull();
    expect(photo.blob.size).toBe(3);
  });
});
