import type { AssignmentAttempt } from '../../../packages/domain/assignments';

export const assignmentStatusLabels: Record<AssignmentAttempt['state'], string> = {
  prepared: 'Preparing', dispatching: 'Starting', running: 'Working', stopping: 'Stopping',
  returned: 'Ready for review', failed: 'Ended with an error', cancelled: 'Stopped', unknown: 'Needs reconciliation',
};
