import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildProfileProgress, progressHistory } from '../packages/domain/profile-progression';
import { buildProfileDay, buildProfileWeek } from '../packages/domain/profile-week';
import type { Entity, Task } from '../packages/domain/contracts';
import type { TaskEvent } from '../packages/domain/tasks';
import { emptyProfileView, type ProfileView } from '../apps/client/src/profile-view';

const key = Symbol.for('nova.test.profile-week-ui'), react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (/\/apps\/client\/src\/ProfileWeek\./.test(context.parentURL ?? '')) {
      if (specifier === 'react') return { url: 'nova-week:react', shortCircuit: true };
      if (specifier === './api') return { url: 'nova-week:api', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const f = `const f=()=>globalThis[Symbol.for('nova.test.profile-week-ui')];`;
    if (url === 'nova-week:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${f}export const useState=v=>f().state(v);export const useRef=v=>f().ref(v);export const useEffect=(fn,deps)=>f().effect(fn,deps);` };
    if (url === 'nova-week:api') return { format: 'module', shortCircuit: true, source: `${f}export const request=(p,d)=>{if(d!==undefined)throw Error('No command allowed');return f().read(p);};` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ProfileWeek } = await import('../apps/client/src/ProfileWeek');
const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join('');
const expanded = (tree: any) => nodes(tree).flatMap(node => typeof node.type === 'function' && ['PageStatus', 'PageActions'].includes(node.type.name) ? nodes(node.type(node.props)) : [node]);
function button(tree: any, label: string) { const row = expanded(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label)); assert(row, label); return row; }
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const task: Entity<Task> = { id: 'task:original', revision: 121, deviceId: 'device', updatedAt: '2026-10-20T12:00:00Z', value: { title: 'Original exact Task', notes: 'Kept writing', status: 'done', planned: '', due: '' } };
const events: TaskEvent[] = Array.from({ length: 121 }, (_, i) => ({ id: `${task.id}:${i + 1}`, taskId: task.id, at: '2026-10-19T12:00:00Z', from: i % 2 ? 'done' : 'open', to: i % 2 ? 'open' : 'done', xpDelta: i % 2 ? -10 : 10 }));
const now = Date.parse('2026-10-20T12:00:00Z'), instances = new Set<Fixture>();
class Fixture {
  slots: any[] = []; index = 0; effects: (() => void)[] = []; calls: string[] = []; updates = 0;
  view: ProfileView = { ...emptyProfileView, tab: 'week', week: { start: '2026-10-19', timezone: 'UTC' }, day: '2026-10-19' };
  progress = buildProfileProgress([task], events, [], 'UTC', now, 'epoch'); failSave = false; failRead = false; available = true; opened: string[] = [];
  focused: string[] = []; scroll = { scrollTop: 0, addEventListener() {}, removeEventListener() {} };
  override?: (path: string) => Promise<any> | undefined;
  state(initial: any) { const i = this.index++; if (!(i in this.slots)) this.slots[i] = typeof initial === 'function' ? initial() : initial; return [this.slots[i], (value: any) => { this.updates++; this.slots[i] = typeof value === 'function' ? value(this.slots[i]) : value; }]; }
  ref(value: unknown) { return this.slots[this.index++] ??= { current: value }; }
  effect(fn: () => (() => void) | void, deps: unknown[]) { const i = this.index++, old = this.slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) this.effects.push(() => { old?.cleanup?.(); this.slots[i] = { deps, cleanup: fn() }; }); }
  response(path: string) {
    const url = new URL(path, 'http://fixture.invalid/'), params = url.searchParams, identity = { start: params.get('start')!, timezone: params.get('timezone')! };
    if (url.pathname.endsWith('/activity')) return buildProfileDay([task], events, identity, params.get('day')!, 'epoch', params.get('before') ?? undefined, 121);
    if (url.pathname.endsWith('/history')) {
      const page = progressHistory([task], events, params.get('before') ?? undefined);
      return { epoch: 'epoch', revision: 121, head: this.progress.history.entries[0]?.id ?? null, page };
    }
    return buildProfileWeek([task], events, identity, this.progress.timezone, now, 'epoch');
  }
  async read(path: string) { this.calls.push(path); if (this.failRead) throw Error('Read unavailable'); return this.override?.(path) ?? this.response(path); }
  render(active = true) {
    instances.add(this); (globalThis as any)[key] = this; this.index = 0; this.effects = [];
    const available = this.available;
    const tree = ProfileWeek({ epoch: 'epoch', deviceId: 'device', progress: this.progress, revision: 121, view: this.view, active,
      changeView: patch => { if (this.failSave) return false; this.view = { ...this.view, ...patch }; return true; },
      captureView: patch => { this.view = { ...this.view, ...patch }; }, canOpenTask: id => available && id === task.id, openTask: id => this.opened.push(id) });
    for (const node of nodes(tree)) if (node.props?.ref && typeof node.props.ref === 'object') node.props.ref.current = { closest: () => this.scroll, focus: () => this.focused.push(text(node)) };
    for (const effect of this.effects) effect(); return tree;
  }
  dispose() { for (const slot of this.slots) slot?.cleanup?.(); instances.delete(this); }
}
test.afterEach(() => { for (const f of [...instances]) f.dispose(); });
test.after(() => { loader.deregister(); delete (globalThis as any)[key]; });

test('actual week/history callbacks retain loaded pages, selected day, scroll and Back focus', async () => {
  const f = new Fixture(); f.render(); await settle(); let tree = f.render();
  f.scroll.scrollTop = 321; button(tree, 'See Full Earned History').props.onClick(); tree = f.render(); await settle(); tree = f.render();
  assert.equal(f.view.weekScroll, 321); assert(f.focused.includes('Earned History'));
  assert(text(tree).includes('50 of 121 earned entries'));
  await button(tree, 'Load Earlier History').props.onClick(); tree = f.render(); assert(text(tree).includes('100 of 121 earned entries'));
  f.scroll.scrollTop = 654; button(tree, 'Back To My Week').props.onClick(); tree = f.render();
  assert.equal(f.scroll.scrollTop, 321); assert.equal(f.view.historyScroll, 654); assert.equal(f.view.day, '2026-10-19'); assert(f.focused.includes('See Full Earned History'));
  const reads = f.calls.filter(path => path.startsWith('profile/week/history')).length;
  button(tree, 'See Full Earned History').props.onClick(); tree = f.render(); await settle(); tree = f.render();
  assert(text(tree).includes('100 of 121 earned entries')); assert.equal(f.scroll.scrollTop, 654);
  assert.equal(f.calls.filter(path => path.startsWith('profile/week/history')).length, reads);
});

test('failed view persistence refuses week/timezone/Task navigation and retains original selection', async () => {
  const f = new Fixture(); f.render(); await settle(); let tree = f.render(); f.failSave = true;
  const original = structuredClone(f.view); button(tree, 'Previous Week').props.onClick(); assert.deepEqual(f.view, original);
  button(tree, 'See Full Earned History').props.onClick(); assert.deepEqual(f.view, original);
  button(tree, task.value.title).props.onClick(); assert.deepEqual(f.opened, []);
  f.failSave = false; f.progress = { ...f.progress, timezone: 'Asia/Tokyo' }; tree = f.render(); await settle(); tree = f.render();
  assert.equal(f.view.week!.timezone, 'UTC'); assert(text(tree).includes('Retained timezone'));
  button(tree, 'Use Current Home Timezone').props.onClick(); assert.equal(f.view.week!.timezone, 'Asia/Tokyo');
});

test('wrong activity week, timezone or day is refused and old owner cannot publish after a selection changes', async () => {
  for (const field of ['start', 'timezone', 'day'] as const) {
    const f = new Fixture(); f.override = async path => {
      const value: any = f.response(path);
      if (path.startsWith('profile/week/activity')) return field === 'day' ? { ...value, day: '2026-10-20' } : { ...value, identity: { ...value.identity, [field]: field === 'start' ? '2026-10-12' : 'Asia/Tokyo' } };
      return value;
    };
    f.render(); await settle(); const tree = f.render();
    assert(expanded(tree).some(node => node.props?.role === 'alert' && text(node).includes('another day')), field);
    assert(!text(tree).includes('50 of 121 activity entries')); f.dispose();
  }
  const f = new Fixture(), late = deferred<any>(); f.override = path => path.startsWith('profile/week/activity') ? late.promise : undefined;
  f.render(); await settle(); button(f.render(), 'Next Week').props.onClick(); f.override = undefined; f.render(); await settle();
  late.resolve(buildProfileDay([task], events, { start: '2026-10-19', timezone: 'UTC' }, '2026-10-19', 'epoch', undefined, 121)); await settle();
  assert.equal(f.view.week!.start, '2026-10-26'); assert(!text(f.render()).includes('50 of 121 activity entries'));
});

test('history read failure and owner retirement retain confirmed rows and ignore late callbacks', async () => {
  const f = new Fixture(); f.view.weekSection = 'history'; f.render(); await settle(); let tree = f.render();
  await button(tree, 'Load Earlier History').props.onClick(); tree = f.render(); f.failRead = true;
  await button(tree, 'Load Earlier History').props.onClick(); tree = f.render();
  assert(text(tree).includes('100 of 121 earned entries')); assert(expanded(tree).some(node => node.props?.role === 'alert' && text(node) === 'Read unavailable'));
  f.failRead = false; const late = deferred<any>(); f.override = () => late.promise;
  const action = button(tree, 'Load Earlier History').props.onClick(); f.dispose(); const updates = f.updates, view = structuredClone(f.view);
  late.resolve(f.response('profile/week/history?before=' + progressHistory([task], events, f.progress.history.next!).entries[49].id)); await action;
  assert.equal(f.updates, updates); assert.deepEqual(f.view, view);
});

test('activity keeps its saved row but refuses a Task removed after the read, including the earlier callback', async () => {
  const f = new Fixture(); f.render(); await settle();
  const before = button(f.render(), task.value.title), originalView = structuredClone(f.view);
  assert.equal(before.props.disabled, false); f.available = false;
  const after = button(f.render(), task.value.title); assert.equal(after.props.disabled, true);
  before.props.onClick(); after.props.onClick();
  assert.deepEqual(f.opened, []); assert.deepEqual(f.view, originalView);
  assert(text(f.render()).includes('50 of 121 activity entries'));
});
