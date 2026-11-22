import { useState } from 'react';
import type { ContentAssignmentSource } from '../../../packages/domain/workspace-records';
import { ConnectedOriginalInputs } from './ConnectedOriginalInputs';
import { useLibraryWorkRoutes } from './LibraryWorkNavigation';

export function ConnectedContentOrigin({ source }: { source: ContentAssignmentSource }) {
  const routes = useLibraryWorkRoutes();
  const [inputs, setInputs] = useState(false);
  return <div className="compact-actions" aria-label="Original Agent Work">
    <button className="compact-action" onClick={() => routes?.openWork(source.assignmentId, source.attemptId)}>Original Result</button>
    <button className="compact-action" onClick={() => setInputs(true)}>Inputs Used</button>
    {inputs && <ConnectedOriginalInputs attemptId={source.attemptId} assignmentId={source.assignmentId} expected={source} close={() => setInputs(false)}/>}
  </div>;
}
