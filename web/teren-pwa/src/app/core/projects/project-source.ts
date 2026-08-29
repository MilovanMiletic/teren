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

/** The real seeded demo site (`src/Teren.Infrastructure/Seeding/DemoSeeder.cs`) first. */
export const DEMO_PROJECTS: readonly Project[] = [
  {
    id: '6f7a1c1e-3a4b-4f2e-9c1d-000000000001',
    name: 'Stambena zgrada Vojvode Stepe 212',
    address: 'Vojvode Stepe 212, Voždovac, Beograd',
  },
  {
    id: '6f7a1c1e-3a4b-4f2e-9c1d-000000000002',
    name: 'Poslovni prostor Bulevar oslobođenja 84',
    address: 'Bulevar oslobođenja 84, Novi Sad',
  },
  {
    id: '6f7a1c1e-3a4b-4f2e-9c1d-000000000003',
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
