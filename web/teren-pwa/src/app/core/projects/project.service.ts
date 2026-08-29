import { Injectable, computed, inject, signal } from '@angular/core';

import { Project } from '../db/models';
import { canonicalProjectId } from './legacy-project-ids';
import { PROJECT_SOURCE } from './project-source';

const SELECTED_PROJECT_KEY = 'teren.selectedProjectId';

/**
 * The site the foreman is standing on.
 *
 * The choice is persisted, because a foreman works the same site for weeks and should never have
 * to pick it again to record. It is read synchronously at construction so the first render of the
 * home screen already shows the right site instead of flickering through a placeholder.
 */
@Injectable({ providedIn: 'root' })
export class ProjectService {
  private readonly source = inject(PROJECT_SOURCE);

  private readonly projectList = signal<Project[]>([]);
  private readonly selectedId = signal<string | null>(readSelectedId());

  readonly projects = this.projectList.asReadonly();

  readonly selected = computed<Project | null>(() => {
    const projects = this.projectList();
    if (projects.length === 0) {
      return null;
    }
    const id = this.selectedId();
    return projects.find((project) => project.id === id) ?? projects[0];
  });

  async load(): Promise<void> {
    this.projectList.set(await this.source.listProjects());
  }

  select(projectId: string): void {
    this.selectedId.set(projectId);
    try {
      localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
    } catch {
      // Private mode: the choice simply will not survive a reload.
    }
  }
}

/**
 * The persisted choice, translated through the pre-B3 project ids.
 *
 * A phantom id left in place would not announce itself: `selected` falls back to the first site
 * whenever the stored id matches nothing, so a foreman who picked the third site would come back
 * to the app showing the first one — and his next recording would be filed against a site he
 * never chose. Silently reattributing evidence to the wrong site is the one outcome worth writing
 * code to avoid, and the old ids map one-to-one onto the real ones, so the choice is recovered
 * exactly rather than guessed.
 *
 * The corrected id is written back, so this translation happens once per device.
 */
function readSelectedId(): string | null {
  let stored: string | null;
  try {
    stored = localStorage.getItem(SELECTED_PROJECT_KEY);
  } catch {
    return null;
  }
  if (!stored) {
    return null;
  }

  const canonical = canonicalProjectId(stored);
  if (canonical !== stored) {
    try {
      localStorage.setItem(SELECTED_PROJECT_KEY, canonical);
    } catch {
      // Private mode: the correction is applied in memory for this session either way.
    }
  }
  return canonical;
}
