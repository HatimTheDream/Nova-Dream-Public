import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultLayout, type Entity, type Snapshot, type Task } from '../packages/domain/contracts';

const symbol = Symbol.for('nova.test.tasks-daily-history'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (/\/apps\/client\/src\/(Tasks|useDailyOrder)\./.test(context.parentURL ?? '')) {
      if (specifier === 'react') return { url: 'nova-task-history:react', shortCircuit: true };
      if (specifier === './api') return { url: 'nova-task-history:api', shortCircuit: true };
      if (['./usePlanningClock', './useReorder', './useTaskCalendar', './useCalendarCompletion'].includes(specifier)) return { url: `nova-task-history:${specifier.slice(2)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const fixture = `const f=()=>globalThis[Symbol.for('nova.test.tasks-daily-history')];`;
    if (url === 'nova-task-history:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${fixture}export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useEffect=()=>{};` };
    if (url === 'nova-task-history:api') return { format: 'module', shortCircuit: true, source: `${fixture}export class ApiError extends Error{};export const readLocal=k=>f().storage.get(k);export const saveLocal=(k,v)=>{f().storage.set(k,v);return true;};export const request=()=>{throw Error('Unexpected request');};` };
    if (url === 'nova-task-history:usePlanningClock') return { format: 'module', shortCircuit: true, source: `${fixture}export const usePlanningClock=()=>f().now;` };
    if (url === 'nova-task-history:useReorder') return { format: 'module', shortCircuit: true, source: `export const useReorder=ids=>({order:ids,suppressClick:{current:false},bind:()=>({}),move(){},announcement:''});` };
    if (url === 'nova-task-history:useTaskCalendar') return { format: 'module', shortCircuit: true, source: `export const useTaskCalendar=()=>({rows:[],state:{sources:[],eventsLimited:false},error:''});` };
    if (url === 'nova-task-history:useCalendarCompletion') return { format: 'module', shortCircuit: true, source: `export const useCalendarCompletion=()=>({records:[],value:()=>({done:false}),error:'',busy:false});` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { Tasks } = await import('../apps/client/src/Tasks');
const { TaskTools } = await import('../apps/client/src/TaskTools');
const tools = (tree: any) => elements(tree).find(node => node.type === TaskTools)!;
const chooseView = (tree: any, value: string) => tools(tree).props.filters.props.chooseView(value);
const searchField = (tree: any) => elements(tools(tree).props.search).find(node => node.type === 'input')!;
const previousSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => 'fixture-tab' } });
class Hooks {
  slots: any[] = []; index = 0; now = Date.parse('2026-10-19T16:00:00Z'); storage = new Map<string, unknown>();
  state(value: any) { const i = this.index++; if (!(i in this.slots)) this.slots[i] = typeof value === 'function' ? value() : value; return [this.slots[i], (next: any) => { this.slots[i] = typeof next === 'function' ? next(this.slots[i]) : next; }]; }
  ref(value: unknown) { return this.slots[this.index++] ??= { current: value }; }
  render(props: Parameters<typeof Tasks>[0]) { this.index = 0; (globalThis as any)[symbol] = this; return Tasks(props); }
}
function elements(node: any): any[] { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(elements)]; }
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('');
function fixture() {
  const make = (id: string, planned: string, status: Task['status'] = 'open'): Entity<Task> => ({ id, revision: 1, deviceId: 'fixture', updatedAt: '2026-10-19T16:00:00Z', value: { title: id, notes: '', due: '', planned, status } });
  const tasks = [make('ordinary', '2026-10-17'), make('missed-daily', '2026-10-18', 'blocked'), make('current-daily', '2026-10-19'), make('unknown-occurrence', '2026-10-18')];
  const occurrences = tasks.slice(1).map(t => ({ taskId: t.id, routineId: `routine:${t.id}`, templateRevision: 1, date: t.value.planned, timezone: 'UTC', kind: 'task' as const }));
  const snapshot: Snapshot = {
    epoch: 'fixture', cursor: 0, deviceId: 'fixture', tasks, projects: [], routines: [], drafts: [],
    capabilities: { assistant: false, voice: false, reason: 'Isolated Tasks fixture' },
    layout: { id: 'layout:fixture', revision: 1, deviceId: 'fixture', updatedAt: '2026-10-19T16:00:00Z', value: { ...structuredClone(defaultLayout), timezone: 'UTC' } },
    taskState: { occurrences, presentation: { 'missed-daily': { recurrence: { cadence: 'daily', interval: 1 } }, 'current-daily': { recurrence: { cadence: 'daily', interval: 1 } } }, events: [], routineEvents: [], focus: [], orders: [], earnedXp: 0 },
  };
  const created:Partial<Task>[]=[], opened: Entity<Task>[] = [], changed: { task: Entity<Task>; status: Task['status'] }[] = [];
  const props = { snapshot, routineTarget: null, clearRoutineTarget() {}, openCalendar() {}, newTask(value:Partial<Task>) {created.push(value);}, editTask(task: Entity<Task>) { opened.push(task); }, changeStatus(task: Entity<Task>, status: Task['status']) { changed.push({ task, status }); }, async refresh() {}, actions: { busy: false, state: { queue: [] }, async run() { throw Error('Unexpected write'); } } } as unknown as Parameters<typeof Tasks>[0];
  return { hooks: new Hooks(), snapshot, props, opened, changed, created };
}

test('Tasks opens exact incomplete daily history, exposes original metadata, and never changes it merely by navigating', () => {
  const f = fixture(), before = structuredClone(f.snapshot), initial = f.hooks.render(f.props);
  assert.deepEqual(elements(initial).filter(n => n.props?.className === 'task-open').map(n => n.props.title), ['ordinary', 'unknown-occurrence', 'current-daily']);
  chooseView(initial, 'Daily History');
  const history = f.hooks.render(f.props), row = elements(history).find(n => n.props?.className === 'task-open')!;
  assert.equal(row.props.title, 'missed-daily'); row.props.onClick();
  assert.equal(f.opened[0], f.snapshot.tasks[1]); assert.equal(f.opened[0].value.status, 'blocked');
  const html = renderToStaticMarkup(history);
  assert.match(html, /Blocked/); assert.match(html, /dateTime="2026-10-18"/); assert.match(html, /Search daily history/);
  assert.match(html, /id="task-add-disclosure"[^>]*hidden/); // Mounted writing stays hidden until explicitly opened.
  assert.deepEqual(f.changed, []); assert.deepEqual(f.snapshot, before);
  const reloaded = new Hooks(); reloaded.storage = f.hooks.storage;
  assert.deepEqual(elements(reloaded.render(f.props)).filter(n => n.props?.className === 'task-open').map(n => n.props.title), ['missed-daily']);
});

test('history search stays scoped while global search can still retrieve the missed daily occurrence', () => {
  const f = fixture(); let tree = f.hooks.render(f.props);
  chooseView(tree, 'Daily History'); tree = f.hooks.render(f.props);
  searchField(tree).props.onChange({ target: { value: 'ordinary' } }); tree = f.hooks.render(f.props);
  assert.equal(elements(tree).filter(n => n.props?.className === 'task-open').length, 0);
  chooseView(tree, 'Today'); tree = f.hooks.render(f.props);
  assert.deepEqual(elements(tree).filter(n => n.props?.className === 'task-open').map(n => n.props.title), ['ordinary']);
  searchField(tree).props.onChange({ target: { value: 'missed-daily' } }); tree = f.hooks.render(f.props);
  assert.deepEqual(elements(tree).filter(n => n.props?.className === 'task-open').map(n => n.props.title), ['missed-daily']);
  assert.match(renderToStaticMarkup(tree), /Search Results · All Tasks/); assert.deepEqual(f.changed, []);
});

test('a completed-today row remains in its group and row position with a reversible checkbox', () => {
  const f = fixture(); let tree = f.hooks.render(f.props);
  const titles = () => elements(tree).filter(n => n.props?.className === 'task-open').map(n => n.props.title), before = titles();
  elements(tree).find(n => n.type === 'button' && n.props['aria-label'] === 'Complete ordinary')!.props.onClick();
  assert.deepEqual(f.changed, [{ task: f.snapshot.tasks[0], status: 'done' }]);
  f.snapshot.tasks[0].value.status = 'done'; f.snapshot.taskState!.presentation!.ordinary = { completedAt: '2026-10-19T16:00:00Z' };
  tree = f.hooks.render(f.props); assert.deepEqual(titles(), before);
  const checkbox = elements(tree).find(n => n.type === 'button' && n.props['aria-label'] === 'Reopen ordinary')!;
  assert.equal(checkbox.props['aria-pressed'], true); checkbox.props.onClick(); assert.equal(f.changed.at(-1)!.status, 'open');
  assert.match(renderToStaticMarkup(tree), /1 open · 1 done/);
});

test('Daily History reports all matching occurrences when its rendered page is limited', () => {
  const f = fixture(), state = f.snapshot.taskState!;
  for (let n = 0; n < 60; n++) {
    const id = `missed-extra-${n}`;
    f.snapshot.tasks.push({ ...f.snapshot.tasks[1], id, value: { ...f.snapshot.tasks[1].value, title: id } });
    state.occurrences.push({ ...state.occurrences[0], taskId: id });
    state.presentation![id] = { recurrence: { cadence: 'daily', interval: 1 } };
  }
  let tree = f.hooks.render(f.props);
  chooseView(tree, 'Daily History'); tree = f.hooks.render(f.props);
  assert.equal(elements(tree).filter(n => n.props?.className === 'task-open').length, 50);
  assert.match(renderToStaticMarkup(tree), /61 occurrences/);
  assert.equal(elements(tree).find(n => n.type === 'h2' && text(n) === 'Daily History')!.props.className, 'sr-only');
  elements(tree).find(n => n.type === 'button' && text(n) === 'Show 11 more · 11 remaining')!.props.onClick(); tree = f.hooks.render(f.props);
  assert.equal(elements(tree).filter(n => n.props?.className === 'task-open').length, 61);
  assert.match(renderToStaticMarkup(tree), /61 occurrences/);
});

test.after(() => { loader.deregister(); delete (globalThis as any)[symbol]; if (previousSession) Object.defineProperty(globalThis, 'sessionStorage', previousSession); else delete (globalThis as any).sessionStorage; });

test('compact toolbar retains Add Child Task and Duplicate original row callbacks', () => {
 const f=fixture(),tree=f.hooks.render(f.props),before=structuredClone(f.snapshot);
 const buttons=elements(tree).filter(n=>n.type==='button');
 buttons.find(n=>text(n)==='Add Child Task')!.props.onClick();
 buttons.find(n=>text(n)==='Duplicate')!.props.onClick();
 assert.equal(f.created[0].parentTaskId,'ordinary');assert.equal(f.created[0].timezone,'UTC');
 assert.equal(f.created[1].title,'ordinary (copy)');assert.equal(f.created[1].status,'open');assert.equal(f.created[1].reminder,null);
 assert.deepEqual(f.snapshot,before);assert.deepEqual(f.changed,[]);
});
