import { Injectable } from '@angular/core';

import { GeoFix } from '../db/models';

/**
 * Position fixes from the Geolocation API.
 *
 * Web photo capture carries **no EXIF** (ARCHITECTURE.md §5), so this is the only source of
 * location the PWA has. Every call is best-effort: a denied permission, a phone indoors in a
 * concrete stairwell, or a timeout all resolve to `null`. Location is evidence we would like,
 * never a precondition for saving — a capture must not fail because the sky is not visible.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  /**
   * A fix, or `null` if one cannot be had in time.
   *
   * `maximumAge` accepts a fix up to a minute old: on a site the phone has not moved far, and a
   * fresh lock can take longer than the foreman is willing to stand still.
   */
  currentFix(options: { timeoutMs?: number; maximumAgeMs?: number } = {}): Promise<GeoFix | null> {
    const { timeoutMs = 8000, maximumAgeMs = 60_000 } = options;

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return Promise.resolve(null);
    }

    return new Promise<GeoFix | null>((resolve) => {
      let settled = false;
      const finish = (fix: GeoFix | null) => {
        if (!settled) {
          settled = true;
          resolve(fix);
        }
      };

      // A belt-and-braces timer: some platforms are slow to honour `timeout` when the permission
      // prompt is on screen, and nothing in the capture flow may hang on this.
      const guard = setTimeout(() => finish(null), timeoutMs + 500);

      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(guard);
          finish({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
            fixedAt: new Date(position.timestamp).toISOString(),
          });
        },
        () => {
          clearTimeout(guard);
          finish(null);
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs },
      );
    });
  }
}
