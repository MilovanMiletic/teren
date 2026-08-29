import { DOCUMENT, Injectable, inject } from '@angular/core';

/**
 * How long an object URL is kept alive after the download has been started.
 *
 * Revoking is not optional — an object URL pins the whole blob, and a multi-megabyte PDF held for
 * the life of the tab is exactly the leak this exists to avoid. But revoking *immediately* is the
 * other failure: the browser resolves the URL asynchronously after the synthetic click, and
 * Safari in particular hands the blob to its PDF viewer well after the click returns. A URL
 * revoked underneath it produces an empty viewer and no error anywhere.
 *
 * A minute is far longer than any browser needs to start reading and far shorter than "for ever".
 */
export const OBJECT_URL_LIFETIME_MS = 60_000;

/**
 * Hand a blob to the person using the app.
 *
 * ## Why a blob and not a link
 *
 * The report is served by an authenticated endpoint (`PROJECT.md` §11, ruling 5: an API that
 * streams the bytes, never a presigned GET, because a presigned URL works for anyone holding it
 * and this is a client's commercial data). A plain `<a href>` cannot carry a bearer token, so the
 * bytes are fetched by the app and only then given to the browser as a file.
 *
 * ## iOS Safari
 *
 * The `download` attribute has been honoured on iOS since Safari 13, but iOS decides what to do
 * with a file largely from its MIME type, and it may show the PDF in a viewer with a share sheet
 * rather than writing it silently into Files. That is an acceptable outcome — the foreman still
 * gets the document and can forward it, which is the point of the feature — and it is the reason
 * the caller normalises the blob's type to `application/pdf` before it arrives here.
 *
 * **Not verified on a real iPhone.** Nobody on this project has one; see the session report.
 */
@Injectable({ providedIn: 'root' })
export class FileSaver {
  private readonly document = inject(DOCUMENT);

  /**
   * Save `blob` under `filename`.
   *
   * Synchronous by design: it must run inside the tap that asked for it, because a browser is far
   * more willing to start a download while the user's activation is still fresh.
   */
  save(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    try {
      const anchor = this.document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      // Off-screen rather than `display: none`: a few browsers refuse to act on a click
      // dispatched at an undisplayed element.
      anchor.style.position = 'fixed';
      anchor.style.left = '-9999px';
      this.document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        // Even if the click threw: an orphaned anchor carrying a blob href is a second leak.
        anchor.remove();
      }
    } finally {
      // In `finally` because a URL minted and then orphaned by a throw is the same leak, minus
      // the download.
      setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
    }
  }
}
