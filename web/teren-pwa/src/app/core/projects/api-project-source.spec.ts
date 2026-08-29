import { TestBed } from '@angular/core/testing';

import { ProjectResponse } from '../api/api-types';
import { TerenApiClient } from '../api/teren-api.client';
import { ApiProjectSource } from './api-project-source';
import { DEMO_PROJECTS } from './project-source';

const CACHE_KEY = 'teren.projects';

const SERVER_PROJECTS: ProjectResponse[] = [
  {
    id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000002',
    name: 'Stambena zgrada Vojvode Stepe 212',
    address: 'Vojvode Stepe 212, Voždovac, Beograd',
    latitude: 44.77,
    longitude: 20.48,
    report_language: 'sr',
  },
  {
    id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000009',
    name: 'Nova hala Batajnica',
    address: null,
    latitude: null,
    longitude: null,
    report_language: 'sr',
  },
];

describe('ApiProjectSource', () => {
  let api: { configured: boolean; listProjects: ReturnType<typeof vi.fn> };
  let source: ApiProjectSource;

  beforeEach(() => {
    localStorage.removeItem(CACHE_KEY);
    api = { configured: true, listProjects: vi.fn().mockResolvedValue(SERVER_PROJECTS) };

    TestBed.configureTestingModule({
      providers: [{ provide: TerenApiClient, useValue: api as unknown as TerenApiClient }],
    });
    source = TestBed.inject(ApiProjectSource);
  });

  afterEach(() => {
    localStorage.removeItem(CACHE_KEY);
  });

  it('returns what the server says, with a missing address as an empty one', async () => {
    const projects = await source.listProjects();

    expect(projects).toEqual([
      {
        id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000002',
        name: 'Stambena zgrada Vojvode Stepe 212',
        address: 'Vojvode Stepe 212, Voždovac, Beograd',
      },
      { id: 'd3a0c1f0-5b8e-4f1a-9c62-000000000009', name: 'Nova hala Batajnica', address: '' },
    ]);
  });

  it('serves the last known list when the server cannot be reached', async () => {
    // The tier that matters: the picker is on the capture path, and a capture screen that cannot
    // name a site cannot record.
    await source.listProjects();
    api.listProjects.mockRejectedValue(new Error('offline'));

    const projects = await source.listProjects();

    expect(projects.map((project) => project.id)).toEqual(SERVER_PROJECTS.map((p) => p.id));
  });

  it('falls back to the seeded demo ids on a device that has never reached the server', async () => {
    api.listProjects.mockRejectedValue(new Error('offline'));

    const projects = await source.listProjects();

    // These ids are a contract with the backend seeder (ARCHITECTURE §6): an entry captured
    // against a wrong one 404s for ever on POST /api/entries.
    expect(projects).toEqual(DEMO_PROJECTS.map((project) => ({ ...project })));
  });

  it('falls back without calling the API at all when the build has no token', async () => {
    api.configured = false;

    const projects = await source.listProjects();

    expect(api.listProjects).not.toHaveBeenCalled();
    expect(projects).toHaveLength(DEMO_PROJECTS.length);
  });

  it('does not overwrite a usable cache with an empty answer', async () => {
    await source.listProjects();
    api.listProjects.mockResolvedValue([]);

    const projects = await source.listProjects();

    expect(projects.map((project) => project.id)).toEqual(SERVER_PROJECTS.map((p) => p.id));
  });

  it('ignores a cache entry that is not shaped like a project list', async () => {
    // This string can outlive the build that wrote it. A half-shaped project reaching
    // `LocalEntry.projectId` would file a recording against a site the server has never heard of.
    localStorage.setItem(CACHE_KEY, JSON.stringify([{ id: 42 }, { name: 'no id' }, 'nonsense']));
    api.listProjects.mockRejectedValue(new Error('offline'));

    const projects = await source.listProjects();

    expect(projects).toEqual(DEMO_PROJECTS.map((project) => ({ ...project })));
  });

  it('survives unparseable cached JSON', async () => {
    localStorage.setItem(CACHE_KEY, '{not json');
    api.listProjects.mockRejectedValue(new Error('offline'));

    await expect(source.listProjects()).resolves.toHaveLength(DEMO_PROJECTS.length);
  });
});
