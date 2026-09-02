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
import { ActionLogService } from '../../core/telemetry/action-log.service';
import { ACTIONS } from '../../core/telemetry/actions';
import { AppHeader } from '../../ui/app-header';
import { DurationPipe } from '../../ui/duration.pipe';
import { ArrivalHandoff } from '../../ui/arrival';
import { Icon } from '../../ui/icon';
import { ObjectUrlCache } from '../../ui/object-url-cache';
import { PluralService } from '../../ui/plural.service';

/**
 * Saved locally (`design/CaptureSaved.dc.html`).
 *
 * By the time this screen renders, the recording is already on disk — that is the whole point of
 * the copy on it. Photos are added here, one at a time, each compressed and stored before the
 * thumbnail appears. "Gotovo" is the explicit hand-over to the sync queue (`draft → queued`); B3's
 * loop empties it from there, and needed no change here — which was the point of drawing the line
 * at the queue rather than at the network.
 *
 * The upload-progress card from the artboard is still deliberately absent. Progress belongs to
 * the pending screen, which watches the outbox and can say something true about it; a bar on this
 * screen would have to guess, and guessing about sync state is the one thing this product must
 * never do.
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
  /**
   * The action log (D5). Only the photo path calls it: "Gotovo" declares itself on the control
   * (`data-log="capture.send"`), and a file input cannot, because the interesting facts are how
   * many pictures came back and whether the entry would still take them.
   */
  private readonly actions = inject(ActionLogService);
  protected readonly plural = inject(PluralService);
  /**
   * The one-shot that carries this entry id across the navigation to Home (`ui/arrival.ts`).
   *
   * Home is rebuilt by the router, so its own diff cannot tell the entry he has just recorded from
   * the four that were already there — the first list it sees contains all five. Naming it here is
   * what makes the row rise into place on the screen he lands on.
   */
  private readonly arrivals = inject(ArrivalHandoff);

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
      // A count, never a file name: `count` is a number and the contract's `detail` takes numbers.
      this.actions.record(ACTIONS.capturePhotoAdd, {
        outcome: 'ok',
        entryId: this.entryId(),
        detail: { count: files.length },
      });
    } catch (error) {
      // An entry that has moved on cannot take new photos; say which of the two went wrong rather
      // than blaming the camera for a queueing decision.
      const rejected = error instanceof EntryNotOpenError;
      this.photoError.set(rejected ? 'rejected' : 'failed');
      // `blocked` and `fail` are different facts: the first is the entry refusing, the second is
      // the camera or the store. One slug, two outcomes, and no sentence between them.
      this.actions.record(ACTIONS.capturePhotoAdd, {
        outcome: rejected ? 'blocked' : 'fail',
        entryId: this.entryId(),
        detail: { count: files.length },
      });
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
    // Before the navigation, not after: Home is created during it, and it reads this in its own
    // constructor. Announced on every way out of this screen — "Gotovo" and the plain leave — so
    // an entry that was already queued still rises when he lands back on Home.
    this.arrivals.announce(this.entryId());
    await this.router.navigate(['/'], { replaceUrl: true });
  }
}
