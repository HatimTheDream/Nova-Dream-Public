import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { taskDescendants } from '../../../packages/domain/task-family';
import { statusNames } from '../../../packages/domain/tasks';

export function TaskFamily({ task, value, snapshot, change, openTask, newTask }: { task: Entity<Task>; value: Task; snapshot: Snapshot; change(patch: Partial<Task>): void; openTask?(task: Entity<Task>): void; newTask?(defaults: Partial<Task>): void }) {
  const tasks = [...snapshot.tasks, ...(snapshot.trashedTasks ?? [])];
  const excluded = taskDescendants(tasks, task.id); excluded.add(task.id);
  const parent = tasks.find(item => item.id === value.parentTaskId);
  const children = tasks.filter(item => item.value.parentTaskId === task.id);
  return <details className="task-more" open={!!value.parentTaskId || !!children.length}>
    <summary>Parent & child tasks{children.length > 0 ? ` · ${children.length}` : ''}</summary>
    <div className="task-detail-fields">
      <label>Parent task<select value={value.parentTaskId ?? ''} onChange={event => change({ parentTaskId: event.target.value || null })}>
        <option value="">No parent</option>
        {tasks.filter(item => !excluded.has(item.id) && (!item.value.trashed || item.id === value.parentTaskId)).map(item => <option key={item.id} value={item.id}>{item.value.title}{item.value.trashed ? ' · In Trash' : ''}</option>)}
      </select></label>
      {task.revision > 0 && parent && openTask && <button type="button" onClick={() => openTask(parent)}>Open parent · <span className="preserve-case">{parent.value.title}</span></button>}
      {children.length > 0 && <ul className="task-family-list" aria-label="Child tasks">{children.map(child => <li key={child.id}><button type="button" disabled={!openTask} onClick={() => openTask?.(child)}><span>{child.value.title}</span><small>{child.value.trashed ? 'In Trash' : statusNames[child.value.status]}{child.value.planned ? ` · ${child.value.planned}` : ''}</small></button></li>)}</ul>}
      {newTask && task.revision > 0 && <button type="button" onClick={() => newTask({ parentTaskId: task.id, projectId: task.value.projectId, timezone: task.value.timezone ?? snapshot.layout.value.timezone })}>Add child task</button>}
      <p className="metadata">Each child keeps its own notes, dates and completion. Your edits stay here when you open another task.</p>
    </div>
  </details>;
}
