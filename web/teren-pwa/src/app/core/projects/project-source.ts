import { InjectionToken } from '@angular/core';

import { Project } from '../db/models';

/**
 * Where the list of sites comes from.
 *
 * B2 is offline-only, so the implementation behind this token is a hardcoded demo list. B3 swaps
 * in an API-backed source (`GET /api/projects`, cached locally) by overriding the token — no
 * component or store changes with it.
 */
export interface ProjectSource {
  listProjects(): Promise<Project[]>;
}

/**
 * The demo sites, carrying the ids the server actually seeds.
 *
 * **These ids are a contract with the backend seeder** (`src/Teren.Infrastructure/Seeding/
 * DemoSeeder.cs`; ARCHITECTURE.md §6 records the same contract from the server side). An entry is
 * uploaded under the project id the phone recorded it with, and `POST /api/entries` answers an id
 * it does not know with `404 Project not found` — which is not a retryable error. Drift between
 * this list and the seeder therefore does not slow the upload path down, it closes it: the outbox
 * retries forever and the evidence never leaves the phone.
 *
 * So: change an id here only together with the seeder, and add a `teren-db.ts` version that
 * remaps whatever is already on disk under the old one (v3 is exactly that, for the ids this
 * file carried before they were checked against a live `GET /api/projects`).
 */
export const DEMO_PROJECTS: readonly Project[] = [
  {
    id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000002',
    name: 'Stambena zgrada Vojvode Stepe 212',
    address: 'Vojvode Stepe 212, Voždovac, Beograd',
  },
  {
    id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000003',
    name: 'Poslovni prostor Bulevar oslobođenja 84',
    address: 'Bulevar oslobođenja 84, Novi Sad',
  },
  {
    id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000004',
    name: 'Kuća Miloša Obrenovića 17',
    address: 'Miloša Obrenovića 17, Zemun, Beograd',
  },
];

export class DemoProjectSource implements ProjectSource {
  async listProjects(): Promise<Project[]> {
    return DEMO_PROJECTS.map((project) => ({ ...project }));
  }
}

export const PROJECT_SOURCE = new InjectionToken<ProjectSource>('PROJECT_SOURCE', {
  providedIn: 'root',
  factory: () => new DemoProjectSource(),
});
