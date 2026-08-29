import { Injectable, computed, inject, signal } from '@angular/core';

import { Project } from '../db/models';
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

function readSelectedId(): string | null {
  try {
    return localStorage.getItem(SELECTED_PROJECT_KEY);
  } catch {
    return null;
  }
}
