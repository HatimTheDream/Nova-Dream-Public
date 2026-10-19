import type { Task } from '../../../packages/domain/contracts';
import { statusNames, type Occurrence } from '../../../packages/domain/tasks';

/** Keep the saved occurrence's date and status visible when opening its exact task. */
export function TaskOccurrenceDetails({ occurrence, status }: { occurrence: Occurrence; status: Task['status'] }) {
  return <small className="task-occurrence-details"><span>{statusNames[status]}</span><span>Scheduled <time dateTime={occurrence.date}>{occurrence.date}</time></span><span>{occurrence.timezone.replaceAll('_', ' ')}</span></small>;
}
