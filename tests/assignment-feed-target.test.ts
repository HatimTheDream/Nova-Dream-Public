import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ComponentProps } from 'react';
import type { Entity, Snapshot } from '../packages/domain/contracts';
import type { Assignment } from '../packages/domain/workspace-records';
import type { AssignmentAttempt, AssignmentState } from '../packages/domain/assignments';

const fixtureKey = Symbol.for('nova.test.assignment-feed-target');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
// Keep the real run renderer, effects and event handlers. Isolate its network
// boundary and unrelated child trays so these checks cannot start real work.
const hooks = registerHooks({
 resolve(specifier, context, next) {
  if (/\/apps\/client\/src\/AssignmentRuns\./.test(context.parentURL ?? '')) {
   if (specifier === 'react') return { url: 'nova-feed-target:react', shortCircuit: true };
   if (['./api', './useWorkspace', './AssignmentReview', './ContentOutputs', './AssignmentApprovalTray', './ModuleActionTray', './useDeadline'].includes(specifier)) return { url: 'nova-feed-target:' + specifier.slice(2), shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  const fixture = `globalThis[Symbol.for('nova.test.assignment-feed-target')]`;
  if (url === 'nova-feed-target:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
   export const useState = initial => ${fixture}.state(initial);
   export const useRef = initial => ${fixture}.ref(initial);
   export const useEffect = (run, deps) => ${fixture}.effect(run, deps);` };
  if (url === 'nova-feed-target:api') return { format: 'module', shortCircuit: true, source: `
   export class ApiError extends Error { constructor(code,message,current,status){super(message);this.code=code;this.current=current;this.status=status;} }
   export const readLocal = key => ${fixture}.storage.get(key);
   export const saveLocal = (key,value) => { ${fixture}.writes.push({key,value});${fixture}.storage.set(key,value);return true; };
   export const request = (path,data,signal) => ${fixture}.request(path,data,signal);` };
  if (url === 'nova-feed-target:useWorkspace') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='feed-target-window';` };
  if (url === 'nova-feed-target:AssignmentReview') return { format: 'module', shortCircuit: true, source: `export function AssignmentReview(){return null;}` };
  if (url === 'nova-feed-target:ContentOutputs') return { format: 'module', shortCircuit: true, source: `export function UseAssignmentInContent(){return null;}` };
  if (url === 'nova-feed-target:AssignmentApprovalTray') return { format: 'module', shortCircuit: true, source: `export const useAssignmentApprovals=()=>({error:'',state:{items:[]},refresh:async()=>{}});export function AssignmentApprovalTray(){return null;}` };
  if (url === 'nova-feed-target:ModuleActionTray') return { format: 'module', shortCircuit: true, source: `export function ModuleActionTray(){return null;}` };
  if (url === 'nova-feed-target:useDeadline') return { format: 'module', shortCircuit: true, source: `export const useDeadline=()=>({expired:false,remaining:'5 minutes'});` };
  return next(url, context);
 },
});
const { AssignmentRuns } = await import('../apps/client/src/AssignmentRuns');
test.after(() => { hooks.deregister(); delete (globalThis as any)[fixtureKey]; });

const epoch = '11111111-1111-4111-8111-111111111111';
const aId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const plan = { id: 'assignment:kept', revision: 8, deviceId: 'device:qa', updatedAt: '', value: { title: 'Current plan', state: 'planned', archived: false, maxMinutes: 5, projectId: null } } as Entity<Assignment>;
const snapshot = { epoch, deviceId: 'device:qa', projects: [] } as unknown as Snapshot;
function attempt(id: string, label: string): AssignmentAttempt {
 return { id, epoch, deviceId: snapshot.deviceId, assignmentId: plan.id, assignmentRevision: 3, title: `Run ${label}`, agentId: 'agent:writer', agentRevision: 2, agentName: 'Writer', projectId: null,
  createdAt: 1, updatedAt: 2, deadlineAt: 1000, state: 'returned', message: `Outcome ${label}`,
  result: { disposition: 'visible', preview: `Exact result ${label}`, previewTruncated: false, file: { id: `file:${label}`, name: `${label}.txt`, size: 14, sha256: 'a'.repeat(64) } },
 };
}
const older = attempt(aId, 'A'), newer = attempt(bId, 'B'), next = attempt(cId, 'C');
type Read = { path: string; data?: unknown; signal?: AbortSignal; resolve(value: unknown): void; reject(reason: Error): void };
type Effect = { deps: unknown[]; cleanup?: () => void };
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function nodes(value: any): any[] { return Array.isArray(value) ? value.flatMap(nodes) : value?.props ? [value, ...nodes(value.props.children)] : []; }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value); }

class Runs {
 slots: any[] = []; index = 0; effects: (() => void)[] = []; calls: { path: string; data?: unknown }[] = []; reads: Read[] = [];
 storage = new Map<string, unknown>(); writes: unknown[] = [];
 target: { id: string; epoch: string } | undefined = { id: aId, epoch };
 cleared = 0;
 history: AssignmentState = { attempts: [newer], nextCursor: bId, canStart: true, reason: 'Ready' };
 state(initial: any) { const index = this.index++; if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? initial() : initial;return [this.slots[index], (value: any) => { this.slots[index] = typeof value === 'function' ? value(this.slots[index]) : value; }]; }
 ref(initial: unknown) { const index = this.index++; return this.slots[index] ??= { current: initial }; }
 effect(run: () => (() => void) | void, deps: unknown[]) {
  const index = this.index++, previous: Effect | undefined = this.slots[index];
  if (!previous || previous.deps.length !== deps.length || deps.some((value, n) => !Object.is(value, previous.deps[n]))) this.effects.push(() => { previous?.cleanup?.(); this.slots[index] = { deps, cleanup: run() }; });
 }
 request(path: string, data?: unknown, signal?: AbortSignal) {
  this.calls.push({ path, data });
  if (path.startsWith('assignments/state?')) return Promise.resolve(this.history);
  return new Promise((resolve, reject) => this.reads.push({ path, data, signal, resolve, reject }));
 }
 render() {
  (globalThis as any)[fixtureKey] = this; this.index = 0; this.effects = [];
  const props: ComponentProps<typeof AssignmentRuns> = { entity: plan, snapshot, dirty: true, refresh: async () => {}, targetAttempt: this.target,
   clearTarget: () => { this.cleared++; this.target = undefined; } };
  const tree = AssignmentRuns(props); for (const run of this.effects) run(); return tree;
 }
 read(id = this.target?.id) {
  const request = this.reads.find(item => item.path === `assignments/attempt/${encodeURIComponent(id!)}`);
  assert.ok(request, 'The exact requested attempt must be read directly'); return request;
 }
 button(name: RegExp) {
  const button = nodes(this.render()).find(node => node.type === 'button' && name.test(text(node.props.children)));
  assert.ok(button, `Expected an available ${name} action`); return button;
 }
 readonly() {
  assert.ok(this.calls.every(call => call.data === undefined && (/^assignments\/state\?/.test(call.path) || /^assignments\/attempt\//.test(call.path))), 'Reading a target must not start, stop, reconcile or save work');
  assert.equal(this.writes.length, 0, 'Reading and dismissing a target must not change retained commands');
 }
 dispose() { for (const slot of this.slots) slot?.cleanup?.(); }
}
async function fixture(t: any) { const f = new Runs(); t.after(() => f.dispose()); f.render(); await settle(); return f; }

test('an older exact target shows its own result, download and inputs instead of the recent run', async t => {
 const f = await fixture(t); assert.doesNotMatch(text(f.render()), /Exact result B/);
 f.read().resolve({ attempt: older }); await settle();
 let tree = f.render(); assert.match(text(tree), /Exact result A/); assert.doesNotMatch(text(tree), /Exact result B/);
 assert.match(text(tree), /Showing the saved attempt you opened/);
 assert.ok(nodes(tree).some(node => node.type === 'a' && node.props.href === '/api/attachments/file:A'));
 f.button(/Review saved inputs/i).props.onClick(); tree = f.render();
 const review = nodes(tree).find(node => node.type?.name === 'AssignmentReview'); assert.equal(review?.props.id, aId);
 review.props.close(); f.button(/Show attempt history/i).props.onClick();
 assert.equal(f.cleared, 1); tree = f.render(); assert.match(text(tree), /Exact result B/); assert.doesNotMatch(text(tree), /Exact result A/); f.readonly();
});

for (const [label, foreign] of [
 ['another plan', { ...older, assignmentId: 'assignment:other' }],
 ['another workspace', { ...older, epoch: '22222222-2222-4222-8222-222222222222' }],
 ['another attempt', { ...older, id: cId }],
] as const) test(`a target response for ${label} is refused without substituting recent work`, async t => {
 const f = await fixture(t); f.read().resolve({ attempt: foreign }); await settle();
 const tree = f.render(); assert.ok(nodes(tree).some(node => node.props.role === 'alert'));
 assert.match(text(tree), /Selected attempt/); assert.deepEqual(f.target, { id: aId, epoch }); assert.doesNotMatch(text(tree), /Exact result [ABC]/);
 assert.ok(f.button(/^Retry/i)); f.readonly();
});

test('missing exact detail retains its identity and retries the same read without selecting the latest run', async t => {
 const f = await fixture(t); f.read().reject(new Error('This assignment attempt is unavailable.')); await settle();
 let tree = f.render(); assert.match(text(tree), /unavailable/); assert.deepEqual(f.target, { id: aId, epoch }); assert.doesNotMatch(text(tree), /Exact result B/);
 f.button(/^Retry/i).props.onClick(); f.render(); await settle();
 const requests = f.reads.filter(read => read.path === `assignments/attempt/${aId}`); assert.equal(requests.length, 2);
 requests[1].resolve({ attempt: older }); await settle(); tree = f.render();
 assert.match(text(tree), /Exact result A/); assert.doesNotMatch(text(tree), /unavailable/); f.readonly();
});

test('a late response for A cannot replace newly requested C', async t => {
 const f = await fixture(t), first = f.read();
 f.target = { id: cId, epoch }; let tree = f.render();
 assert.ok(first.signal?.aborted, 'The obsolete target request must be aborted'); assert.doesNotMatch(text(tree), /Exact result [ABC]/);
 f.read(cId).resolve({ attempt: next }); await settle(); assert.match(text(f.render()), /Exact result C/);
 first.resolve({ attempt: older }); await settle(); tree = f.render();
 assert.match(text(tree), /Exact result C/); assert.doesNotMatch(text(tree), /Exact result [AB]/); f.readonly();
});

test('changing the exact target closes the previous run inputs without changing retained commands', async t => {
 const f = await fixture(t); f.read().resolve({ attempt: older }); await settle();
 f.button(/Review saved inputs/i).props.onClick(); assert.ok(nodes(f.render()).some(node => node.type?.name === 'AssignmentReview' && node.props.id === aId));
 f.target = { id: cId, epoch }; f.render(); await settle();
 assert.ok(!nodes(f.render()).some(node => node.type?.name === 'AssignmentReview'));
 f.read(cId).resolve({ attempt: next }); await settle(); assert.match(text(f.render()), /Exact result C/); f.readonly();
});

test('dismissing while a target read is pending leaves history visible when that response arrives', async t => {
 const f = await fixture(t), pending = f.read(); f.button(/Show attempt history/i).props.onClick();
 assert.match(text(f.render()), /Exact result B/); pending.resolve({ attempt: older }); await settle();
 const tree = f.render(); assert.match(text(tree), /Exact result B/); assert.doesNotMatch(text(tree), /Exact result A/); f.readonly();
});

test('a target retained from another workspace cannot display a matching old-epoch response', async t => {
 const f = new Runs(); t.after(() => f.dispose()); f.target = { id: aId, epoch: '22222222-2222-4222-8222-222222222222' }; f.render(); await settle();
 const request = f.reads.find(read => read.path === `assignments/attempt/${aId}`);
 request?.resolve({ attempt: { ...older, epoch: f.target.epoch } }); await settle();
 const tree = f.render(); assert.ok(nodes(tree).some(node => node.props.role === 'alert')); assert.doesNotMatch(text(tree), /Exact result [AB]/); f.readonly();
});
