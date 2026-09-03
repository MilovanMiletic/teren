import { Injectable, inject } from '@angular/core';

import { ArchiveService } from '../archive/archive.service';
import { EntryStore } from '../db/entry-store';
import { Project } from '../db/models';
import { ProjectService } from '../projects/project.service';

/**
 * The day a correction is about, resolved to everything the capture path needs to record one.
 *
 * There is no `projectId` field on purpose: the whole point is that the caller receives a
 * {@link Project}, from the target, and therefore never has to choose one.
 */
export interface CorrectionTarget {
  /** The entry being corrected — what goes on the wire as `supersedes_entry_id`. */
  entryId: string;
  /** **The target's own site**, inherited. Never the site the foreman happens to have selected. */
  project: Project;
  /** The site day of the record being replaced, `YYYY-MM-DD`, for the sentence on screen. */
  day: string | null;
}

/**
 * Resolving a correction target — the one place in the app that decides which site a correction
 * belongs to.
 *
 * ## Why this exists at all, rather than reading `ProjectService.selected()`
 *
 * `POST /api/entries` accepts `supersedes_entry_id` only when it names an entry **of the same
 * project**; anything else is a `404` (ARCHITECTURE §7). And a 4xx is **terminal** in this
 * client's failure taxonomy: the outbox does not retry it, it stops. So a correction filed against
 * the wrong site would not bounce and heal on the next attempt — it would sit in the outbox
 * `blocked`, and a day of a foreman's work would never leave his phone. That is the worst outcome
 * this product has, and it is one stale site selection away.
 *
 * The site is therefore **derived from the target and from nothing else**, and no screen offers a
 * choice. A foreman standing on site B who corrects a day recorded on site A records it against
 * A, because that is the only value the server will accept and because a correction of A's day is
 * a fact about A.
 *
 * ## Local first, and the network only when it has to
 *
 * Dexie holds every day this phone captured, so the ordinary case — he notices a mistake in his
 * own record — resolves with no network at all, which matters because this runs before the
 * microphone is opened. The server is asked only for a day this device did not record: another
 * foreman's, or one from before this phone was activated. Those exist in the archive because the
 * list is a merge (`core/archive/archive-rows.ts`).
 *
 * ## Refusing is a real answer
 *
 * `null` means *this build cannot say which site that day belongs to* — the phone does not hold
 * it and the server could not be asked. The screen then says so and records nothing. **It must
 * never fall back to the selected site**: that is precisely the substitution that turns a
 * correction into an abandoned day, and it would be invisible until an entry stopped uploading.
 */
@Injectable({ providedIn: 'root' })
export class CorrectionService {
  private readonly entries = inject(EntryStore);
  private readonly archive = inject(ArchiveService);
  private readonly projects = inject(ProjectService);

  /**
   * What is known about the day `entryId` names, or null when the site cannot be established.
   *
   * Never throws: a rejected read here would tear down the recording screen's own start-up, and
   * "I could not find out" is a state that screen has to render anyway.
   */
  async resolve(entryId: string): Promise<CorrectionTarget | null> {
    if (entryId.trim() === '') {
      return null;
    }

    const local = await this.entries.getEntry(entryId).catch(() => undefined);
    if (local) {
      return {
        entryId,
        // The full project record when the list holds it — it carries the address the recording
        // screen prints. The row's own denormalised name is the fallback rather than a failure:
        // it was copied onto the entry at capture time for exactly this, and an entry always
        // renders even when the project list has changed underneath it (`core/db/models.ts`).
        project: this.knownProject(local.projectId) ?? {
          id: local.projectId,
          name: local.projectName,
          address: '',
        },
        day: local.localDay,
      };
    }

    // Not on this phone. The archive lists days recorded on other devices, so the target is real
    // and the server is the only one who can say where it belongs.
    const remote = await this.archive.getEntry(entryId);
    const project = this.knownProject(remote.entry?.project_id ?? null);
    if (!project) {
      // Three cases, one answer, and the answer is right for all three: the server could not be
      // asked, the server has never heard of that entry, or it named a site this device cannot
      // see. Guessing in any of them writes a day that can never be sent.
      return null;
    }

    return { entryId, project, day: remote.entry?.entry_date ?? null };
  }

  /** The project list's own record for an id, or null — never a synthesised one. */
  private knownProject(projectId: string | null): Project | null {
    if (!projectId) {
      return null;
    }
    return this.projects.projects().find((project) => project.id === projectId) ?? null;
  }
}
