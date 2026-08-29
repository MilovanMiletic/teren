import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { switchMap } from 'rxjs';

import { EntryNotOpenError, EntryStore } from '../../core/db/entry-store';
import { LocalEntry, LocalMedia } from '../../core/db/models';
import { PhotoCaptureService } from '../../core/media/photo-capture.service';
import { AppHeader } from '../../ui/app-header';
import { DurationPipe } from '../../ui/duration.pipe';
import { Icon } from '../../ui/icon';
import { ObjectUrlCache } from '../../ui/object-url-cache';
import { PluralService } from '../../ui/plural.service';

/**
 * Saved locally (`design/CaptureSaved.dc.html`).
 *
 * By the time this screen renders, the recording is already on disk — that is the whole point of
 * the copy on it. Photos are added here, one at a time, each compressed and stored before the
 * thumbnail appears. "Gotovo" is the explicit hand-over to the sync queue (`draft → queued`);
 * B3 adds the loop that empties it, and needs no change here.
 *
 * The upload-progress card from the artboard belongs to B3 and is deliberately absent: showing a
 * progress bar for an upload that cannot happen yet would be the one thing this product must
 * never do about sync state — lie.
 */
@Component({
  selector: 'app-capture-saved-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppHeader, DurationPipe, Icon, TranslocoDirective],
  templateUrl: './capture-saved-page.html',
  styleUrl: './capture-saved-page.css',
})
export class CaptureSavedPage {
  private readonly router = inject(Router);
  private readonly entries = inject(EntryStore);
  private readonly photos = inject(PhotoCaptureService);
  protected readonly plural = inject(PluralService);

  /** Route parameter, bound by `withComponentInputBinding()`. */
  readonly entryId = input.required<string>();

  protected readonly entry = signal<LocalEntry | null>(null);
  protected readonly loaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly photoError = signal<'failed' | 'rejected' | null>(null);

  private readonly urls = new ObjectUrlCache();

  protected readonly media = toSignal(
    toObservable(this.entryId).pipe(switchMap((id) => this.entries.watchPhotos(id))),
    { initialValue: [] as LocalMedia[] },
  );

  protected readonly photoCount = computed(() => this.media().length);

  constructor() {
    effect(() => {
      const id = this.entryId();
      void this.entries.getEntry(id).then((entry) => {
        this.entry.set(entry ?? null);
        this.loaded.set(true);
      });
    });

    // Mint thumbnails for what is on screen and hand back the rest.
    effect(() => {
      this.urls.retain(this.media().map((item) => item.id));
    });

    // While this screen is open the foreman is still working on the entry, so the abandonment
    // sweep must not adopt it. The URL exemption in the initializer covers a cold start; this
    // covers the app being backgrounded and resumed with the screen still up.
    const heartbeat = setInterval(() => void this.entries.touchDraft(this.entryId()), 30_000);

    inject(DestroyRef).onDestroy(() => {
      clearInterval(heartbeat);
      this.urls.releaseAll();
    });
  }

  protected thumbnail(item: LocalMedia): string {
    return this.urls.get(item.id, item.blob);
  }

  /**
   * A photo straight off the camera: metadata and position fix first, compression second, store
   * third. The `<input>` is reset afterwards so the same photo can be taken twice.
   */
  protected async onPhotoSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length === 0) {
      return;
    }

    this.busy.set(true);
    this.photoError.set(null);
    try {
      for (const file of files) {
        const photo = await this.photos.prepare(file);
        await this.entries.addPhoto(this.entryId(), photo);
      }
      this.entry.set((await this.entries.getEntry(this.entryId())) ?? null);
    } catch (error) {
      // An entry that has moved on cannot take new photos; say which of the two went wrong rather
      // than blaming the camera for a queueing decision.
      this.photoError.set(error instanceof EntryNotOpenError ? 'rejected' : 'failed');
    } finally {
      this.busy.set(false);
    }
  }

  /** `draft → queued`: the entry joins the outbox and shows up on the pending screen. */
  protected async done(): Promise<void> {
    await this.entries.queue(this.entryId());
    await this.leave();
  }

  protected async leave(): Promise<void> {
    await this.router.navigate(['/'], { replaceUrl: true });
  }
}
