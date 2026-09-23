import type { Snapshot } from './contracts.js';

export const projectIsDeleted = (snapshot: Snapshot, id: string | null | undefined) =>
  !!id && snapshot.projectOrganization?.some(item => item.projectId === id && item.deleted) === true;

// Keep the full snapshot for saved context; only new destinations are filtered.
export const activeProjects = (snapshot: Snapshot) => snapshot.projects.filter(item => !projectIsDeleted(snapshot, item.id));
