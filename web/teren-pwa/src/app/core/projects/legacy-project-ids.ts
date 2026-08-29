import { Project } from '../db/models';
import { DEMO_PROJECTS } from './project-source';

/**
 * The demo project ids this PWA used before they were checked against the seeder.
 *
 * They were invented here and never existed on the server, so anything captured under one of them
 * would be rejected by `POST /api/entries` with a `404 Project not found` — permanently, since a
 * missing project is not a condition a retry fixes. Two places therefore have to translate them:
 * the Dexie v3 upgrade (`teren-db.ts`), for entries and capture sessions already on disk, and
 * `ProjectService`, for the site id persisted in `localStorage`.
 *
 * The mapping is by **site identity** — each old id is paired with the real id of the same
 * address, not with whatever now sits at the same position in the list. Old and new ids share no
 * value (different prefixes), so applying the map twice is a no-op and re-running any of this is
 * safe.
 *
 * This table is finished. It describes a fixed set of ids that existed on founder and demo
 * devices during B2; nothing new is ever added to it, and it can be deleted once no device can
 * still be carrying B2 data.
 */
const PHANTOM_TO_CANONICAL: Readonly<Record<string, string>> = {
  // Stambena zgrada Vojvode Stepe 212
  '6f7a1c1e-3a4b-4f2e-9c1d-000000000001': 'd3a0c1f0-5b8e-4f1a-9c62-000000000002',
  // Poslovni prostor Bulevar oslobođenja 84
  '6f7a1c1e-3a4b-4f2e-9c1d-000000000002': 'd3a0c1f0-5b8e-4f1a-9c62-000000000003',
  // Kuća Miloša Obrenovića 17
  '6f7a1c1e-3a4b-4f2e-9c1d-000000000003': 'd3a0c1f0-5b8e-4f1a-9c62-000000000004',
};

/**
 * The id this site is really known by on the server. Anything that is not a known phantom id —
 * an already-correct id, or a project id from a future API-backed source — is returned untouched.
 */
export function canonicalProjectId(projectId: string): string {
  return PHANTOM_TO_CANONICAL[projectId] ?? projectId;
}

/**
 * The full site record behind a possibly-phantom id, where the site is one this build knows.
 *
 * Used to keep `LocalEntry.projectName` — which is denormalised onto every entry — in step with
 * the id it is remapped to, rather than leaving a name that no longer belongs to its project.
 */
export function canonicalProject(projectId: string): Project | undefined {
  const id = canonicalProjectId(projectId);
  return DEMO_PROJECTS.find((project) => project.id === id);
}
