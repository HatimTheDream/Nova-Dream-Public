import type { Snapshot } from '../../../packages/domain/contracts';
import { projectIsDeleted } from '../../../packages/domain/project-organization';
import { statusNames } from '../../../packages/domain/tasks';
import { taskDestinations, type TaskSort } from '../../../packages/domain/task-presentation';
import { ComposerMenu } from './ComposerMenu';
import { ChevronDown } from './icons';

export type TaskFilterProps = { snapshot: Snapshot; view: string; chooseView(value: string): void; project: string; status: string; priority: string; sort: TaskSort; trash: boolean; selecting: boolean; setProject(value: string): void; setStatus(value: string): void; setPriority(value: string): void; setSort(value: TaskSort): void; setTrash(value: boolean): void; setSelecting(value: boolean): void };

export function TaskFilterFields({ props, close }: { props: TaskFilterProps; close(): void }) {
  const projects = props.snapshot.projects.filter(project => !projectIsDeleted(props.snapshot, project.id));
  return <div className="task-filter-fields">
    <label>Task View<select value={props.trash ? 'Trash' : props.view} onChange={event => props.chooseView(event.target.value)}>{[...taskDestinations, 'Daily History', 'Trash'].map(view => <option key={view} value={view}>{view === 'Scheduled' ? 'Upcoming' : view}</option>)}</select></label>
    <label>Project<select value={props.project} onChange={event => props.setProject(event.target.value)}><option value="all">All Projects</option><option value="">Personal</option>{props.project !== 'all' && props.project !== '' && !projects.some(project => project.id === props.project) && <option value={props.project}>Unavailable Project</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.value.name}</option>)}</select></label>
    <label>Status<select value={props.status} onChange={event => props.setStatus(event.target.value)}><option value="all">Any Status</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Priority<select value={props.priority} onChange={event => props.setPriority(event.target.value)}><option value="all">Any Priority</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></label>
    <label>Order<select value={props.sort} onChange={event => props.setSort(event.target.value as TaskSort)}><option value="planned">Automatic</option><option value="deadline">Due Date</option><option value="title">Title (A–Z)</option><option value="priority">Priority</option><option value="newest">Recently Updated</option></select></label>
    <label className="task-filter-selecting"><input type="checkbox" checked={props.selecting} onChange={event => props.setSelecting(event.target.checked)}/>Select Tasks</label>
    <div className="task-filter-footer"><button type="button" className="compact-action" onClick={() => { props.setProject('all'); props.setStatus('all'); props.setPriority('all'); props.setSort('planned'); props.chooseView('Today'); }}>Reset</button><button type="button" className="compact-action" onClick={close}>Done</button></div>
  </div>;
}

export function TaskFilters(props: TaskFilterProps) {
  const changed = Number(props.project !== 'all') + Number(props.status !== 'all') + Number(props.priority !== 'all') + Number(props.sort !== 'planned') + Number(props.trash || props.view !== 'Today');
  return <ComposerMenu label="Task Filters" icon={<ChevronDown size={14}/>} text={<>Filters{changed > 0 && <span className="task-filter-count">{changed}</span>}</>} className={`task-filter-trigger${changed ? ' has-filters' : ''}`} align="right" placement="below" kind="dialog">{close => <TaskFilterFields props={props} close={close}/>}</ComposerMenu>;
}
