import type { Assignment } from '../../../packages/domain/workspace-records';
import type { Entity, Snapshot } from '../../../packages/domain/contracts';
import { AssignmentRuns } from './AssignmentRuns';
import { useLibraryWorkRoutes } from './LibraryWorkNavigation';
import './connected-work.css';

type Props = {
  entity: Entity<Assignment>;
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  openContent: (id: string) => void;
  targetAttempt?: { id: string; epoch: string };
  clearTarget: () => void;
  back: () => void;
};

export function ConnectedAssignment({ entity, snapshot, back, ...actions }: Props) {
  const routes = useLibraryWorkRoutes();
  const plan = entity.value;
  const project = snapshot.projects.find(item => item.id === plan.projectId);
  const lead = snapshot.records?.agent.find(item => item.id === plan.agentId);
  return <section className="connected-work">
    <header>
      <div className="compact-actions"><button className="compact-action quiet" onClick={back}>Back To Work</button>
        {routes && plan.workOrigin && <button className="compact-action quiet" onClick={() => routes.openLibrary(plan.workOrigin!)}>Return To Library</button>}
      </div>
      <h1>{plan.title}</h1>
      <p className="metadata">{[project?.value.name, lead?.value.name].filter(Boolean).join(' · ')}</p>
    </header>
    <details className="connected-brief"><summary>Assignment Brief</summary><p>{plan.brief}</p><p>{plan.expectedOutput}</p></details>
    <AssignmentRuns entity={entity} snapshot={snapshot} dirty={false} {...actions}/>
  </section>;
}
