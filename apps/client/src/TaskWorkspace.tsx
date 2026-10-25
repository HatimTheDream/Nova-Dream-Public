import { Suspense, useRef, useState } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { readLocal, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { TaskNavigationController, type TaskOrigin, type TaskSection } from './task-editor-navigation';
import { lazy } from './preload-lazy';
import { Dialog } from './ui';
const TaskEditor = lazy(() => import('./TaskEditor').then(module => ({ default: module.TaskEditor })));
const RoutineEditor = lazy(() => import('./RoutineEditor').then(module => ({ default: module.RoutineEditor })));

export function useTaskWorkspace(snapshot: Snapshot) {
  const current = useRef(snapshot); current.current = snapshot;
  const departure = useRef<() => boolean>(() => true);
  const [controller] = useState(() => new TaskNavigationController(
    { deviceId: snapshot.deviceId, epoch: snapshot.epoch, windowId: retainedWindowId },
    { read: readLocal, write: saveLocal }, () => current.current,
  ));
  const [, render] = useState(0);
  const run = (action: () => boolean) => { const result = action(); render(value => value + 1); return result; };
  return {
    controller, state: controller.state, task: controller.selected, error: controller.error,
    open: (task: Entity<Task>, origin: TaskOrigin) => run(() => departure.current() && controller.open(task, origin)),
    registerDeparture: (guard: () => boolean) => { departure.current = guard; return () => { if (departure.current === guard) departure.current = () => true; }; },
    dismissError: () => run(() => controller.dismissError()),
    go: (task: Entity<Task>) => run(() => controller.go(task)),
    child: (defaults: Partial<Task>) => run(() => controller.child(defaults)),
    view: (section: TaskSection, scroll: number) => run(() => controller.view(section, scroll)),
    futureSchedule: (token: string) => run(() => controller.futureSchedule(token)),
    occurrence: (token: string) => run(() => controller.occurrence(token)),
    back: () => run(() => controller.back()), close: () => run(() => controller.close()),
    acknowledge: (task: Entity<Task>, token: string, clean: boolean) => run(() => controller.acknowledged(task, token, clean)),
  };
}

export function TaskWorkspace({ workspace, snapshot, refresh, closed, openOrigin, canClose = () => true }: {
  workspace: ReturnType<typeof useTaskWorkspace>; snapshot: Snapshot; refresh(): Promise<void>;
  closed(origin: TaskOrigin): void; openOrigin(origin: NonNullable<Task['origin']>): void;
  canClose?(origin: TaskOrigin, retry: () => void): boolean;
}) {
  const state = workspace.state;
  if (!state?.active) return workspace.error ? <Dialog title="Open Task" close={workspace.dismissError}><p role="alert">{workspace.error}</p></Dialog> : null;
  const task = workspace.task, frame = state.frames.at(-1)!;
  const finish = () => {
    if (!workspace.controller.state?.active || workspace.controller.state.token !== state.token) return;
    if (canClose(state.origin, finish) && workspace.close()) closed(state.origin);
  };
  if (!task) return <Dialog title="Task Unavailable" close={finish}><p>The original task is unavailable in this workspace. Its draft and return path are kept.</p>{workspace.error && <p role="alert">{workspace.error}</p>}{state.frames.length > 1 && <button type="button" onClick={workspace.back}>Back To Previous Task</button>}<button type="button" onClick={finish}>Back To {state.origin.label}</button></Dialog>;
  if (state.routine) {
    const pointer = state.routine;
    const occurrence = snapshot.taskState?.occurrences.find(item => item.taskId === pointer.taskId && item.routineId === pointer.routineId);
    const routine = occurrence && snapshot.routines?.find(item => item.id === pointer.routineId && item.revision > 0);
    const backToOccurrence = () => { workspace.occurrence(state.token); };
    if (!routine) return <Dialog title="Future Schedule Unavailable" close={backToOccurrence}><p>The original series is unavailable. This occurrence, its schedule draft and its return path are kept.</p>{workspace.error && <p role="alert">{workspace.error}</p>}<button type="button" onClick={backToOccurrence}>Back To This Occurrence</button></Dialog>;
    return <Suspense fallback={<Dialog title="Opening Future Schedule" close={backToOccurrence}><p role="status">Reading your kept schedule…</p></Dialog>}><RoutineEditor key={`${routine.id}:${state.token}`} routine={routine} snapshot={snapshot} occurrenceTitle={task.value.title}
      close={backToOccurrence} navigationError={workspace.error} registerDeparture={workspace.registerDeparture}
      saved={(confirmed, clean) => { if (clean && confirmed.id === pointer.routineId) workspace.occurrence(state.token); void refresh(); }}/></Suspense>;
  }
  const previous = state.frames.at(-2), parent = previous && workspace.controller.resolve(previous.taskId);
  return <Suspense fallback={<Dialog title="Opening Task" close={finish}><p role="status">Reading your kept task…</p></Dialog>}><TaskEditor key={task.id} task={task} snapshot={snapshot} section={frame.section} scroll={frame.scroll} sectionScroll={frame.sectionScroll} keepView={workspace.view}
    registerDeparture={workspace.registerDeparture}
    back={previous ? workspace.back : finish} backLabel={previous ? `Back To ${parent?.value.title || 'Previous Task'}` : `Back To ${state.origin.label}`}
    navigationError={workspace.error} close={finish} openTask={workspace.go} newTask={workspace.child}
    openFutureSchedule={() => { workspace.futureSchedule(state.token); }}
    openOrigin={origin => { if (workspace.close()) openOrigin(origin); }}
    saved={(confirmed, clean) => {
      const returning = clean && workspace.controller.state?.token === state.token && state.frames.length === 1;
      const changed = workspace.acknowledge(confirmed, state.token, clean && (!returning || canClose(state.origin, finish)));
      if (changed && !workspace.controller.state?.active) closed(state.origin);
      void refresh();
    }}/></Suspense>
}
