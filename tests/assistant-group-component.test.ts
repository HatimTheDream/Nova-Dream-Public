import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import { changeGroup, groupReceipt, type GroupBundle, type GroupCommand } from '../packages/domain/assistant-groups';
import { GroupReader } from '../apps/client/src/assistant-group-reader';

const key = Symbol.for('nova.test.group-ui');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/')) return { url: 'nova-test:group-hooks', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:group-hooks') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.group-ui')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v);
      export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { GroupEditor } = await import('../apps/client/src/AssistantGroup');
const { useAssistantGroups } = await import('../apps/client/src/useAssistantGroups');
const { mayLeaveRecordDrafts } = await import('../apps/client/src/record-draft-navigation');
loader.deregister();
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const field = (tree: any, label: string) => {
  const item = nodes(tree).find(node => node.type === 'label' && text(node).startsWith(label));
  return nodes(item).find(node => ['input', 'select'].includes(node.type));
};
function fixture() {
  const scope = { epoch: randomUUID(), deviceId: randomUUID(), windowId: randomUUID(), groupId: randomUUID() };
  const snapshot = { ...scope, cursor: 0, tasks: [], drafts: [], projects: [],
    records: { agent: [
      { id: 'agent:planner', revision: 1, value: { name: 'Planner', position: 'Planning', appearance: null, archived: false } },
      { id: 'agent:reviewer', revision: 1, value: { name: 'Reviewer', position: 'Review', appearance: null, archived: false } },
    ] },
    layout: { id: 'layout', revision: 1, updatedAt: '', deviceId: scope.deviceId, value: structuredClone(defaultLayout) },
    capabilities: { assistant: false, voice: false, reason: 'Synthetic client' } } as unknown as Snapshot;
  const bundle: GroupBundle = { group: null, members: [], events: [] }, storage = new Map<string, string>();
  const detail = () => ({ epoch: scope.epoch, view: 'group' as const, group: bundle.group!,
    members: bundle.members.filter(member => bundle.group!.activeMembershipIds.includes(member.id)), historicalMembershipCount: bundle.members.length });
  const admit = (command: GroupCommand) => {
    const eventId = randomUUID(), at = '2026-10-20T12:00:00.000Z';
    const originalRemoval = command.action === 'undo-removal' ? bundle.events.find(event => event.id === command.removalEventId) : undefined;
    const removedMember = originalRemoval && bundle.members.find(member => member.id === originalRemoval.removedMembershipIds[0]);
    const selected = command.action === 'create' || command.action === 'add-members' ? command.members
      : command.action === 'undo-removal' && removedMember ? [{ agentId: removedMember.agentId, agentRevision: command.agentRevision }] : [];
    const addedMembers = selected.map(selected => ({ format: 1 as const, id: randomUUID(), groupId: scope.groupId,
      agentId: selected.agentId, agentRevision: selected.agentRevision, name: selected.agentId === 'agent:planner' ? 'Planner' : 'Reviewer', appearance: null,
      joinedBy: { requestId: command.requestId, epoch: scope.epoch, deviceId: scope.deviceId }, joinedAt: at, joinEventId: eventId,
      joinedRevision: (bundle.group?.revision ?? 0) + 1, history: { kind: 'none-before-membership' as const, joinEventId: eventId }, restoresMembershipId: removedMember?.id ?? null }));
    const event = changeGroup(bundle, command, { eventId, at, deviceId: scope.deviceId, addedMembers, actor: { profileId: 'profile:owner', revision: 0, name: 'You' } });
    bundle.group = event.after; bundle.events.push(event); bundle.members.push(...addedMembers); return groupReceipt(event);
  };
  return { scope, snapshot, bundle, storage, detail, admit };
}
function host(f: ReturnType<typeof fixture>, respond: (command: GroupCommand) => unknown | Promise<unknown> = f.admit,
  view?: () => unknown, read?: (url: string) => unknown | Promise<unknown>) {
  let cursor = 0, dirty = true, tree: any, back = 0;
  const cells: any[] = [], effects: (() => void)[] = [], calls: { url: string; method: string; command?: GroupCommand }[] = [];
  const reader = new GroupReader(f.scope.epoch, f.scope.groupId, () => true);
  if (f.bundle.group) reader.detail = f.detail();
  const faults = { read: false, write: false, clearedReadback: false }; let failNextRead = false;
  const values: Record<PropertyKey, unknown> = {
    [key]: {
      state(value: any) { const i = cursor++; if (!cells[i]) cells[i] = { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; dirty = true; }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
    },
    localStorage: { getItem: (k: string) => { if (failNextRead) { failNextRead = false; throw Error('Synthetic cleared-pointer readback failure'); } if (faults.read) throw Error('Synthetic denied read'); return f.storage.get(k) ?? null; }, setItem: (k: string, v: string) => { if (faults.write) throw Error('Synthetic denied write'); f.storage.set(k, v);
      if (faults.clearedReadback && k === `e3:group-editor:${f.scope.deviceId}:${f.scope.epoch}:${f.scope.windowId}:${f.scope.groupId}` && !JSON.parse(v).pending) { faults.clearedReadback = false; failNextRead = true; } } },
    requestAnimationFrame: (fn: Function) => { fn(); return 1; },
    fetch: async (url: string, init: RequestInit) => {
      const command = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, method: init.method!, command });
      if (command) { const result = await respond(command); return result instanceof Response ? result : new Response(JSON.stringify(result)); }
      if (read) return new Response(JSON.stringify(await read(url)));
      const query = new URL(url, 'http://fixture').searchParams;
      if (query.get('view') === 'history') return new Response(JSON.stringify({ epoch: f.scope.epoch, view: 'history',
        groupId: f.scope.groupId, revision: f.bundle.group!.revision, total: f.bundle.group!.revision,
        events: f.bundle.events.slice(Number(query.get('after'))), next: null }));
      assert.equal(query.get('view'), 'request');
      const original = f.bundle.events.find(event => event.command.requestId === query.get('requestId'));
      assert.ok(original);
      return new Response(JSON.stringify({ epoch: f.scope.epoch, view: 'request', receipt: groupReceipt(original) }));
    },
  };
  const originals = Reflect.ownKeys(values).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  for (const k of Reflect.ownKeys(values)) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: values[k] });
  const props = { snapshot: f.snapshot, scope: f.scope, windowId: f.scope.windowId, target: { kind: 'create' as const, groupId: f.scope.groupId },
    reader, update: () => { dirty = true; }, load: async () => { if (f.bundle.group) reader.detail = f.detail(); dirty = true; return !!f.bundle.group; },
    changed() {}, refreshWorkspace: async () => {}, panelChanged() {}, closePanelRequest: 0,
    back: () => { back++; }, sidebarControls: null, navigationCovered: false };
  return { calls, faults, reader, get tree() { return tree; }, get backs() { return back; }, force() { dirty = true; },
    setRefresh(refresh: () => Promise<void>) { props.refreshWorkspace = refresh; dirty = true; },
    async flush() { for (let pass = 0; pass < 20; pass++) { if (dirty) { dirty = false; cursor = 0; tree = view ? view() : GroupEditor(props); while (effects.length) effects.shift()!(); } for (let tick = 0; tick < 10; tick++) await Promise.resolve(); } },
    close() { for (const cell of cells) cell?.cleanup?.(); for (const [k, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, k, descriptor); else Reflect.deleteProperty(globalThis, k); },
  };
}
const write = async (app: ReturnType<typeof host>, value: string) => { field(app.tree, 'Group Name').props.onChange({ target: { value } }); await app.flush(); };

test('rendered Group create requires explicit responder and sends one exact metadata command', async () => {
  const f = fixture(), app = host(f);
  try {
    await app.flush(); await write(app, 'Planning Circle');
    field(app.tree, 'Planner').props.onChange({ target: { checked: true } }); await app.flush();
    assert.equal(button(app.tree, 'Create Group').props.disabled, true);
    field(app.tree, 'Default Responder').props.onChange({ target: { value: 'agent:planner' } }); await app.flush();
    assert.equal(button(app.tree, 'Create Group').props.disabled, false); assert.equal(app.calls.length, 0);
    button(app.tree, 'Create Group').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(app.calls[0].method, 'POST');
    assert.equal(app.calls[0].command?.action, 'create'); assert.equal((app.calls[0].command as any).shareEarlierHistory, false);
    assert.equal(f.bundle.group?.title, 'Planning Circle'); assert.match(text(app.tree), /Messaging is unavailable/);
    assert.equal(button(app.tree, 'Add Selected Members').props.disabled, true);
  } finally { app.close(); }
});

test('late create acknowledgment preserves newer name and failed storage prevents navigation or POST', async () => {
  const f = fixture(); let complete!: (value: unknown) => void;
  const app = host(f, command => { const reply = f.admit(command); return new Promise(resolve => { complete = () => resolve(reply); }); });
  try {
    await app.flush(); await write(app, 'Original Name');
    button(app.tree, 'Create Group').props.onClick(); await app.flush();
    await write(app, 'Newer Unfinished Name'); complete(undefined); await app.flush();
    assert.equal(field(app.tree, 'Group Name').props.value, 'Newer Unfinished Name');
    assert.equal(f.bundle.group?.title, 'Original Name');
    app.faults.write = true; await write(app, 'Only In This Window');
    assert.equal(mayLeaveRecordDrafts(), false);
    button(app.tree, 'Back To Chat').props.onClick(); assert.equal(app.backs, 0);
    button(app.tree, 'Save Name').props.onClick(); await app.flush(); assert.equal(app.calls.length, 1);
    app.faults.write = false; button(app.tree, 'Retry Keeping Writing').props.onClick(); await app.flush();
    assert.equal(mayLeaveRecordDrafts(), true);
  } finally { app.close(); }
});

test('lost create reply reload offers only original status, preserves writing and never posts again', async () => {
  const f = fixture(), first = host(f, command => { f.admit(command); throw Error('Synthetic lost reply'); });
  try {
    await first.flush(); await write(first, 'Original Saved Group');
    button(first.tree, 'Create Group').props.onClick(); await first.flush();
    await write(first, 'Newer Kept Name');
    assert.ok(button(first.tree, 'Check Original Change')); assert.equal(first.calls.length, 1);
  } finally { first.close(); }
  const resumed = host(f, () => { throw Error('Must never repost'); });
  try {
    await resumed.flush(); assert.equal(resumed.calls.length, 0);
    button(resumed.tree, 'Members · 0').props.onClick(); await resumed.flush();
    assert.equal(field(resumed.tree, 'Group Name').props.value, 'Newer Kept Name');
    button(resumed.tree, 'Check Original Change').props.onClick(); await resumed.flush();
    assert.deepEqual(resumed.calls.map(call => call.method), ['GET']);
    assert.equal(field(resumed.tree, 'Group Name').props.value, 'Newer Kept Name');
    assert.equal(f.bundle.events.length, 1);
  } finally { resumed.close(); }
});

test('unreadable original journal is untouched and permits Back without enabling a new command', async () => {
  const f = fixture(), key = `e3:group-editor:${f.scope.deviceId}:${f.scope.epoch}:${f.scope.windowId}:${f.scope.groupId}`;
  f.storage.set(key, 'original malformed {');
  const app = host(f);
  try {
    await app.flush(); assert.equal(button(app.tree, 'Create Group').props.disabled, true);
    assert.equal(field(app.tree, 'Group Name').props.disabled, true);
    assert.equal(mayLeaveRecordDrafts(), true); button(app.tree, 'Back To Chat').props.onClick();
    assert.equal(app.backs, 1); assert.equal(f.storage.get(key), 'original malformed {'); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('removing the default needs an explicit replacement and Undo preserves a newer default choice', async () => {
  const f = fixture();
  f.admit({ epoch: f.scope.epoch, groupId: f.scope.groupId, requestId: randomUUID(), expectedRevision: 0,
    action: 'create', title: 'Planning Circle', projectId: null, members: [
      { agentId: 'agent:planner', agentRevision: 1 }, { agentId: 'agent:reviewer', agentRevision: 1 }],
    defaultAgentId: 'agent:planner', shareEarlierHistory: false });
  const originalPlanner = f.bundle.members[0].id, reviewer = f.bundle.members[1].id;
  const app = host(f);
  const memberRow = (name: string) => nodes(app.tree).find(node => node.type === 'li' && text(node).startsWith(name));
  try {
    await app.flush(); button(app.tree, 'Members · 2').props.onClick(); await app.flush();
    assert.equal(button(memberRow('Planner'), 'Remove').props.disabled, true);
    nodes(app.tree).find(node => node.type === 'select' && node.props['aria-label'] === 'Replacement For Planner')
      .props.onChange({ target: { value: 'agent:reviewer' } }); await app.flush();
    button(memberRow('Planner'), 'Remove').props.onClick(); await app.flush();
    assert.equal(f.bundle.group?.defaultMemberId, reviewer);
    const removal = f.bundle.events.at(-1)!; assert.deepEqual(removal.removedMembershipIds, [originalPlanner]);
    // A distinct explicit choice creates a newer default revision even for the same responder.
    f.admit({ action: 'choose-default', epoch: f.scope.epoch, groupId: f.scope.groupId, requestId: randomUUID(),
      expectedRevision: f.bundle.group!.revision, membershipId: reviewer });
    app.reader.detail = f.detail();
    button(app.tree, 'Group History').props.onClick(); await app.flush();
    button(app.tree, 'Undo Removal').props.onClick(); await app.flush();
    assert.equal(f.bundle.group?.defaultMemberId, reviewer);
    const restored = f.bundle.members.at(-1)!;
    assert.notEqual(restored.id, originalPlanner); assert.equal(restored.restoresMembershipId, originalPlanner);
    assert.equal(f.bundle.events.at(-1)!.restoredDefault, false);
    assert.deepEqual(app.calls.filter(call => call.method === 'POST').map(call => call.command?.action), ['remove-member', 'undo-removal']);
  } finally { app.close(); }
});

test('actual Group navigation hook protects saved view and rejects callbacks from an earlier conversation', async () => {
  const f = fixture(); let origin = 'draft:original', mayLeave = true;
  const app = host(f, f.admit, () => useAssistantGroups(f.snapshot, origin, () => mayLeave),
    () => ({ epoch: f.snapshot.epoch, view: 'groups', groups: [], next: null }));
  try {
    await app.flush(); const target = { kind: 'create' as const, groupId: randomUUID() };
    app.faults.write = true; assert.equal(app.tree.select(target), false); await app.flush();
    assert.equal(app.tree.selection, null);
    app.faults.write = false; assert.equal(app.tree.select(target), true); await app.flush();
    assert.deepEqual(app.tree.selection, target);
    mayLeave = false; assert.equal(app.tree.select(null), false); await app.flush();
    assert.deepEqual(app.tree.selection, target);
    const stale = app.tree.select; origin = 'draft:other'; app.force(); await app.flush();
    assert.equal(app.tree.selection, null); mayLeave = true;
    assert.equal(stale(null), false);
    origin = 'draft:original'; app.force(); await app.flush(); assert.deepEqual(app.tree.selection, target);
    assert.ok(app.calls.every(call => call.method === 'GET'));
  } finally { app.close(); }
});

test('actual Group list hook isolates a new epoch while its original request is pending', async () => {
  const f = fixture(), replies: ((value: unknown) => void)[] = [];
  const oldEpoch = f.snapshot.epoch;
  const app = host(f, f.admit, () => useAssistantGroups(f.snapshot, 'draft:original', () => true),
    () => new Promise(resolve => replies.push(resolve)));
  try {
    await app.flush(); assert.equal(replies.length, 1);
    const staleRefresh = app.tree.refresh;
    f.snapshot = { ...f.snapshot, epoch: randomUUID() }; app.force(); await app.flush();
    assert.equal(replies.length, 2); assert.equal(app.tree.list.busy, true);
    replies[0]({ epoch: oldEpoch, view: 'groups', groups: [], next: null }); await app.flush();
    assert.equal(app.tree.list.busy, true);
    replies[1]({ epoch: f.snapshot.epoch, view: 'groups', groups: [], next: null }); await app.flush();
    assert.equal(app.tree.list.busy, false); await staleRefresh(); assert.equal(replies.length, 2);
    void app.tree.refresh(); void app.tree.refresh(); await app.flush(); assert.equal(replies.length, 3);
    replies[2]({ epoch: f.snapshot.epoch, view: 'groups', groups: [], next: null }); await app.flush();
  } finally { app.close(); }
});

test('confirmed stale save keeps newer writing and requires review before a separate corrected command', async () => {
  const f = fixture();
  f.admit({ action: 'create', epoch: f.scope.epoch, groupId: f.scope.groupId, requestId: randomUUID(),
    expectedRevision: 0, title: 'Original Group', projectId: null, members: [], defaultAgentId: null, shareEarlierHistory: false });
  let first = true;
  const app = host(f, command => {
    if (first) {
      first = false;
      return new Response(JSON.stringify({ code: 'group_revision_changed', message: 'Group changed before this save.' }), { status: 409 });
    }
    return f.admit(command);
  });
  try {
    await app.flush(); button(app.tree, 'Members · 0').props.onClick(); await app.flush();
    f.admit({ action: 'rename', epoch: f.scope.epoch, groupId: f.scope.groupId, requestId: randomUUID(),
      expectedRevision: 1, title: 'Saved Elsewhere' });
    await write(app, 'My Original Request');
    button(app.tree, 'Save Name').props.onClick(); await app.flush();
    assert.ok(button(app.tree, 'Keep Writing And Review Current Group'));
    await write(app, 'My Newer Writing'); assert.equal(button(app.tree, 'Save Name').props.disabled, true);
    app.setRefresh(async () => { throw Error('Synthetic refresh failure'); }); await app.flush();
    button(app.tree, 'Keep Writing And Review Current Group').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 1); assert.ok(button(app.tree, 'Keep Writing And Review Current Group'));
    app.setRefresh(async () => {}); await app.flush();
    button(app.tree, 'Keep Writing And Review Current Group').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 1); assert.equal(field(app.tree, 'Group Name').props.value, 'My Newer Writing');
    assert.equal(button(app.tree, 'Save Name').props.disabled, false);
    assert.ok([...f.storage.keys()].some(key => key.endsWith(`:rejected:${app.calls[0].command!.requestId}`)));
    button(app.tree, 'Save Name').props.onClick(); await app.flush();
    assert.equal(app.calls.length, 2); assert.notEqual(app.calls[0].command!.requestId, app.calls[1].command!.requestId);
    assert.equal(app.calls[1].command!.expectedRevision, 2);
    assert.equal(f.bundle.group?.title, 'My Newer Writing');
  } finally { app.close(); }
});

test('denied global browser storage getter keeps the Group editor readable and Back available', async () => {
  const f = fixture(), app = host(f);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Browser storage getter denied'); } });
  try {
    await app.flush(); assert.match(text(app.tree), /Browser storage getter denied/);
    assert.equal(field(app.tree, 'Group Name').props.disabled, true);
    assert.equal(button(app.tree, 'Create Group').props.disabled, true);
    button(app.tree, 'Back To Chat').props.onClick();
    assert.equal(app.backs, 1); assert.equal(app.calls.length, 0); assert.equal(f.storage.size, 0);
  } finally { app.close(); }
});

test('rendered known-rejection recovery finishes a failed pointer readback without losing later writing', async () => {
  const f = fixture(), app = host(f, () => new Response(JSON.stringify({
    code: 'group_agent_changed', message: 'Agent changed before saving.' }), { status: 409 }));
  let refreshes = 0;
  try {
    app.setRefresh(async () => { refreshes++; });
    await app.flush(); await write(app, 'Original Writing');
    button(app.tree, 'Create Group').props.onClick(); await app.flush();
    app.faults.clearedReadback = true;
    button(app.tree, 'Keep Writing And Review Current Group').props.onClick(); await app.flush();
    assert.ok(button(app.tree, 'Keep Writing And Review Current Group')); assert.equal(refreshes, 1);
    await write(app, 'Typed After Failed Pointer Readback');
    button(app.tree, 'Keep Writing And Review Current Group').props.onClick(); await app.flush();
    assert.equal(refreshes, 1); assert.equal(app.calls.length, 1);
    assert.equal(field(app.tree, 'Group Name').props.value, 'Typed After Failed Pointer Readback');
    assert.equal(button(app.tree, 'Create Group').props.disabled, false);
    const raw = JSON.parse(f.storage.get(`e3:group-editor:${f.scope.deviceId}:${f.scope.epoch}:${f.scope.windowId}:${f.scope.groupId}`)!);
    assert.equal(raw.draft.title, 'Typed After Failed Pointer Readback'); assert.equal(raw.pending, undefined);
  } finally { app.close(); }
});
