import type { Snapshot } from '../../../packages/domain/contracts';
import { projectIsDeleted } from '../../../packages/domain/project-organization';

export function ProjectOptions({ snapshot, selected, space }: { snapshot: Snapshot; selected?: string | null; space?: 'chat' | 'work' }) {
  return <>{snapshot.projects.filter(project => (!space || (project.value.space ?? 'chat') === space) && (!projectIsDeleted(snapshot, project.id) || project.id === selected)).map(project => <option key={project.id} value={project.id} disabled={projectIsDeleted(snapshot, project.id)}>{project.value.name}{projectIsDeleted(snapshot, project.id) ? ' · Deleted' : ''}</option>)}</>;
}
