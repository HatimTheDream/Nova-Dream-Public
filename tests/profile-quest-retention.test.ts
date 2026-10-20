import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultLayout, type Snapshot } from '../packages/domain/contracts';
import type { PersonalQuest } from '../packages/domain/profile-progression';
import { QuestEditor, type QuestJournal, type QuestSave } from '../apps/client/src/profile-quest-client';
import { mayLeaveRecordDrafts } from '../apps/client/src/record-draft-navigation';

const symbol = Symbol.for('nova.test.quest-retention');
const react = pathToFileURL(createRequire(import.meta.url).resolve('react')).href;
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (/\/ProfileQuestEditor\.tsx$/.test(context.parentURL ?? '')) {
      if (specifier === 'react') return { url: 'quest-test:react', shortCircuit: true };
      if (specifier === './api') return { url: 'quest-test:api', shortCircuit: true };
      if (specifier === './useWorkspace') return { url: 'quest-test:window', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    const f = `const f=()=>globalThis[Symbol.for('nova.test.quest-retention')];`;
    if (url === 'quest-test:react') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};${f}export const useState=v=>f().state(v),useRef=v=>f().ref(v),useEffect=(fn,deps)=>f().effect(fn,deps);` };
    if (url === 'quest-test:api') return { format: 'module', shortCircuit: true, source: `${f}export const request=(path,input)=>f().request(path,input);` };
    if (url === 'quest-test:window') return { format: 'module', shortCircuit: true, source: `export const retainedWindowId='original-window';` };
    return next(url, context);
  },
});
const { ProfileQuestEditor, questJournalKey } = await import('../apps/client/src/ProfileQuestEditor');
test.after(() => loader.deregister());

function fixture() {
  const epoch = randomUUID(), device = randomUUID(), id = randomUUID();
  const journal: QuestJournal = { draft: { id, title: '  Keep original title  ', description: 'Why 雪', projectId: null, due: '', steps: [{ id: randomUUID(), taskId: null, title: 'Original task' }, { id: randomUUID(), taskId: 'task:linked', title: 'Linked title' }] }, revision: 0, epoch, dirty: true };
  const values = new Map<string, string>(), calls: QuestSave[] = [];
  let failedRead = false, failedWrite = false, loseReadback = false;
  const storage = { getItem(key: string) { if (failedRead) throw Error('Read refused'); return values.get(key) ?? null; }, setItem(key: string, raw: string) { if (failedWrite) throw Error('Write refused'); values.set(key, raw); if (loseReadback) { loseReadback = false; failedRead = true; } } };
  const scope = { id, epoch, device }, key = questJournalKey(device, id);
  const result = (command: QuestSave): PersonalQuest => ({ ...command.quest, title: command.quest.title.trim(), steps: command.quest.steps.map(step => ({ id: step.id, taskId: step.taskId ?? `task:quest:${id}:${step.id}` })), revision: command.expectedRevision + 1, archived: false, createdAt: '2026-10-20T07:00:00Z', updatedAt: '2026-10-20T07:00:00Z' });
  const post = async (input: QuestSave) => { calls.push(structuredClone(input)); return result(input); };
  const snapshot: Snapshot = { epoch, deviceId: device, cursor: 0, tasks: [], drafts: [], projects: [], layout: { id: 'layout', revision: 1, deviceId: device, updatedAt: '', value: structuredClone(defaultLayout) }, capabilities: { assistant: false, voice: false, reason: 'Synthetic' } };
  return { epoch, device, id, journal, scope, key, storage, values, calls, result, post, snapshot,
    refuseRead(value: boolean) { failedRead = value; }, refuseWrite(value: boolean) { failedWrite = value; }, loseReadback() { loseReadback = true; } };
}

test('legacy incomplete writing is untrimmed; malformed and unrelated pending authority is never replaced', () => {
  const f = fixture(); f.journal.draft.title = ''; f.journal.draft.due = 'unfinished'; f.journal.draft.steps = [];
  f.values.set(f.key, JSON.stringify(f.journal)); const editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, f.post);
  assert(!editor.slot.invalid); assert.deepEqual(editor.journal.draft, f.journal.draft);
  for (const raw of ['{broken', JSON.stringify({ ...f.journal, extra: 'future' }), JSON.stringify({ ...f.journal, draft: { ...f.journal.draft, id: randomUUID() } })]) {
    f.values.set(f.key, raw); const invalid = new QuestEditor(f.storage, f.key, f.scope, f.journal, f.post);
    assert(invalid.slot.invalid); assert(invalid.retain()); assert(!invalid.change(f.journal.draft)); assert(!invalid.discard()); assert.equal(f.values.get(f.key), raw);
  }
  const g = fixture(); const pending: QuestSave = { action: 'save', requestId: randomUUID(), epoch: randomUUID(), expectedRevision: 0, quest: g.journal.draft };
  g.values.set(g.key, JSON.stringify({ ...g.journal, pending }));
  assert(new QuestEditor(g.storage, g.key, g.scope, g.journal, g.post).slot.invalid);
});
test('a failed write retains the latest incomplete input and exact lost-readback retries are idempotent', () => {
  const f = fixture(), editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, f.post);
  f.refuseWrite(true); assert(!editor.change({ ...editor.journal.draft, title: '  Latest typing 雪  ' }));
  assert.equal(editor.journal.draft.title, '  Latest typing 雪  '); assert(!editor.retain()); assert.equal(f.values.size, 0);
  f.refuseWrite(false); f.loseReadback(); assert(!editor.retain()); const raw = f.values.get(f.key);
  f.refuseRead(false); assert(editor.retain()); assert.equal(f.values.get(f.key), raw); assert(editor.kept);
});
test('a request is kept before dispatch; failed admission reuses the same ID after storage recovers', async () => {
  const f = fixture(), editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, async input => { assert.deepEqual(JSON.parse(f.values.get(f.key)!).pending, input); return f.post(input); });
  f.refuseWrite(true); assert.equal(await editor.save(), undefined); const original = editor.journal.pending!; assert(original); assert.equal(f.calls.length, 0);
  f.refuseWrite(false); await editor.save(); assert.deepEqual(f.calls[0], original); assert.equal(f.calls.length, 1);
  assert.equal(editor.journal.draft.steps[1].taskId, 'task:linked'); assert.equal(editor.journal.draft.steps[0].taskId, `task:quest:${f.id}:${original.quest.steps[0].id}`);
});
test('known success with failed local acknowledgement retries only the local clear; reload uses the original request', async () => {
  const f = fixture(), editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, async input => { const result = await f.post(input); f.refuseWrite(true); return result; });
  assert.equal(await editor.save(), undefined); assert(editor.journal.pending); const original = structuredClone(f.calls[0]);
  f.refuseWrite(false); assert(await editor.save()); assert.equal(f.calls.length, 1); assert(!editor.journal.pending);
  const g = fixture(), lost = new QuestEditor(g.storage, g.key, g.scope, g.journal, async input => { g.calls.push(structuredClone(input)); throw Error('Response lost'); });
  await lost.save(); const reopened = new QuestEditor(g.storage, g.key, g.scope, g.journal, g.post); await reopened.save();
  assert.deepEqual(g.calls[1], g.calls[0]); assert.equal(original.quest.title, '  Keep original title  ');
});
test('wrong quest/revision/payload/Task mapping never acknowledges the original save', async () => {
  for (const alter of [(r: PersonalQuest) => ({ ...r, id: randomUUID() }), (r: PersonalQuest) => ({ ...r, revision: 9 }), (r: PersonalQuest) => ({ ...r, title: 'Other' }), (r: PersonalQuest) => ({ ...r, steps: r.steps.map(s => ({ ...s, taskId: 'task:other' })) })]) {
    const f = fixture(), editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, async input => alter(await f.post(input)));
    assert.equal(await editor.save(), undefined); assert(editor.journal.pending); assert.equal(f.calls.length, 1);
  }
});
test('definite rejection clear failure retains one original command and explicit version review preserves writing', async () => {
  const f = fixture(); let rejecting = true;
  const editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, async input => {
    if (rejecting) { f.calls.push(structuredClone(input)); f.refuseWrite(true); throw Object.assign(Error('Changed'), { status: 409 }); }
    return f.post(input);
  });
  await editor.save(); assert(editor.journal.pending); assert.equal(f.calls.length, 1);
  f.refuseWrite(false); await editor.save(); assert.equal(f.calls.length, 1); assert(!editor.journal.pending); assert(editor.conflict);
  const current = { ...f.result(f.calls[0]), revision: 3 }; assert.equal(await editor.save(current), undefined);
  f.refuseWrite(true); assert(!editor.review(current)); assert.equal(editor.journal.revision, 0);
  f.refuseWrite(false); assert(editor.review(current)); rejecting = false; await editor.save(current); assert.equal(f.calls[1].expectedRevision, 3);
});
test('an independently changed journal and retired owner retain original requests after late replies', async () => {
  for (const retired of [false, true]) {
    const f = fixture(); let release!: (value: unknown) => void;
    const editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, input => { f.calls.push(structuredClone(input)); return new Promise(resolve => { release = resolve; }); });
    const work = editor.save(); const original = f.values.get(f.key)!;
    if (retired) editor.retire(); else f.values.set(f.key, JSON.stringify({ ...f.journal, draft: { ...f.journal.draft, title: 'Other owner' } }));
    const other = f.values.get(f.key); release(f.result(f.calls[0])); assert.equal(await work, undefined);
    assert.equal(f.values.get(f.key), other); assert(editor.journal.pending); assert(!retired || other === original);
  }
});
test('foreign epoch, missing original and archived quests never become a new quest by explicit review', async () => {
  const f = fixture(); f.values.set(f.key, JSON.stringify({ ...f.journal, epoch: randomUUID() }));
  const old = new QuestEditor(f.storage, f.key, f.scope, f.journal, f.post); assert(!old.review()); assert.equal(await old.save(), undefined);
  const missing = new QuestEditor(f.storage, 'missing', f.scope, { ...f.journal, revision: 3 }, f.post); assert(!missing.review()); assert.equal(await missing.save(), undefined);
  const archived = { ...f.result({ action: 'save', quest: f.journal.draft, epoch: f.epoch, requestId: randomUUID(), expectedRevision: 0 }), archived: true };
  assert(!missing.review(archived)); assert.equal(f.calls.length, 0);
});
test('safe discard refuses storage conflicts and never resurrects a discarded journal during failed parent close', () => {
  const f = fixture(), editor = new QuestEditor(f.storage, f.key, f.scope, f.journal, f.post); editor.retain();
  f.refuseWrite(true); assert(!editor.discard()); assert.equal(editor.journal.draft.title, f.journal.draft.title);
  f.refuseWrite(false); assert(editor.discard()); assert.equal(f.values.get(f.key), 'null'); assert(editor.retain()); assert.equal(f.values.get(f.key), 'null');
});

class Hooks {
  cells: any[] = []; cursor = 0; effects: (() => void)[] = []; tree: any; saved = 0; discarded = 0;
  posts: { input: QuestSave; resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
  globals: [PropertyKey, PropertyDescriptor | undefined][] = [];
  constructor(readonly f = fixture()) {}
  state(value: any) { const i = this.cursor++; if (!this.cells[i]) this.cells[i] = { value: typeof value === 'function' ? value() : value }; return [this.cells[i].value, (next: any) => { this.cells[i].value = typeof next === 'function' ? next(this.cells[i].value) : next; }]; }
  ref(value: any) { return this.cells[this.cursor++] ??= { current: value }; }
  effect(run: () => void | (() => void), deps: unknown[]) { const i = this.cursor++, old = this.cells[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) this.effects.push(() => { old?.cleanup?.(); this.cells[i] = { deps, cleanup: run() }; }); }
  request(path: string, input: QuestSave) { assert.equal(path, 'profile/quests'); return new Promise((resolve, reject) => { this.posts.push({ input, resolve, reject }); }); }
  open() {
    const values: Record<PropertyKey, unknown> = { [symbol]: this, localStorage: this.f.storage, window: new EventTarget() };
    this.globals = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
  }
  render(snapshot = this.f.snapshot) { this.cursor = 0; this.effects = []; this.tree = ProfileQuestEditor({ id: this.f.id, snapshot, saved: async () => { this.saved++; }, discard: () => { this.discarded++; } }); for (const run of this.effects) run(); return this.tree; }
  close() { for (const cell of this.cells) cell?.cleanup?.(); for (const [key, value] of this.globals) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
}
const nodes = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const text = (node: any): string => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node);
const button = (tree: any, label: string) => { const node = nodes(tree).find(n => n.type === 'button' && text(n) === label); assert.ok(node, label); return node; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('actual input/leave/retry/discard callbacks keep failed typing and the original legacy key', () => {
  const h = new Hooks(); h.open();
  try {
    let tree = h.render(); h.f.refuseWrite(true);
    nodes(tree).find(n => n.type === 'input' && n.props.placeholder === 'What do you want to accomplish?').props.onChange({ target: { value: 'Latest still open 雪' } });
    tree = h.render(); assert(nodes(tree).some(n => n.type === 'input' && n.props.value === 'Latest still open 雪')); assert(!mayLeaveRecordDrafts());
    button(tree, 'Discard edits').props.onClick(); assert.equal(h.discarded, 0);
    h.f.refuseWrite(false); button(tree, 'Retry Keeping Writing').props.onClick(); tree = h.render(); assert(mayLeaveRecordDrafts());
    assert.equal(JSON.parse(h.f.values.get(h.f.key)!).draft.title, 'Latest still open 雪');
    button(tree, 'Discard edits').props.onClick(); assert.equal(h.discarded, 1); assert.equal(h.f.values.get(h.f.key), 'null'); assert.equal(h.posts.length, 0);
  } finally { h.close(); }
});
test('actual submit callback retains genuine response until local acknowledgement succeeds without another POST', async () => {
  const h = new Hooks(); h.f.values.set(h.f.key, JSON.stringify(h.f.journal)); h.open();
  try {
    h.render().props.onSubmit({ preventDefault() {} }); assert.equal(h.posts.length, 1);
    h.f.refuseWrite(true); h.posts[0].resolve(h.f.result(h.posts[0].input)); await settle(); let tree = h.render();
    assert.equal(h.saved, 0); assert(JSON.parse(h.f.values.get(h.f.key)!).pending);
    h.f.refuseWrite(false); tree.props.onSubmit({ preventDefault() {} }); await settle(); tree = h.render();
    assert.equal(h.saved, 1); assert.equal(h.posts.length, 1); assert(!JSON.parse(h.f.values.get(h.f.key)!).pending);
    tree.props.onSubmit({ preventDefault() {} }); await settle(); assert.equal(h.posts.length, 1);
  } finally { h.close(); }
});
test('actual malformed/read-refused and changed epoch callbacks never write, send or clear original data', async () => {
  for (const unreadable of [false, true]) {
    const h = new Hooks(); h.f.values.set(h.f.key, '{original-broken'); if (unreadable) h.f.refuseRead(true); h.open();
    try {
      const tree = h.render(); assert(nodes(tree).some(n => n.type === 'fieldset' && n.props.disabled));
      tree.props.onSubmit({ preventDefault() {} }); button(tree, 'Discard edits').props.onClick(); await settle();
      assert.equal(h.posts.length, 0); assert.equal(h.f.values.get(h.f.key), '{original-broken'); assert(mayLeaveRecordDrafts());
    } finally { h.close(); }
  }
  const h = new Hooks(); h.f.values.set(h.f.key, JSON.stringify(h.f.journal)); h.open();
  try {
    h.render().props.onSubmit({ preventDefault() {} }); const before = h.f.values.get(h.f.key);
    h.render({ ...h.f.snapshot, epoch: randomUUID() }); h.posts[0].resolve(h.f.result(h.posts[0].input)); await settle();
    assert.equal(h.saved, 0); assert.equal(h.f.values.get(h.f.key), before);
  } finally { h.close(); }
});
