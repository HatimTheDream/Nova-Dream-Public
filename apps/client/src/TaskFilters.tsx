import { useLayoutEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { statusNames } from '../../../packages/domain/tasks';
import type { TaskSort } from '../../../packages/domain/task-presentation';
import { ComposerMenu } from './ComposerMenu';
import { ArrowLeft, Check, ChevronDown, X } from './icons';

type Choice = { value: string; label: string };
type Filter = { id: string; label: string; value: string; choices: Choice[]; choose(value: string): void };
const priorities: Choice[] = [{ value: 'all', label: 'Any priority' }, { value: 'high', label: 'High' }, { value: 'normal', label: 'Normal' }, { value: 'low', label: 'Low' }];
const sorts: Choice[] = [{ value: 'planned', label: 'Automatic' }, { value: 'deadline', label: 'Due date' }, { value: 'title', label: 'Title (A–Z)' }, { value: 'priority', label: 'Priority' }, { value: 'newest', label: 'Recently updated' }];
type Props = { snapshot: Snapshot; project: string; status: string; priority: string; sort: TaskSort; trash: boolean; selecting: boolean; setProject(value: string): void; setStatus(value: string): void; setPriority(value: string): void; setSort(value: TaskSort): void; setTrash(value: boolean): void; setSelecting(value: boolean): void };

function OptionsPicker({ props, filters, close }: { props: Props; filters: Filter[]; close(): void }) {
  const [page, setPage] = useState('home'), root = useRef<HTMLDivElement>(null);
  const current = filters.find(filter => filter.id === page), ordering = page === 'order' || page === 'all-orders';
  useLayoutEffect(() => { (root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? root.current?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true }); }, [page]);
  const next = (label: string, destination: string, value?: string, active = false) => <button type="button" role="menuitem" aria-label={value ? `${label}: ${value}` : label} onClick={() => setPage(destination)}><span>{label}</span>{value && <span className={`task-filter-value${active ? ' is-active' : ''}`}>{value}</span>}<ChevronDown className="task-picker-next" size={14}/></button>;
  const back = page === 'all-orders' ? 'order' : current ? 'more' : 'home';
  return <div className="task-filter-picker" ref={root}>
    {page !== 'home' && <div className="task-picker-heading"><button type="button" role="menuitem" aria-label={back === 'more' ? 'Back to more options' : back === 'order' ? 'Back to order' : 'Back to filter and sort'} onClick={() => setPage(back)}><ArrowLeft size={16}/></button><strong>{current?.label ?? (ordering ? 'Order' : 'More options')}</strong></div>}
    {page === 'home' ? <>
      <button type="button" role="menuitemcheckbox" aria-checked={props.priority === 'high'} onClick={() => { props.setPriority(props.priority === 'high' ? 'all' : 'high'); close(); }}><span>High priority only</span>{props.priority === 'high' && <Check size={16}/>}</button>
      {next('Order', 'order', sorts.find(choice => choice.value === props.sort)?.label, props.sort !== 'planned')}
      {next('More options', 'more')}
    </> : ordering ? <>
      {(page === 'all-orders' ? sorts : sorts.slice(0, 3)).map(choice => <button type="button" key={choice.value} role="menuitemradio" aria-checked={props.sort === choice.value} onClick={() => { props.setSort(choice.value as TaskSort); close(); }}><span>{choice.label}</span>{props.sort === choice.value && <Check size={16}/>}</button>)}
      {page === 'order' && next('More sort choices', 'all-orders', ['priority', 'newest'].includes(props.sort) ? sorts.find(choice => choice.value === props.sort)?.label : undefined)}
    </> : current ? current.choices.map(choice => <button type="button" role="menuitemradio" aria-checked={choice.value === current.value} key={choice.value} onClick={() => { current.choose(choice.value); close(); }}><span>{choice.label}</span>{choice.value === current.value && <Check size={16}/>}</button>) : <>
      {filters.map(filter => <span key={filter.id} className="task-picker-row">{next(filter.label, filter.id, filter.value === 'all' ? 'Any' : filter.choices.find(choice => choice.value === filter.value)?.label ?? 'Unavailable', filter.value !== 'all')}</span>)}
      <div className="task-picker-divider"/>
      <button type="button" role="menuitemcheckbox" aria-checked={props.selecting} onClick={() => { props.setSelecting(!props.selecting); close(); }}><span>{props.selecting ? 'Done selecting' : 'Select tasks'}</span>{props.selecting && <Check size={16}/>}</button>
      <button type="button" role="menuitemcheckbox" aria-checked={props.trash} onClick={() => { props.setTrash(!props.trash); close(); }}><span>Trash</span>{props.trash && <Check size={16}/>}</button>
    </>}
  </div>;
}

export function TaskFilters(props: Props) {
  const filters: Filter[] = [
    { id: 'project', label: 'Project', value: props.project, choose: props.setProject, choices: [{ value: 'all', label: 'All Projects' }, { value: '', label: 'Personal' }, ...props.snapshot.projects.map(project => ({ value: project.id, label: project.value.name }))] },
    { id: 'status', label: 'Status', value: props.status, choose: props.setStatus, choices: [{ value: 'all', label: 'Any status' }, ...Object.entries(statusNames).map(([value, label]) => ({ value, label }))] },
    { id: 'priority', label: 'Priority', value: props.priority, choose: props.setPriority, choices: priorities },
  ];
  const active = filters.filter(filter => filter.value !== 'all'), changed = active.length + Number(props.sort !== 'planned') + Number(props.trash);
  return <>
    <div className="task-filter-controls">
      <ComposerMenu label="Filter & sort" icon={<ChevronDown size={14}/>} text={<>Filter & sort{changed > 0 && <span className="task-filter-count">{changed}</span>}</>} className={`task-filter-trigger${changed ? ' has-filters' : ''}`} align="right" placement="below" kind="menu">{close => <OptionsPicker props={props} filters={filters} close={close}/>}</ComposerMenu>
    </div>
    {(active.length > 0 || props.trash || props.sort !== 'planned' || props.selecting) && <div className="task-active-filters" aria-label="Current list choices">
      {active.map(filter => { const label = `${filter.label}: ${filter.choices.find(choice => choice.value === filter.value)?.label ?? 'Unavailable'}`; return <button type="button" key={filter.id} aria-label={`Remove ${label} filter`} title={`Remove ${label}`} onClick={() => filter.choose('all')}><span>{label}</span><X size={13}/></button>; })}
      {props.sort !== 'planned' && <button type="button" aria-label="Reset order to automatic" onClick={() => props.setSort('planned')}><span>Order: {sorts.find(choice => choice.value === props.sort)?.label}</span><X size={13}/></button>}
      {props.trash && <button type="button" aria-label="Close Trash" onClick={() => props.setTrash(false)}><span>Trash</span><X size={13}/></button>}
      {props.selecting && <button type="button" onClick={() => props.setSelecting(false)}><span>Done selecting</span><Check size={13}/></button>}
      {active.length > 1 && <button type="button" className="task-filter-clear" onClick={() => filters.forEach(filter => filter.choose('all'))}>Clear filters</button>}
    </div>}
  </>;
}
