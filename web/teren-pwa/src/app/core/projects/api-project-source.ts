import { Injectable, inject } from '@angular/core';

import { TerenApiClient } from '../api/teren-api.client';
import { Project } from '../db/models';
import { DEMO_PROJECTS, ProjectSource } from './project-source';

/**
 * Where the cached site list lives.
 *
 * Exported because `ActivationService` has to clear it when this phone changes company: a list
 * cached under another company is a set of project ids the new credential cannot use, and an
 * entry captured against one 404s for ever (`plans/profile-and-identity.md` §10.4). One
 * definition, so the clearing and the writing can never drift apart.
 */
export const PROJECT_CACHE_KEY = 'teren.projects';

/**
 * The site list, from the server when there is one and from disk when there is not.
 *
 * Three tiers, in this order, and the order is the product decision:
 *
 * 1. **The API.** Whatever `GET /api/projects` returns is the truth, and it is cached on the way
 *    through.
 * 2. **The cache.** A foreman opening the app in a basement gets the list he saw yesterday. This
 *    is the tier that matters: the project picker is on the capture path, and a capture screen
 *    that cannot name a site cannot record.
 * 3. **The built-in demo list.** Only on a device that has never once reached the server. Its ids
 *    are the ones the seeder really creates (ARCHITECTURE §6 records that contract from the
 *    server side, `project-source.ts` from this side) — so an entry captured against the fallback
 *    is uploadable, not a 404 waiting to happen. **Do not "tidy" those ids.**
 *
 * There is deliberately no "the list is stale" state in the UI. Sites change every few weeks and
 * an entry carries the id it was captured with; a warning banner about list freshness would be
 * noise on the one screen that has to stay silent.
 *
 * The cache lives in `localStorage` rather than Dexie on purpose. It is a few hundred bytes of
 * disposable convenience, not evidence, and reading it synchronously means the picker is
 * populated on the first render instead of one frame later — Dexie would buy transactions and
 * blob storage that this data has no use for, at the cost of another table and another version.
 */
@Injectable({ providedIn: 'root' })
export class ApiProjectSource implements ProjectSource {
  private readonly api = inject(TerenApiClient);

  async listProjects(): Promise<Project[]> {
    if (this.api.configured) {
      try {
        const projects = (await this.api.listProjects()).map(toProject);
        // An empty list is a legitimate answer (a company with no sites yet), but caching it
        // over a good list would replace something usable with nothing. Keep what we had.
        if (projects.length > 0) {
          writeCache(projects);
          return projects;
        }
      } catch {
        // Offline, or the server is down. Neither is worth a message here — the site list is not
        // where the app reports connectivity, the pending screen is.
      }
    }

    return readCache() ?? DEMO_PROJECTS.map((project) => ({ ...project }));
  }
}

function toProject(response: { id: string; name: string; address: string | null }): Project {
  return { id: response.id, name: response.name, address: response.address ?? '' };
}

function writeCache(projects: readonly Project[]): void {
  try {
    localStorage.setItem(PROJECT_CACHE_KEY, JSON.stringify(projects));
  } catch {
    // Private mode or an exhausted quota. The list simply will not survive going offline.
  }
}

/**
 * The cached list, or null if there is nothing usable.
 *
 * Every field is checked rather than trusted: this string can be older than the current build, and
 * a half-shaped project reaching `LocalEntry.projectId` would file a recording against a site id
 * the server has never heard of — which is the one failure this whole layer exists to avoid.
 */
function readCache(): Project[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PROJECT_CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const projects = parsed.filter(isProject).map((project) => ({
      id: project.id,
      name: project.name,
      address: project.address,
    }));
    return projects.length > 0 ? projects : null;
  } catch {
    return null;
  }
}

function isProject(value: unknown): value is Project {
  const candidate = value as Project | null;
  return (
    !!candidate &&
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.name === 'string' &&
    typeof candidate.address === 'string'
  );
}
