import { TestBed } from '@angular/core/testing';

import { DEMO_PROJECTS } from './project-source';
import { ProjectService } from './project.service';

const SELECTED_PROJECT_KEY = 'teren.selectedProjectId';

/** The third demo site's id before it was corrected to the one the server seeds. */
const PHANTOM_THIRD = '6f7a1c1e-3a4b-4f2e-9c1d-000000000003';

describe('ProjectService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  async function service(): Promise<ProjectService> {
    TestBed.configureTestingModule({});
    const projects = TestBed.inject(ProjectService);
    await projects.load();
    return projects;
  }

  it('keeps the site the foreman chose when its id was corrected', async () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, PHANTOM_THIRD);

    const projects = await service();

    // Not the first site: falling back would put his next recording on a site he never chose.
    expect(projects.selected()?.id).toBe(DEMO_PROJECTS[2].id);
    expect(projects.selected()?.name).toBe('Kuća Miloša Obrenovića 17');
    // And the stored value is corrected, so the translation happens once per device.
    expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe(DEMO_PROJECTS[2].id);
  });

  it('leaves a stored seeded id untouched', async () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, DEMO_PROJECTS[1].id);

    const projects = await service();

    expect(projects.selected()?.id).toBe(DEMO_PROJECTS[1].id);
    expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe(DEMO_PROJECTS[1].id);
  });

  it('shows the first site when nothing has been chosen yet', async () => {
    const projects = await service();

    expect(projects.selected()?.id).toBe(DEMO_PROJECTS[0].id);
  });

  it('shows the first site rather than nothing when the stored id is unknown', async () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, 'not-a-site-this-build-knows');

    const projects = await service();

    // The screen always has a site to record against; an unrecognised id is not a dead end.
    expect(projects.selected()?.id).toBe(DEMO_PROJECTS[0].id);
  });
});
