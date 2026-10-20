import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultLayout, type Entity, type Snapshot } from '../packages/domain/contracts';
import { blankRecord, type Contact } from '../packages/domain/workspace-records';
import type { ContactActivity, CrmState, OrganizationRecord } from '../packages/domain/crm';
import type { CrmCommand, CrmJournal } from '../apps/client/src/crm-draft-client';
import { crmRecoveryKey, type CrmRecoveryScope } from '../apps/client/src/crm-draft-recovery';

const key = Symbol.for('nova.test.crm-draft-ui');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (/\/apps\/client\/src\/(?:ContactCrm|useCrmDraft|useContactView|CrmDraftRecovery|RecordDraftRecovery)\./.test(context.parentURL ?? '')) {
      if (specifier === 'react') return { url: 'nova-crm-test:react', shortCircuit: true };
      if (specifier === './api') return { url: 'nova-crm-test:api', shortCircuit: true };
      if (specifier === './useWorkspace') return { url: 'nova-crm-test:window', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const current = `const f=()=>globalThis[Symbol.for('nova.test.crm-draft-ui')];`;
    if (url === 'nova-crm-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${current}export const useState=v=>f().state(v),useRef=v=>f().ref(v),useEffect=(fn,deps)=>f().effect(fn,deps);` };
    if (url === 'nova-crm-test:api') return { format: 'module', shortCircuit: true, source: `${current}export const request=(p,d)=>f().request(p,d),readLocal=k=>f().read(k),saveLocal=(k,v)=>f().save(k,v);` };
    if (url === 'nova-crm-test:window') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='crm-test-window';` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { ActivityEditor, OrganizationEditor, ContactTimeline, OrganizationDirectory } = await import('../apps/client/src/ContactCrm');
const { CrmDraftStatus } = await import('../apps/client/src/CrmDraftStatus');
const { CrmDraftRecovery } = await import('../apps/client/src/CrmDraftRecovery');
const { RecordDraftRecovery } = await import('../apps/client/src/RecordDraftRecovery');
const { mayLeaveRecordDrafts } = await import('../apps/client/src/record-draft-navigation');
const instances = new Set<Hooks>();
class Hooks {
  groups = new Map<string, any[]>(); slots: any[] = []; index = 0; effects: (() => void)[] = [];
  storage = new Map<string, string>(); failStorage = false; failStorageGetter = false; writes = 0;
  crm: CrmState = { organizations: [], activities: [], relationships: [] };
  reads: { path: string; input: unknown }[] = [];
  posts: { path: string; input: any; resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
  deferRead = false; pendingRead: { resolve: (value: unknown) => void; reject: (reason: Error) => void }[] = [];
  state(initial: any) {
    const i = this.index++, slots = this.slots;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
  }
  ref(value: unknown) { return this.slots[this.index++] ??= { current: value }; }
  effect(fn: () => (() => void) | void, deps: unknown[]) {
    const i = this.index++, slots = this.slots, old = slots[i];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps[n])))
      this.effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
  }
  read(name: string) { try { return JSON.parse(this.storage.get(name) ?? 'null'); } catch { return undefined; } }
  write(name: string, raw: string) { if (this.failStorage) throw Error('Synthetic storage full'); this.writes++; this.storage.set(name, raw); }
  save(name: string, value: unknown) { try { this.write(name, JSON.stringify(value)); return true; } catch { return false; } }
  request(path: string, input: unknown) {
    if (path === 'contacts/crm') {
      this.reads.push({ path, input });
      return this.deferRead ? new Promise((resolve, reject) => this.pendingRead.push({ resolve, reject })) : Promise.resolve(this.crm);
    }
    assert(['contacts/activity', 'contacts/organization'].includes(path), 'Only the existing CRM save routes are permitted');
    return new Promise((resolve, reject) => this.posts.push({ path, input: structuredClone(input), resolve, reject }));
  }
  render<T>(fn: () => T, name = 'root'): T {
    instances.add(this); (globalThis as any)[key] = this;
    this.slots = this.groups.get(name) ?? []; this.groups.set(name, this.slots); this.index = 0; this.effects = [];
    const tree = fn(); for (const effect of this.effects) effect(); return tree;
  }
  unmount(name = 'root') { for (const slot of this.groups.get(name) ?? []) slot?.cleanup?.(); this.groups.delete(name); }
  dispose() { for (const name of [...this.groups.keys()]) this.unmount(name); instances.delete(this); }
}
const active = () => (globalThis as any)[key] as Hooks;
const globals: Record<string, unknown> = {
  window: { addEventListener() {}, removeEventListener() {} },
  document: { hidden: true },
  requestAnimationFrame: () => 1,
  setInterval: () => 1,
  clearInterval: () => {},
};
const originals = [...Object.keys(globals), 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => {
  if (active().failStorageGetter) throw Error('Synthetic browser storage denied');
  return {
    get length() { return active().storage.size; },
    key: (index: number) => [...active().storage.keys()][index] ?? null,
    getItem: (name: string) => active().storage.get(name) ?? null,
    setItem: (name: string, raw: string) => active().write(name, raw),
  };
} });
test.afterEach(() => { for (const f of [...instances]) f.dispose(); });
test.after(() => {
  loader.deregister(); delete (globalThis as any)[key];
  for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
});
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
function button(tree: any, label: string) {
  const found = nodes(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  assert(found, `Missing button: ${label}`); return found;
}
function field(tree: any, name: string) {
  const found = nodes(tree).find(node => node.props['aria-label'] === name || node.props.id === name || node.props.type === name);
  assert(found, `Missing field: ${name}`); return found;
}
function status(tree: any) {
  const item = nodes(tree).find(node => node.type === CrmDraftStatus); assert(item);
  return CrmDraftStatus(item.props);
}
function selectFirst(tree: any) {
  const item = nodes(tree).find(node => node.type === 'button' && node.props.className === 'card record-list-item'); assert(item);
  item.props.onClick();
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const hooks = new Hooks(), epoch = randomUUID(), deviceId = randomUUID(), at = '2026-10-20T08:00:00.000Z';
  const contact: Entity<Contact> = { id: 'contact:original', revision: 2, deviceId, updatedAt: at,
    value: { ...blankRecord('contact', 'UTC'), name: 'Original Person' } as Contact };
  const activity: ContactActivity = { id: 'activity:original', revision: 2, deviceId, updatedAt: at, contactId: contact.id,
    value: { kind: 'note', at, text: 'Saved activity writing', archived: false } };
  const organization: OrganizationRecord = { id: 'organization:original', revision: 2, deviceId, updatedAt: at, memberIds: [contact.id],
    value: { name: 'Original Studio', website: '', phone: '', industry: '', notes: 'Saved organization notes' } };
  const snapshot: Snapshot = { epoch, deviceId, cursor: 0, tasks: [], projects: [], drafts: [],
    layout: { id: 'layout', revision: 1, deviceId, updatedAt: at, value: structuredClone(defaultLayout) },
    capabilities: { assistant: false, voice: false, reason: 'Synthetic' } };
  hooks.crm = { activities: [activity], organizations: [organization], relationships: [] };
  const activityKey = `e3:crm-activity:${deviceId}:${activity.id}:crm-test-window`;
  const orgKey = `e3:crm-org:${deviceId}:${organization.id}:crm-test-window`;
  const journal = (kind: 'activity' | 'organization'): CrmJournal => ({ format: 1, kind, epoch, dirty: true, revision: 2,
    ...(kind === 'activity' ? { id: activity.id, contactId: contact.id, value: { ...activity.value, text: 'Kept activity edits' } } :
      { id: organization.id, value: { ...organization.value, notes: 'Kept organization edits' } }) });
  return { hooks, snapshot, contact, activity, organization, activityKey, orgKey, journal };
}
function reply(f: ReturnType<typeof fixture>, index = 0) {
  const call = f.hooks.posts[index], command = call.input;
  call.resolve({ ...(call.path === 'contacts/activity' ? f.activity : f.organization), id: command.id, revision: command.expectedRevision + 1, value: command.value });
}
const event = { preventDefault() {} };

test('actual Activity editor keeps failed typing and refuses Close and navigation until retained', () => {
  const f = fixture(); let closed = 0;
  const render = () => f.hooks.render(() => ActivityEditor({ contact: f.contact, snapshot: f.snapshot, entry: f.activity, saved: async () => {}, close: () => closed++ }));
  let tree = render(); f.hooks.failStorage = true;
  field(tree, 'crm-activity-text').props.onChange({ target: { value: 'Keep every unsaved activity word' } }); tree = render();
  assert.equal(field(tree, 'crm-activity-text').props.value, 'Keep every unsaved activity word');
  button(tree, 'Close · Writing Kept').props.onClick(); assert.equal(closed, 0); assert.equal(mayLeaveRecordDrafts(), false);
  assert.equal(f.hooks.posts.length, 0); assert.match(text(status(tree)), /remain open/);
  f.hooks.failStorage = false; button(tree, 'Close · Writing Kept').props.onClick(); assert.equal(closed, 1);
  assert.equal(JSON.parse(f.hooks.storage.get(f.activityKey)!).value.text, 'Keep every unsaved activity word'); assert.equal(mayLeaveRecordDrafts(), true);
});

test('actual Organization editor retains incomplete URL and notes without saving or leaving on storage refusal', () => {
  const f = fixture(); let closed = 0;
  const render = () => f.hooks.render(() => OrganizationEditor({ organization: f.organization, snapshot: f.snapshot, saved: async () => {}, close: () => closed++ }));
  let tree = render(); f.hooks.failStorage = true;
  field(tree, 'Website').props.onChange({ target: { value: 'https://' } }); tree = render();
  field(tree, 'Organization notes').props.onChange({ target: { value: 'Keep unfinished organization writing' } }); tree = render();
  tree.props.onSubmit(event); tree = render(); assert.equal(f.hooks.posts.length, 0);
  button(tree, 'Close · Writing Kept').props.onClick(); assert.equal(closed, 0); assert.equal(mayLeaveRecordDrafts(), false);
  assert.equal(field(tree, 'Website').props.value, 'https://'); assert.equal(field(tree, 'Organization notes').props.value, 'Keep unfinished organization writing');
  f.hooks.failStorage = false; button(status(tree), 'Retry Keeping Writing').props.onClick();
  assert.equal(JSON.parse(f.hooks.storage.get(f.orgKey)!).value.website, 'https://');
  button(tree, 'Close · Writing Kept').props.onClick(); assert.equal(closed, 1); assert.equal(f.hooks.posts.length, 0);
});

test('actual invalid datetime remains visible and stored until explicitly corrected, with zero save', () => {
  const f = fixture();
  f.hooks.storage.set(f.activityKey, JSON.stringify({ ...f.journal('activity'), value: { ...f.activity.value, at: 'unfinished-date' } }));
  const render = () => f.hooks.render(() => ActivityEditor({ contact: f.contact, snapshot: f.snapshot, entry: f.activity, saved: async () => {}, close() {} }));
  let tree = render(); assert.match(text(tree), /unfinished-date/); assert.equal(field(tree, 'datetime-local').props.value, '');
  tree.props.onSubmit(event); assert.equal(f.hooks.posts.length, 0);
  field(tree, 'datetime-local').props.onChange({ target: { value: '' } }); tree = render();
  assert.equal(JSON.parse(f.hooks.storage.get(f.activityKey)!).value.at, ''); assert.equal(field(tree, 'datetime-local').props.value, '');
  tree.props.onSubmit(event); assert.equal(f.hooks.posts.length, 0);
});

test('actual submit acknowledgement refusal keeps one original command and Check Original Save never duplicates a known success', async () => {
  for (const kind of ['activity', 'organization'] as const) {
    const f = fixture(); let saved = 0;
    const render = () => f.hooks.render(() => kind === 'activity' ?
      ActivityEditor({ contact: f.contact, snapshot: f.snapshot, entry: f.activity, saved: async () => { saved++; }, close() {} }) :
      OrganizationEditor({ organization: f.organization, snapshot: f.snapshot, saved: async () => { saved++; }, close() {} }));
    let tree = render();
    field(tree, kind === 'activity' ? 'crm-activity-text' : 'Organization notes').props.onChange({ target: { value: 'Edited before original save' } }); tree = render();
    tree.props.onSubmit(event); assert.equal(f.hooks.posts.length, 1); const original = structuredClone(f.hooks.posts[0].input);
    f.hooks.failStorage = true; reply(f); await settle(); tree = render();
    assert.equal(saved, 0); assert.equal(button(tree, 'Check Original Save').props.disabled, false);
    const raw = f.hooks.storage.get(kind === 'activity' ? f.activityKey : f.orgKey)!; assert.deepEqual(JSON.parse(raw).pending, original);
    f.hooks.failStorage = false; tree.props.onSubmit(event); await settle(); render();
    assert.equal(saved, 1); assert.equal(f.hooks.posts.length, 1);
    assert.equal(JSON.parse(f.hooks.storage.get(kind === 'activity' ? f.activityKey : f.orgKey)!).pending, undefined);
    f.hooks.dispose();
  }
});

test('lost original response reopens the same pending command and explicit Check uses that identity', async () => {
  const f = fixture(); let saved = 0;
  const render = () => f.hooks.render(() => ActivityEditor({ contact: f.contact, snapshot: f.snapshot, entry: f.activity, saved: async () => { saved++; }, close() {} }));
  let tree = render(); field(tree, 'crm-activity-text').props.onChange({ target: { value: 'Original uncertain activity' } }); tree = render();
  tree.props.onSubmit(event); const command = structuredClone(f.hooks.posts[0].input);
  f.hooks.posts[0].reject(Error('Synthetic lost response')); await settle(); f.hooks.unmount(); tree = render();
  assert.equal(f.hooks.posts.length, 1); assert.equal(button(tree, 'Check Original Save').props.disabled, false);
  tree.props.onSubmit(event); assert.deepEqual(f.hooks.posts[1].input, command); reply(f, 1); await settle();
  assert.equal(saved, 1); assert.equal(f.hooks.posts.length, 2);
});

test('retired and changed-epoch hooks ignore late success and keep the original stored pending request', async () => {
  for (const retire of ['unmount', 'epoch'] as const) {
    const f = fixture(); let saved = 0, snapshot = f.snapshot;
    const render = () => f.hooks.render(() => OrganizationEditor({ organization: f.organization, snapshot, saved: async () => { saved++; }, close() {} }));
    let tree = render(); field(tree, 'Organization notes').props.onChange({ target: { value: 'Original pending notes' } }); tree = render();
    tree.props.onSubmit(event); const raw = f.hooks.storage.get(f.orgKey);
    if (retire === 'unmount') f.hooks.unmount(); else { snapshot = { ...snapshot, epoch: randomUUID() }; render(); }
    reply(f); await settle(); assert.equal(saved, 0); assert.equal(f.hooks.storage.get(f.orgKey), raw); assert.equal(f.hooks.posts.length, 1);
    f.hooks.dispose();
  }
});

test('legacy pending is read-only until the real status adoption callback preserves its original command', async () => {
  const f = fixture();
  const command: CrmCommand<'organization'> = { requestId: randomUUID(), epoch: f.snapshot.epoch, id: f.organization.id, expectedRevision: 2, value: f.organization.value };
  const raw = JSON.stringify({ value: f.organization.value, revision: 2, pending: command }, null, 2); f.hooks.storage.set(f.orgKey, raw);
  const render = () => f.hooks.render(() => OrganizationEditor({ organization: f.organization, snapshot: f.snapshot, saved: async () => {}, close() {} }));
  let tree = render(); assert.equal(field(tree, 'Organization notes').props.disabled, true);
  tree.props.onSubmit(event); assert.equal(f.hooks.posts.length, 0); assert.equal(f.hooks.storage.get(f.orgKey), raw);
  button(status(tree), 'Keep Original Save For This Workspace').props.onClick(); tree = render();
  const kept = JSON.parse(f.hooks.storage.get(f.orgKey)!); assert.equal(kept.legacyOriginal, raw); assert.deepEqual(kept.pending, command);
  assert.equal(f.hooks.posts.length, 0); tree.props.onSubmit(event); assert.deepEqual(f.hooks.posts[0].input, command);
  reply(f); await settle();
});

test('real saved-version review fetches current original record and rebases only after the explicit retained-writing choice', async () => {
  const f = fixture(); f.hooks.storage.set(f.activityKey, JSON.stringify(f.journal('activity')));
  const current = { ...f.activity, revision: 4, value: { ...f.activity.value, text: 'New saved host writing' } }; f.hooks.crm.activities = [current];
  const render = () => f.hooks.render(() => ActivityEditor({ contact: f.contact, snapshot: f.snapshot, entry: current, saved: async () => {}, close() {} }));
  let tree = render(); button(status(tree), 'Review Saved Version').props.onClick(); await settle(); tree = render();
  assert.equal(f.hooks.reads.length, 1); assert.deepEqual(f.hooks.reads[0].input, { epoch: f.snapshot.epoch, contactId: f.contact.id });
  assert.match(text(status(tree)), /New saved host writing/); assert.equal(JSON.parse(f.hooks.storage.get(f.activityKey)!).revision, 2);
  button(status(tree), 'Keep My Edits For This Version').props.onClick(); tree = render();
  const kept = JSON.parse(f.hooks.storage.get(f.activityKey)!); assert.equal(kept.revision, 4); assert.equal(kept.value.text, 'Kept activity edits');
  assert.equal(field(tree, 'crm-activity-text').props.value, 'Kept activity edits'); assert.equal(f.hooks.posts.length, 0);
});

test('late saved-version review after an epoch change cannot become an adoption callback', async () => {
  const f = fixture(); f.hooks.deferRead = true; f.hooks.storage.set(f.orgKey, JSON.stringify(f.journal('organization')));
  let snapshot = f.snapshot; const organization = { ...f.organization, revision: 4 };
  const render = () => f.hooks.render(() => OrganizationEditor({ organization, snapshot, saved: async () => {}, close() {} }));
  let tree = render(); button(status(tree), 'Review Saved Version').props.onClick();
  snapshot = { ...snapshot, epoch: randomUUID() }; render(); const raw = f.hooks.storage.get(f.orgKey);
  f.hooks.pendingRead[0].resolve({ ...f.hooks.crm, organizations: [organization] }); await settle(); tree = render();
  assert(!nodes(status(tree)).some(node => node.type === 'button' && text(node) === 'Keep My Edits For This Version'));
  assert.equal(f.hooks.storage.get(f.orgKey), raw); assert.equal(f.hooks.posts.length, 0);
});

test('Timeline original links and switching editor obey the actual mounted Activity retention guard', () => {
  const f = fixture(); let opened = 0;
  const editor = () => f.hooks.render(() => ActivityEditor({ contact: f.contact, snapshot: f.snapshot, entry: f.activity, saved: async () => {}, close() {} }), 'editor');
  const render = () => f.hooks.render(() => ContactTimeline({ contact: f.contact, snapshot: f.snapshot, activities: [f.activity],
    items: [{ id: 'task:original', at: f.activity.value.at, type: 'task', title: 'Open original follow-up', open: () => opened++ }], refresh: async () => {} }), 'parent');
  const edit = editor(); f.hooks.failStorage = true; field(edit, 'crm-activity-text').props.onChange({ target: { value: 'Must remain open' } });
  let tree = render(); const original = nodes(tree).find(node => node.type === 'button' && text(node).includes('Open original follow-up')); assert(original);
  original.props.onClick(); button(tree, 'Log activity').props.onClick(); tree = render();
  assert.equal(opened, 0); assert(!nodes(tree).some(node => node.type === ActivityEditor));
  f.hooks.failStorage = false; original.props.onClick(); assert.equal(opened, 1); button(tree, 'Log activity').props.onClick(); tree = render();
  assert(nodes(tree).some(node => node.type === ActivityEditor)); assert.equal(JSON.parse(f.hooks.storage.get(f.activityKey)!).value.text, 'Must remain open');
  assert.equal(f.hooks.posts.length, 0);
});

test('Organization directory selection and Back preserve the actual mounted Organization draft before navigation', async () => {
  const f = fixture(), second = { ...f.organization, id: 'organization:second', value: { ...f.organization.value, name: 'Second Studio' } };
  f.hooks.crm.organizations.push(second);
  const viewKey = `e3:contact-organizations:${f.snapshot.deviceId}:crm-test-window`;
  f.hooks.storage.set(viewKey, JSON.stringify({ query: '', selected: f.organization.id, creating: false, editing: true }));
  const editor = f.hooks.render(() => OrganizationEditor({ organization: f.organization, snapshot: f.snapshot, saved: async () => {}, close() {} }), 'editor');
  f.hooks.failStorage = true; field(editor, 'Organization notes').props.onChange({ target: { value: 'Keep before changing selection' } });
  const render = () => f.hooks.render(() => OrganizationDirectory({ snapshot: f.snapshot, refresh: async () => {}, open() {} }), 'parent');
  render(); await settle(); let tree = render();
  button(tree, 'Organizations').props.onClick(); tree = render();
  assert(nodes(tree).some(node => node.type === OrganizationEditor && node.props.organization.id === f.organization.id));
  const row = nodes(tree).find(node => node.type === 'button' && node.props.className === 'contact-row' && text(node).includes('Second Studio')); assert(row);
  row.props.onClick({ currentTarget: { isConnected: false } }); tree = render();
  assert(nodes(tree).some(node => node.type === OrganizationEditor && node.props.organization.id === f.organization.id));
  f.hooks.failStorage = false; row.props.onClick({ currentTarget: { isConnected: false } }); tree = render();
  assert(!nodes(tree).some(node => node.type === OrganizationEditor));
  assert.equal(JSON.parse(f.hooks.storage.get(viewKey)!).selected, second.id);
  assert.equal(JSON.parse(f.hooks.storage.get(f.orgKey)!).value.notes, 'Keep before changing selection'); assert.equal(f.hooks.posts.length, 0);
});

function recovery(f: ReturnType<typeof fixture>) {
  const scope: CrmRecoveryScope = { kind: 'organization', deviceId: f.snapshot.deviceId, epoch: f.snapshot.epoch, windowId: 'crm-test-window', records: [f.organization] };
  const sourceKey = crmRecoveryKey({ ...scope, windowId: 'other-window' }, f.organization.id), raw = JSON.stringify(f.journal('organization'), null, 2);
  f.hooks.storage.set(sourceKey, raw);
  return { scope, sourceKey, raw, targetKey: crmRecoveryKey(scope, f.organization.id) };
}

test('actual recovery preview is read-only and its exact copy exists before the original editor callback', () => {
  const f = fixture(), r = recovery(f); let opened = '', closed = 0;
  const render = () => f.hooks.render(() => CrmDraftRecovery({ scope: r.scope, canOpen: true,
    open: slot => { assert.equal(f.hooks.storage.get(r.targetKey), r.raw); opened = slot; return true; }, close: () => closed++ }));
  let tree = render(); selectFirst(tree); tree = render(); assert.match(text(tree), /Original Studio/);
  assert.equal(f.hooks.storage.has(r.targetKey), false); assert.equal(f.hooks.posts.length, 0);
  button(tree, 'Copy Into This Window').props.onClick(); tree = render();
  assert.equal(opened, f.organization.id); assert.equal(closed, 1); assert.equal(f.hooks.storage.get(r.sourceKey), r.raw); assert.equal(f.hooks.posts.length, 0);
});

test('recovery refuses a current editor or failed retention without copying and retains the original', () => {
  const f = fixture(), r = recovery(f); let opened = 0, canOpen = false;
  const render = () => f.hooks.render(() => CrmDraftRecovery({ scope: r.scope, canOpen, open: () => { opened++; return true; }, close() {} }));
  let tree = render(); selectFirst(tree); tree = render(); assert.equal(button(tree, 'Copy Into This Window').props.disabled, true);
  button(tree, 'Copy Into This Window').props.onClick(); assert.equal(opened, 0); assert.equal(f.hooks.storage.has(r.targetKey), false);
  const edit = f.hooks.render(() => ActivityEditor({ contact: f.contact, snapshot: f.snapshot, entry: f.activity, saved: async () => {}, close() {} }), 'editor');
  f.hooks.failStorage = true; field(edit, 'crm-activity-text').props.onChange({ target: { value: 'Unretained current writing' } });
  canOpen = true; tree = render(); button(tree, 'Copy Into This Window').props.onClick(); tree = render();
  assert.equal(opened, 0); assert.equal(f.hooks.storage.has(r.targetKey), false); assert.equal(f.hooks.storage.get(r.sourceKey), r.raw);
  assert.match(text(tree), /Close the current editor/); assert.equal(f.hooks.posts.length, 0);
});

test('failed recovery navigation retains confirmed copy and retries only opening that copy after source changes', () => {
  const f = fixture(), r = recovery(f); let opened = 0, closed = 0;
  const render = () => f.hooks.render(() => CrmDraftRecovery({ scope: r.scope, canOpen: true, open: () => ++opened > 1, close: () => closed++ }));
  let tree = render(); selectFirst(tree); tree = render(); button(tree, 'Copy Into This Window').props.onClick(); tree = render();
  assert.equal(opened, 1); assert.equal(closed, 0); const writes = f.hooks.writes;
  const newer = JSON.stringify({ ...f.journal('organization'), value: { ...f.organization.value, notes: 'Other window continued' } });
  f.hooks.storage.set(r.sourceKey, newer); button(tree, 'Open Kept Copy').props.onClick(); tree = render();
  assert.equal(opened, 2); assert.equal(closed, 1); assert.equal(f.hooks.writes, writes);
  assert.equal(f.hooks.storage.get(r.targetKey), r.raw); assert.equal(f.hooks.storage.get(r.sourceKey), newer); assert.equal(f.hooks.posts.length, 0);
});

test('recovery storage refusal reports an error without navigation, and browser getter denial stays readable', () => {
  const f = fixture(), r = recovery(f); let opened = 0;
  const render = () => f.hooks.render(() => CrmDraftRecovery({ scope: r.scope, canOpen: true, open: () => { opened++; return true; }, close() {} }));
  let tree = render(); selectFirst(tree); tree = render(); f.hooks.failStorage = true;
  button(tree, 'Copy Into This Window').props.onClick(); tree = render();
  assert.match(text(tree), /Synthetic storage full/); assert.equal(opened, 0); assert.equal(f.hooks.storage.get(r.sourceKey), r.raw);
  f.hooks.unmount(); f.hooks.failStorageGetter = true;
  tree = render(); assert.match(text(tree), /storage could not be read/i); assert.equal(f.hooks.posts.length, 0); assert.equal(opened, 0);
});

test('actual Contact and Content recovery dialogs handle a denied storage getter without effects', () => {
  for (const kind of ['contact', 'content'] as const) {
    const f = fixture(); f.hooks.failStorageGetter = true; let opened = 0;
    const scope = { kind, deviceId: f.snapshot.deviceId, windowId: 'crm-test-window', epoch: f.snapshot.epoch, records: [] };
    const render = () => f.hooks.render(() => RecordDraftRecovery({ scope, canOpen: true, open: () => { opened++; return true; }, close() {} }));
    let tree = render(); assert.match(text(tree), /storage could not be read/i);
    button(tree, 'Refresh List').props.onClick(); tree = render(); assert.match(text(tree), /storage could not be read/i);
    assert.equal(opened, 0); assert.equal(f.hooks.posts.length, 0); assert.equal(f.hooks.writes, 0); f.hooks.dispose();
  }
});
