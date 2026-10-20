import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, taskSchema, type Snapshot, type Entity, type Task } from '../packages/domain/contracts';
import { blankRecord, type Contact } from '../packages/domain/workspace-records';
import type { ContactActivity } from '../packages/domain/crm';
import { contactFamily, contactFollowUps, openContactFollowUps, contactDeadlineOverdue, contactsWithOpenFollowUps } from '../apps/client/src/contact-presentation';

// Exercise real Contacts handlers with isolated hooks, retained journals and local data.
// No production workspace, network request, download or agent command is used.
const key = Symbol.for('nova.test.contacts-compact');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
 resolve(specifier, context, next) { return specifier === 'react' && context.parentURL?.includes('/apps/client/src/') ? { url: 'nova-test:contacts-compact', shortCircuit: true } : next(specifier, context); },
 load(url, context, next) {
  if (url === 'nova-test:contacts-compact') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
   const h=()=>globalThis[Symbol.for('nova.test.contacts-compact')];
   export const useState=v=>h().state(v),useRef=v=>h().ref(v),useId=()=>h().id();
   export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;
   export const useMemo=(f,d)=>h().memo(f,d),useCallback=(f,d)=>h().memo(()=>f,d);` };
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
  return next(url, context);
 },
});
const { default: Contacts } = await import('../apps/client/src/Contacts');
const { ContactPage } = await import('../apps/client/src/ContactPage');
const { OrganizationDirectory, ContactPipeline, ContactTimeline } = await import('../apps/client/src/ContactCrm');
const { RecordConnections } = await import('../apps/client/src/RecordConnections');
const { retainedWindowId } = await import('../apps/client/src/useWorkspace');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
const menu = (tree: any, label: string) => nodes(tree).find(node => (node.props.label === label || node.props.label?.startsWith(label + ':')) && typeof node.props.children === 'function')!.props.children(() => {});
const select = (tree: any, label: string) => nodes(nodes(tree).find(node => node.type === 'label' && text(node).startsWith(label))).find(node => node.type === 'select');
const search = (tree: any) => nodes(tree).find(node => node.type === 'input' && node.props.type === 'search');
const at = '2026-10-19T12:00:00Z';
function person(id: string, patch: Partial<Contact> = {}): Entity<Contact> { return { id, revision: 3, updatedAt: at, deviceId: 'fixture-device', value: { ...(blankRecord('contact', 'UTC') as Contact), name: id, ...patch } }; }
function task(id: string, patch: Partial<Task> = {}): Entity<Task> { return { id, revision: 7, updatedAt: at, deviceId: 'fixture-device', value: taskSchema.parse({ title: id, notes: '', status: 'open', planned: '', due: '', bucket: 'capture', projectId: null, ...patch }) }; }
function fixture() {
 const people = [person('contact:morgan', { name: 'Morgan Example', favorite: true, organization: 'Studio', pipelineStage: 'active' }), person('contact:other', { name: 'Another Person' }), person('contact:original', { name: 'Original Morgan', archived: true, mergedInto: 'contact:morgan' })];
 const tasks = [task('task:next', { title: 'Send the original notes', status: 'waiting', planned: '2026-10-21', due: '2026-10-23', origin: { kind: 'contact', id: 'contact:original', revision: 2 } })];
 const snapshot: Snapshot = { epoch: 'fixture-epoch', deviceId: 'fixture-device', cursor: 0, tasks, drafts: [], projects: [], layout: { id: 'layout', revision: 1, updatedAt: at, deviceId: 'fixture-device', value: { ...structuredClone(defaultLayout), timezone: 'UTC' } }, capabilities: { assistant: false, voice: false, reason: 'Isolated fixture' }, records: { content: [], contact: people, agent: [], assignment: [], profile: [] } };
 const opened: Entity<Task>[] = [];
 const props: Parameters<typeof Contacts>[0] = { snapshot, refresh: async () => {}, editTask(value) { opened.push(value); }, openEmail: async () => {}, openCalendar() {}, openSettings() {} };
 return { snapshot, props, people, tasks, opened };
}
const indexKey = () => `e3:record-index:fixture-device:contact:${retainedWindowId}`;
const viewKey = () => indexKey() + ':view';
const journalKey = (id: string) => `e3:journal:fixture-device:${id}:${retainedWindowId}`;
const field = (tree: any, name: string) => nodes(tree).find(node => ['input', 'textarea', 'select'].includes(node.type) && node.props['aria-label'] === name);
const checkbox = (tree: any, name: string) => nodes(nodes(tree).find(node => node.type === 'label' && text(node) === name)).find(node => node.type === 'input');
const organization = { id: 'organization:fixture', revision: 1, memberIds: ['contact:morgan'], value: { name: 'Studio', website: '', phone: '', industry: 'Design', notes: 'Saved original' } };
const crm = { organizations: [organization], activities: [], relationships: [] };
const reads = (path: string) => { if (path === '/api/contacts/crm') return crm; if (path === '/api/contacts/read') return { correspondence: [], calendar: [], senders: [], partial: false }; throw new Error('Unexpected mutation: ' + path); };
function host(initialComponent: (props: any) => any, initialProps: any, respond: (path: string, body: any) => unknown | Promise<unknown> = () => { throw new Error('Unexpected host request'); }) {
  let component = initialComponent, props = initialProps, cursor = 0, dirty = true, tree: any;
  let cells: any[] = [], effects: (() => void)[] = [];
  const frames: (() => void)[] = [], intervals = new Set<() => void>(), storage = new Map<string, string>(), calls: { path: string; body: any }[] = [];
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, n) => !Object.is(value, prior.deps[n]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
      id() { const i = cursor++; return (cells[i] ??= { value: `content-fixture-${i}` }).value; },
      memo(read: () => unknown, deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, n) => !Object.is(value, prior.deps[n]))) cells[i] = { deps, value: read() }; return cells[i].value; },
    },
    window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
    setInterval: (run: () => void) => { intervals.add(run); return run; }, clearInterval: (run: () => void) => intervals.delete(run),
    fetch: async (path: string, init: RequestInit) => { const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body }); return new Response(JSON.stringify(await respond(path, body))); },
  };
  const originals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const flush = async () => { for (let pass = 0; pass < 25; pass++) { if (dirty) { dirty = false; cursor = 0; tree = component(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } while (frames.length) frames.shift()!(); };
  const unmount = () => { for (const cell of cells) cell?.cleanup?.(); };
  return {
    flush, calls, storage, get tree() { return tree; },
    async update(next: any) { props = { ...props, ...next }; dirty = true; await flush(); },
    async mount(nextComponent = component, nextProps = props) { unmount(); cells = []; effects = []; component = nextComponent; props = nextProps; dirty = true; await flush(); },
    async poll() { for (const run of [...intervals]) run(); await flush(); },
    close() { unmount(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}

test('People preferences merge rapid changes and retain the exact selected draft across scopes and reload', async () => {
 const f = fixture(), app = host(Contacts, f.props), original = { value: { ...f.people[0].value, notes: 'Unfinished contact writing' }, dirty: true, revision: 3, epoch: f.snapshot.epoch, pending: { requestId: 'original-save', expectedRevision: 3 } };
 app.storage.set(indexKey(), JSON.stringify({ selected: f.people[0].id, drafts: [], editing: true })); app.storage.set(journalKey(f.people[0].id), JSON.stringify(original));
 try {
  await app.flush(); const prior = app.tree;
  field(prior, 'Search contacts').props.onChange({ target: { value: 'Morgan' } });
  checkbox(menu(prior, 'Filter And Sort People'), 'Favorites').props.onChange({ target: { checked: true } });
  checkbox(menu(prior, 'Filter And Sort People'), 'With Open Follow-Ups').props.onChange({ target: { checked: true } });
  field(menu(prior, 'Filter And Sort People'), 'Sort contacts').props.onChange({ target: { value: 'recent' } });
  button(menu(prior, 'Browse Contacts'), 'Pipeline').props.onClick(); await app.flush();
  const saved = JSON.parse(app.storage.get(viewKey())!); assert.equal(saved.query, 'Morgan'); assert.equal(saved.favorites, true); assert.equal(saved.followUps, true); assert.equal(saved.sort, 'recent'); assert.equal(saved.section, 'pipeline');
  await app.mount(); assert.equal(text(nodes(app.tree).find(node => node.type === 'h1')), 'Pipeline');
  button(menu(app.tree, 'Browse Contacts'), 'People').props.onClick(); await app.flush();
  assert.equal(field(app.tree, 'Search contacts').props.value, 'Morgan'); assert.match(text(app.tree), /1 of 2 people/);
  assert.equal(nodes(app.tree).find(node => node.type?.name === 'RecordEditor').props.id, f.people[0].id);
  assert.deepEqual(JSON.parse(app.storage.get(journalKey(f.people[0].id))!), original);
  button(menu(app.tree, 'Filter And Sort People'), 'Reset Filters').props.onClick(); await app.flush(); assert.equal(field(app.tree, 'Search contacts').props.value, 'Morgan'); assert.equal(JSON.parse(app.storage.get(viewKey())!).followUps, false); assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('storage refusal keeps writing selected and reports the current-window-only view honestly', async () => {
 const f = fixture(), app = host(Contacts, f.props);
 app.storage.set(indexKey(), JSON.stringify({ selected: f.people[0].id, drafts: [], editing: true })); app.storage.set(viewKey(), JSON.stringify({ query: 'Morgan', section: 'people' }));
 try {
  await app.flush(); app.storage.set = () => { throw new Error('Synthetic storage failure'); };
  field(app.tree, 'Search contacts').props.onChange({ target: { value: 'Current query' } }); await app.flush();
  assert.equal(field(app.tree, 'Search contacts').props.value, 'Current query'); assert.match(text(app.tree), /current window only/); assert.equal(JSON.parse(app.storage.get(viewKey())!).query, 'Morgan');
  button(app.tree, 'People').props.onClick(); await app.flush();
  assert.equal(nodes(app.tree).find(node => node.type?.name === 'RecordEditor').props.id, f.people[0].id); assert.match(text(app.tree), /Your writing remains open/); assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('organization query, exact selection and editing survive remount without replaying an old person target', async () => {
 const f = fixture(), props = { snapshot: f.snapshot, refresh: async () => {}, open() {}, selectedName: 'Studio', targetNonce: 'original-target', createRequest: '' }, app = host(OrganizationDirectory, props, reads);
 try {
  await app.flush(); field(app.tree, 'Search organizations').props.onChange({ target: { value: 'Stud' } }); button(app.tree, 'Edit organization').props.onClick(); await app.flush();
  let editor = nodes(app.tree).find(node => node.type?.name === 'OrganizationEditor'); assert.equal(editor.props.organization.id, organization.id);
  await app.mount(); assert.equal(field(app.tree, 'Search organizations').props.value, 'Stud'); editor = nodes(app.tree).find(node => node.type?.name === 'OrganizationEditor'); assert.equal(editor.props.organization.id, organization.id);
  const saved = JSON.parse(app.storage.get(`e3:contact-organizations:fixture-device:${retainedWindowId}`)!); assert.equal(saved.editing, true); assert.equal(saved.seenTarget, 'original-target');
  await app.update({ createRequest: 'new-explicit-choice' }); assert.equal(nodes(app.tree).find(node => node.type?.name === 'OrganizationEditor').props.organization, undefined);
  await app.mount(); assert.equal(nodes(app.tree).find(node => node.type?.name === 'OrganizationEditor').props.organization, undefined); assert.equal(field(app.tree, 'Search organizations').props.value, 'Stud'); assert.ok(app.calls.every(call => call.path === '/api/contacts/crm'));
 } finally { app.close(); }
});

test('organization pending writing reconciles its original command after the retained view returns', async () => {
 const f = fixture(), app = host(OrganizationDirectory, { snapshot: f.snapshot, refresh: async () => {}, open() {} }, path => { if (path === '/api/contacts/crm') return crm; throw new Error('Synthetic uncertain save'); });
 const draft = { ...organization.value, notes: 'Keep this exact organization writing' }, command = { requestId: 'original-organization-save', epoch: f.snapshot.epoch, id: organization.id, expectedRevision: 1, value: draft }, key = `e3:crm-org:fixture-device:${organization.id}:${retainedWindowId}`;
 app.storage.set(`e3:contact-organizations:fixture-device:${retainedWindowId}`, JSON.stringify({ query: 'Stud', selected: organization.id, creating: false, editing: true })); app.storage.set(key, JSON.stringify({ value: draft, revision: 1, pending: command }));
 try {
  await app.flush(); const editor = nodes(app.tree).find(node => node.type?.name === 'OrganizationEditor'); await app.mount(editor.type, { ...editor.props, saved: async () => {}, close() {} });
  assert.match(text(app.tree), /Reconcile save/); app.tree.props.onSubmit({ preventDefault() {} }); await app.flush();
  assert.deepEqual(app.calls.filter(call => call.path === '/api/contacts/organization').map(call => call.body), [command]); assert.deepEqual(JSON.parse(app.storage.get(key)!).pending, command);
  await app.mount(); assert.deepEqual(JSON.parse(app.storage.get(key)!).value, draft);
 } finally { app.close(); }
});

test('pipeline search is separate and retained, and opens the original person without stage changes', async () => {
 const f = fixture(), opened: string[] = [], app = host(ContactPipeline, { deviceId: f.snapshot.deviceId, contacts: f.people, open(id: string) { opened.push(id); } });
 try {
  await app.flush(); field(app.tree, 'Search pipeline').props.onChange({ target: { value: 'Morgan' } }); await app.flush(); await app.mount(); assert.equal(field(app.tree, 'Search pipeline').props.value, 'Morgan');
  nodes(app.tree).find(node => node.type === 'button' && node.props.className === 'contact-row').props.onClick(); assert.deepEqual(opened, [f.people[0].id]); assert.equal(f.people[0].value.pipelineStage, 'active'); assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('next follow-up uses transitive original identities, honest dates and original entity revisions', () => {
 const f = fixture(), chained = person('contact:older', { archived: true, mergedInto: 'contact:original' }), people = [...f.people, chained];
 const dated = task('task:overdue', { due: '2026-10-18', origin: { kind: 'contact', id: chained.id, revision: 1 } }), undated = task('task:undated', { origin: { kind: 'contact', id: f.people[0].id, revision: 3 } });
 const done = task('task:done', { planned: '2026-10-01', status: 'done', origin: dated.value.origin }), skipped = task('task:skipped', { status: 'skipped', origin: dated.value.origin }), trash = task('task:trash', { trashed: true, origin: dated.value.origin });
 const tasks = [...f.tasks, undated, done, skipped, trash, dated]; const before = JSON.stringify({ people, tasks });
 assert.deepEqual(contactFamily(f.people[0].id, people), ['contact:morgan', 'contact:original', 'contact:older']);
 assert.deepEqual(openContactFollowUps(f.people[0].id, people, tasks), [dated, f.tasks[0], undated]); assert.equal(openContactFollowUps(f.people[0].id, people, tasks)[0], dated);
 assert.deepEqual(contactFollowUps('contact:older', people, tasks), [done, skipped, dated]); assert.equal(JSON.stringify({ people, tasks }), before);
 assert.deepEqual([...contactsWithOpenFollowUps(people, tasks)].sort(), ['contact:morgan', 'contact:older', 'contact:original']);
});

test('the person preview opens the same Task and preserves actual timeline time and separate planned/deadline labels', async () => {
 const f = fixture(), app = host(ContactPage, { ...f.props, contact: f.people[0], contacts: f.people, edit() {}, open() {}, close() {}, organization() {} }, reads);
 try {
  await app.flush(); const next = nodes(app.tree).find(node => node.props.className === 'contact-next-task'); assert.ok(next); assert.match(text(next), /Status: waiting/); assert.match(text(next), /Planned: 2026-10-21/); assert.match(text(next), /Deadline: 2026-10-23/); next.props.onClick(); assert.equal(f.opened[0], f.tasks[0]); assert.equal(f.opened[0].revision, 7);
  const timeline = nodes(app.tree).find(node => node.type === ContactTimeline); assert.equal(timeline.props.items[0].at, at); timeline.props.items[0].open(); assert.equal(f.opened[1], f.tasks[0]); assert.ok(app.calls.every(call => ['/api/contacts/crm', '/api/contacts/read'].includes(call.path)));
 } finally { app.close(); }
});

test('activity filters retain exact original callbacks and archived scope through reload', async () => {
 const f = fixture(), opened: string[] = [], activities: ContactActivity[] = [{ id: 'activity:note', revision: 2, updatedAt: at, deviceId: 'fixture-device', contactId: f.people[0].id, value: { kind: 'note', at, text: 'Original note', archived: false } }, { id: 'activity:archived', revision: 1, updatedAt: at, deviceId: 'fixture-device', contactId: f.people[0].id, value: { kind: 'call', at, text: 'Archived call', archived: true } }];
 const items = [{ id: 'email:original', at, type: 'email', title: 'Original email', open() { opened.push('email:original'); } }, { id: 'task:original', at, type: 'task', title: 'Original task', open() { opened.push('task:original'); } }];
 const app = host(ContactTimeline, { contact: f.people[0], snapshot: f.snapshot, activities, items, refresh: async () => {} });
 const rows = () => nodes(app.tree).find(node => node.props.className === 'crm-timeline');
 try {
  await app.flush(); button(app.tree, 'Tasks').props.onClick(); await app.flush(); assert.equal(rows().props.children.length, 1); rows().props.children[0].props.onClick(); assert.deepEqual(opened, ['task:original']);
  await app.mount(); assert.equal(button(app.tree, 'Tasks').props['aria-pressed'], true); assert.equal(rows().props.children.length, 1);
  button(app.tree, 'Archived entries').props.onClick(); await app.flush(); assert.equal(rows().props.children.length, 0);
  button(app.tree, 'Notes & Calls').props.onClick(); await app.flush(); assert.equal(rows().props.children.length, 1); rows().props.children[0].props.onClick(); await app.flush();
  let editor = nodes(app.tree).find(node => node.type?.name === 'ActivityEditor'); assert.equal(editor.props.entry, activities[1]); await app.mount(); editor = nodes(app.tree).find(node => node.type?.name === 'ActivityEditor'); assert.equal(editor.props.entry, activities[1]); assert.deepEqual(app.calls, []);
 } finally { app.close(); }
});

test('a retained pending follow-up is reconciled with its exact source revision and request, never recreated by the preview', async () => {
 const f = fixture(), command = { requestId: 'original-follow-up', epoch: f.snapshot.epoch, origin: { kind: 'contact', id: f.people[0].id, revision: 2 }, title: 'Unconfirmed original follow-up' }, key = `e3:record-follow-up:fixture-device:${f.people[0].id}:${retainedWindowId}`;
 const app = host(RecordConnections, { compact: true, timeline: true, contactIds: contactFamily(f.people[0].id, f.people), kind: 'contact', entity: f.people[0], ...f.props }, () => { throw new Error('Synthetic uncertain response'); }); app.storage.set(key, JSON.stringify(command));
 try {
  await app.flush(); const form = nodes(app.tree).find(node => node.type === 'form'); assert.ok(form); form.props.onSubmit({ preventDefault() {} }); await app.flush();
  assert.deepEqual(app.calls.map(call => call.body), [command]); assert.deepEqual(JSON.parse(app.storage.get(key)!), command); assert.deepEqual(f.opened, []);
  await app.mount(); assert.deepEqual(JSON.parse(app.storage.get(key)!), command);
 } finally { app.close(); }
});

test('deadline state uses the Task timezone and deadline time without changing its planned date', () => {
 const value = task('task:timezone', { planned: '2026-10-21', due: '2026-10-19', dueTime: '18:00', timezone: 'America/Los_Angeles' }).value;
 assert.equal(contactDeadlineOverdue(value, 'Asia/Tokyo', Date.parse('2026-10-20T00:59:00Z')), false);
 assert.equal(contactDeadlineOverdue(value, 'Asia/Tokyo', Date.parse('2026-10-20T01:01:00Z')), true);
 assert.equal(contactDeadlineOverdue({ ...value, dueTime: '' }, 'Asia/Tokyo', Date.parse('2026-10-20T01:01:00Z')), false);
 assert.equal(contactDeadlineOverdue({ ...value, status: 'done' }, 'Asia/Tokyo', Date.parse('2026-10-20T08:00:00Z')), false);
 assert.equal(value.planned, '2026-10-21');
});

test('returning to a pending activity keeps its original text, timestamp, revision and save envelope', async () => {
 const f = fixture(), key = `e3:crm-activity:fixture-device:${f.people[0].id}:new:${retainedWindowId}`, value = { kind: 'message', at, text: 'Keep this unsent activity writing', archived: false }, command = { requestId: 'original-activity', epoch: f.snapshot.epoch, id: 'activity:pending', expectedRevision: 0, value, contactId: f.people[0].id };
 const app = host(ContactTimeline, { contact: f.people[0], snapshot: f.snapshot, activities: [], items: [], refresh: async () => {} }, () => { throw new Error('Synthetic uncertain activity save'); });
 app.storage.set(key, JSON.stringify({ value, revision: 0, pending: command }));
 try {
  await app.flush(); button(app.tree, 'Log activity').props.onClick(); await app.flush();
  const editor = nodes(app.tree).find(node => node.type?.name === 'ActivityEditor'); await app.mount(editor.type, { ...editor.props, saved: async () => {}, close() {} });
  assert.equal(nodes(app.tree).find(node => node.type === 'textarea').props.value, value.text); app.tree.props.onSubmit({ preventDefault() {} }); await app.flush();
  assert.deepEqual(app.calls.map(call => call.body), [command]); assert.deepEqual(JSON.parse(app.storage.get(key)!), { value, revision: 0, pending: command }); await app.mount(); assert.equal(nodes(app.tree).find(node => node.type === 'textarea').props.value, value.text);
 } finally { app.close(); }
});
