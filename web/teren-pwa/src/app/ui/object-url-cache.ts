/**
 * Object URLs for blobs held in IndexedDB.
 *
 * The store keeps real blobs, never URLs — an object URL dies with the document, so persisting one
 * would mean persisting a broken photo. Views mint a URL when they need to paint a thumbnail and
 * hand it back when they are torn down; anything less leaks the whole photo into memory for the
 * life of the tab.
 */
export class ObjectUrlCache {
  private readonly urls = new Map<string, string>();

  get(key: string, blob: Blob): string {
    let url = this.urls.get(key);
    if (!url) {
      url = URL.createObjectURL(blob);
      this.urls.set(key, url);
    }
    return url;
  }

  /** Release every URL whose key is no longer in `keep`. */
  retain(keep: Iterable<string>): void {
    const wanted = new Set(keep);
    for (const [key, url] of this.urls) {
      if (!wanted.has(key)) {
        URL.revokeObjectURL(url);
        this.urls.delete(key);
      }
    }
  }

  releaseAll(): void {
    this.retain([]);
  }
}
