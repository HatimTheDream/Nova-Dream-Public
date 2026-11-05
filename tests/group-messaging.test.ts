import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { registerHooks } from 'node:module';
import { Store } from '../apps/service/store';
import { AssistantGroups } from '../apps/service/assistant-groups';
import { AssistantGroupPreparations, groupPreparationQuery } from '../apps/service/assistant-group-turns';
import { blankRecord, contentSchema } from '../packages/domain/workspace-records';
import { canonical } from '../packages/domain/contracts';
import { groupDraftScopeSchema, parseGroupDraft, type GroupPreparationCommand } from '../packages/domain/assistant-group-turns';
import { GroupMessageJournal, emptyGroupWriting, groupMessageKey, originalPreparationReceipt } from '../apps/client/src/group-message-journal';
import { GroupMessageReader, groupDigest, inspectGroupContext, preparationUrl } from '../apps/client/src/group-message-reader';
import { discoverGroupMessages, planGroupMessageCopy, applyGroupMessageCopy } from '../apps/client/src/group-message-recovery';
import { GroupHistoryJournal, validateHistoryPreview, type HistoryCommand } from '../apps/client/src/group-history-sharing';
import { ApiError } from '../apps/client/src/api';

// Component handlers use synthetic hooks; no browser/native acceptance is implied.
const hookKey = Symbol.for('nova.test.group-messaging');
const react = import.meta.resolve('react');
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.includes('/apps/client/src/'))
      return { url: 'nova-test:group-message-hooks', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'nova-test:group-message-hooks') return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(react)};
      const h=()=>globalThis[Symbol.for('nova.test.group-messaging')];
      export const useState=v=>h().state(v),useRef=v=>h().ref(v);
      export const useEffect=(f,d)=>h().effect(f,d),useLayoutEffect=useEffect;` };
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' };
    return next(url, context);
  },
});
const { GroupMessaging, GroupTranscriptRound, GroupContextChoices, groupComposerScope, groupReplyLabel } = await import('../apps/client/src/GroupMessaging');
const { GroupReplyControls } = await import('../apps/client/src/GroupReplyControls');
const { GroupMessageRecovery } = await import('../apps/client/src/GroupMessageRecovery');
const { GroupHistorySharing } = await import('../apps/client/src/GroupHistorySharing');
const { GroupContextInspector } = await import('../apps/client/src/GroupContextInspector');
loader.deregister();

function fixture(t: TestContext) {
  const parent = resolve('.tmp-qa/group-message-ui'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'case-')), store = new Store(directory);
  t.after(() => store.close());
  const { deviceId } = store.session(), epoch = store.epoch, groupId = randomUUID(), windowId = randomUUID();
  for (let i = 0; i < 2; i++) store.mutate(deviceId, { requestId: randomUUID(), epoch, kind: 'agent', entityId: `agent:person-${i}`,
    expectedRevision: 0, payload: { ...blankRecord('agent', 'UTC'), name: 'Same Name', position: i ? 'Review' : 'Planning', access: { content: 'read' } } });
  new AssistantGroups(store).save(deviceId, { requestId: randomUUID(), epoch, groupId, expectedRevision: 0,
    action: 'create', title: 'Local Group', projectId: null, members: [0, 1].map(i => ({ agentId: `agent:person-${i}`, agentRevision: 1 })),
    defaultAgentId: 'agent:person-0' });
  const bundle = store.readAssistantGroup(groupId), group = bundle.group!, members = bundle.members;
  const snapshot = store.snapshot(deviceId);
  const props = { snapshot, group, members, windowId };
  const scope = groupComposerScope(props, 'default')!;
  const rows = new Map<string, string>(), faults = { write: false, read: false, readback: false };
  let nextReadFails = false;
  const storage = { get length() { return rows.size; }, key: (i: number) => [...rows.keys()][i] ?? null,
    getItem: (key: string) => { if (faults.read || nextReadFails) { nextReadFails = false; throw Error('Synthetic read failure'); } return rows.get(key) ?? null; },
    setItem: (key: string, raw: string) => { if (faults.write) throw Error('Synthetic write failure'); rows.set(key, raw);
      if (faults.readback) { nextReadFails = true; faults.readback = false; } },
  };
  const service = new AssistantGroupPreparations(store), calls: GroupPreparationCommand[] = [];
  const post = async (command: GroupPreparationCommand) => { calls.push(command); return service.save(deviceId, command); };
  const get = async (url: string) => service.read(deviceId, groupPreparationQuery(new URL(url, 'http://fixture').searchParams));
  const journal = new GroupMessageJournal(storage, scope, () => true);
  journal.readSaved(null);
  return { store, directory, epoch, deviceId, groupId, windowId, group, members, props, scope, rows, storage, faults, service, calls, get, post, journal };
}
const write = (j: GroupMessageJournal, text: string) => j.change({ ...j.value.writing, text });

test('draft save and prepare use the real service, reload preserves writing and original receipts', async t => {
  const f = fixture(t), j = f.journal;
  write(j, 'Original owner message');
  const saved = await j.save(f.post); assert.ok(saved?.draftRaw); assert.equal(j.dirty, false);
  const prepared = await j.prepare(1, f.post); assert.ok(prepared?.roundId);
  assert.deepEqual(f.calls.map(c => c.action), ['save-draft-v2', 'prepare']);
  const reload = new GroupMessageJournal(f.storage, f.scope, () => true);
  assert.equal(reload.invalid, false); assert.equal(reload.value.writing.text, 'Original owner message');
  assert.equal(reload.value.pending?.receipt?.roundId, prepared.roundId);
  assert.ok([...f.rows.keys()].some(k => k.includes(':confirmed:')));
  const reader = new GroupMessageReader(f.epoch, f.groupId, () => true);
  assert.equal(await reader.load(f.get), true); assert.equal(await reader.open(prepared.roundId, f.get), true);
  assert.equal(reader.details.get(prepared.roundId)!.responses[0].state, 'not-sent');
  assert.equal(reader.details.get(prepared.roundId)!.responses[0].stop, null);
  assert.equal(reader.details.get(prepared.roundId)!.round.text, 'Original owner message');
});

test('lost save reply is reconciled by its exact request without a second POST; newer text survives', async t => {
  const f = fixture(t), j = f.journal;
  write(j, 'Captured message');
  await j.save(async c => { await f.post(c); throw Error('Synthetic timeout after commit'); });
  const original = j.value.pending!.command.requestId;
  write(j, 'Newer unsaved message');
  await j.save(f.post); await j.continueOriginal(f.post);
  assert.equal(f.calls.length, 1); assert.equal(j.canContinue, false);
  const reload = new GroupMessageJournal(f.storage, f.scope, () => true);
  await reload.observe(c => f.get(`assistant/group-preparations?view=request&groupId=${c.groupId}&requestId=${c.requestId}`));
  assert.equal(reload.value.pending!.receipt!.requestId, original);
  assert.equal(reload.value.writing.text, 'Newer unsaved message'); assert.equal(reload.dirty, true);
  assert.equal(f.calls.length, 1);
});

test('storage failure blocks dispatch, keeps full writing and allows only the same unsent request', async t => {
  const f = fixture(t), j = f.journal;
  write(j, 'Full text '.repeat(1000)); f.faults.write = true;
  await j.save(f.post); assert.equal(f.calls.length, 0); assert.ok(j.canContinue);
  const original = j.value.pending!.command.requestId;
  assert.equal(j.value.writing.text.length, 10000);
  f.faults.write = false; await j.continueOriginal(f.post);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].requestId, original);
});

test('exact attempted readback can be recovered without overwriting a different window value', t => {
  const f = fixture(t), j = f.journal;
  f.faults.readback = true; assert.equal(write(j, 'Window copy'), false);
  assert.equal(j.retain(), true);
  f.rows.set(j.key, f.rows.get(j.key)!.replace('Window copy', 'Other window'));
  assert.equal(write(j, 'Newest local copy'), false);
  assert.equal(j.value.writing.text, 'Newest local copy');
  assert.match(f.rows.get(j.key)!, /Other window/);
});

test('recipient identity distinguishes duplicate names and preserves separate drafts without copying context', t => {
  const f = fixture(t);
  write(f.journal, 'For the default person');
  const everyone = groupComposerScope(f.props, 'everyone')!;
  const one = groupComposerScope(f.props, f.members.find(m => m.id !== f.group.defaultMemberId)!.id)!;
  assert.equal(everyone.recipients.length, 2); assert.notEqual(one.recipients[0].membershipId, f.scope.recipients[0].membershipId);
  const another = new GroupMessageJournal(f.storage, one, () => true);
  assert.deepEqual(another.value.writing, emptyGroupWriting());
  write(another, 'For the reviewer');
  assert.equal(new GroupMessageJournal(f.storage, f.scope, () => true).value.writing.text, 'For the default person');
  const unavailable = { ...f.props, snapshot: { ...f.props.snapshot, records: undefined } };
  assert.equal(groupComposerScope(unavailable, 'everyone'), null);
  assert.equal(groupComposerScope({ ...f.props, group: { ...f.group, archived: true } }, 'default'), null);
});

test('remote draft conflict retains both copies and choosing does not save automatically', async t => {
  const f = fixture(t), j = f.journal;
  write(j, 'My local writing');
  const receipt = await f.post({ action: 'save-draft-v2', requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    scope: f.scope, expectedRaw: null, ...emptyGroupWriting(), text: 'Saved elsewhere' });
  assert.equal(j.readSaved(receipt.draftRaw), false);
  await j.save(f.post); assert.equal(f.calls.length, 1);
  assert.equal(j.chooseSaved(false), true); assert.equal(j.value.writing.text, 'My local writing'); assert.equal(j.dirty, true);
  const comparisons = [...f.rows.entries()].filter(([k]) => k.includes(':comparison:'));
  assert.equal(comparisons.length, 1); assert.match(comparisons[0][1], /My local writing/); assert.match(comparisons[0][1], /Saved elsewhere/);
  assert.equal(f.calls.length, 1); assert.ok(await j.save(f.post));
});

test('wrong request/scope/receipt payload is not confirmation and malformed local bytes stay untouched', async t => {
  const f = fixture(t), j = f.journal;
  write(j, 'Exact');
  await j.save(async c => ({ ...await f.post(c), requestId: randomUUID() }));
  assert.equal(j.value.pending?.receipt, undefined); assert.equal(j.canContinue, false);
  const c = f.calls[0], receipt = f.service.save(f.deviceId, c);
  const draft = parseGroupDraft(receipt.draftRaw!);
  assert.throws(() => originalPreparationReceipt(f.scope, c, { ...receipt, draftRaw: canonical({ ...draft, text: 'Other' }) }));
  const original = '{"format":999,"writing":"Never discard"}';
  f.rows.set(j.key, original);
  const invalid = new GroupMessageJournal(f.storage, f.scope, () => true);
  assert.equal(invalid.invalid, true); assert.equal(invalid.retain(), false); assert.equal(f.rows.get(j.key), original);
});

test('a late receipt never clears newer writing; a closed scope never dispatches or replaces its successor', async t => {
  const f = fixture(t);
  let current = true, complete!: (value: unknown) => void;
  const j = new GroupMessageJournal(f.storage, f.scope, () => current); j.readSaved(null); write(j, 'First');
  const saving = j.save(c => new Promise(resolve => { complete = resolve; f.calls.push(c); }));
  write(j, 'Newer');
  const result = f.service.save(f.deviceId, f.calls[0]); complete(result); await saving;
  assert.equal(j.value.writing.text, 'Newer'); assert.equal(j.dirty, true);
  current = false; await j.save(f.post); assert.equal(f.calls.length, 1); assert.equal(j.retain(), false);
});

test('history rejects foreign pages and keeps the previous readable page on refresh failure', async t => {
  const f = fixture(t); write(f.journal, 'History'); await f.journal.save(f.post); const prepared = await f.journal.prepare(1, f.post);
  const reader = new GroupMessageReader(f.epoch, f.groupId, () => true);
  assert.equal(await reader.load(f.get), true);
  assert.equal(await reader.load(async url => ({ ...await f.get(url), epoch: randomUUID() })), false);
  assert.equal(reader.rows[0].id, prepared!.roundId);
  assert.equal(await reader.open(prepared!.roundId!, async url => {
    const result = await f.get(url);
    return 'responses' in result ? { ...result, roundId: randomUUID() } : result;
  }), false);
  assert.equal(reader.details.size, 0);
});

test('a vanished view cannot adopt a delayed history read', async t => {
  const f = fixture(t); let current = true;
  const reader = new GroupMessageReader(f.epoch, f.groupId, () => current);
  assert.equal(await reader.load(async url => { const result = await f.get(url); current = false; return result; }), false);
  assert.equal(reader.sequence, null); assert.equal(reader.rows.length, 0);
});

test('verified synchronous rejection preserves the exact command and requires explicit review before a new request', async t => {
  const f = fixture(t), j = f.journal; write(j, 'Message'); await j.save(f.post);
  await j.prepare(0, async c => {
    try { return await f.post(c); }
    catch (e: any) { throw new ApiError(e.code, e.message, e.current, e.status); }
  });
  const rejected = j.value.pending!.command;
  assert.equal(j.value.pending?.rejection?.kind, 'assistant-group-preparation-rejection');
  assert.equal(j.canContinue, false); assert.equal(f.calls.length, 2);
  const reload = new GroupMessageJournal(f.storage, f.scope, () => true);
  assert.equal(reload.invalid, false); assert.deepEqual(reload.value.pending!.rejection!.command, rejected);
  await reload.prepare(1, f.post); await reload.continueOriginal(f.post); assert.equal(f.calls.length, 2);
  reload.readSaved(j.value.savedRaw); assert.equal(reload.finishRejected(), true);
  assert.ok([...f.rows.keys()].some(k => k.endsWith(':rejected:' + rejected.requestId)));
  assert.ok((await reload.prepare(1, f.post))?.roundId); assert.equal(f.calls.length, 3);
  assert.notEqual(f.calls[2].requestId, rejected.requestId);
});

test('admitted work, reused identities, stale epochs and unreadable state never receive an absence proof', async t => {
  const f = fixture(t), command: GroupPreparationCommand = { action: 'save-draft-v2', requestId: randomUUID(), epoch: f.epoch,
    groupId: f.groupId, scope: f.scope, expectedRaw: null, ...emptyGroupWriting(), text: 'Original' };
  const saved = f.service.save(f.deviceId, command);
  assert.throws(() => f.service.save(f.deviceId, { ...command, text: 'Changed' }), (e: any) => e.code === 'request_reused' && !e.current);
  assert.throws(() => f.service.save(f.deviceId, { ...command, epoch: randomUUID() }), (e: any) => e.code === 'epoch_changed' && !e.current);
  const admit = f.store.admitGroupPreparation.bind(f.store);
  f.store.admitGroupPreparation = () => { throw Error('Synthetic failure after an already admitted result'); };
  assert.throws(() => f.service.save(f.deviceId, command), (e: any) => e.code === 'group_preparation_changed' && !e.current);
  assert.equal(f.store.replayAdmission<{ draftRaw: string }>(f.deviceId, command, { type: 'assistant.group-preparation', ...command })?.draftRaw, saved.draftRaw);
  const read = f.store.readGroupPreparation.bind(f.store);
  f.store.readGroupPreparation = () => { throw Error('Synthetic incomplete joined state'); };
  assert.throws(() => f.service.save(f.deviceId, { ...command, requestId: randomUUID() }), (e: any) => e.code === 'group_preparation_changed' && !e.current);
  f.store.readGroupPreparation = read; f.store.admitGroupPreparation = admit;
});

test('a rejection claiming a different command does not unlock an uncertain request', async t => {
  const f = fixture(t), j = f.journal; write(j, 'Original');
  await j.save(async c => { throw new ApiError('group_preparation_rejected', 'Forged mismatch',
    { kind: 'assistant-group-preparation-rejection', command: { ...c, requestId: randomUUID() } } as any, 409); });
  assert.equal(j.value.pending?.rejection, undefined); assert.equal(j.finishRejected(), false);
  await j.continueOriginal(f.post); assert.equal(f.calls.length, 0);
});

test('pagination refuses missing or duplicated rounds instead of claiming complete history', async t => {
  const f = fixture(t), reader = new GroupMessageReader(f.epoch, f.groupId, () => true);
  const bad = async (url: string) => {
    const result = await f.get(url);
    return 'total' in result ? { ...result, total: 1 } : result;
  };
  assert.equal(await reader.load(bad), false);
  assert.equal(reader.sequence, null);
});

const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, title: string) => nodes(tree).find(n => n.type === 'button' && text(n) === title);
function host(f: ReturnType<typeof fixture>, render = () => GroupMessaging(f.props),
  transport?: (url: string, init: RequestInit) => Promise<unknown>) {
  let cursor = 0, dirty = true, tree: any;
  const cells: any[] = [], effects: (() => void)[] = [], calls: { method: string; url: string }[] = [];
  const values: Record<PropertyKey, unknown> = {
    [hookKey]: {
      state(value: any) { const i = cursor++; cells[i] ??= { value: typeof value === 'function' ? value() : value }; return [cells[i].value, (next: any) => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; dirty = true; }]; },
      ref(value: any) { return cells[cursor++] ??= { current: value }; },
      effect(run: () => void | (() => void), deps: unknown[]) { const i = cursor++, prior = cells[i]; if (!prior || deps.some((value, index) => !Object.is(value, prior.deps[index]))) { cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = run(); }); } },
    },
    localStorage: f.storage,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url });
      try {
        const value = transport ? await transport(url, init)
          : url.endsWith('/group-preparations/preview') ? f.service.preview(f.deviceId, JSON.parse(String(init.body)))
            : init.method === 'POST' ? await f.post(JSON.parse(String(init.body))) : await f.get(url);
        return new Response(JSON.stringify(value));
      } catch (e: any) { return new Response(JSON.stringify({ code: e.code, message: e.message, current: e.current }), { status: e.status ?? 409 }); }
    },
  };
  const pendingDigests = new Set<Promise<ArrayBuffer>>(), subtle = crypto.subtle;
  const digestDescriptor = Object.getOwnPropertyDescriptor(subtle, 'digest'), digest = subtle.digest.bind(subtle);
  subtle.digest = (...args: Parameters<SubtleCrypto['digest']>) => {
    const result = digest(...args); pendingDigests.add(result);
    void result.then(() => pendingDigests.delete(result), () => pendingDigests.delete(result)); return result;
  };
  const original = Reflect.ownKeys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of Reflect.ownKeys(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  return { calls, get tree() { return tree; },
    refresh() { dirty = true; },
    async flush() { const deadline = performance.now() + 5000; for (let pass = 0; pass < 20 || pendingDigests.size || dirty; pass++) {
      assert.ok(performance.now() < deadline, 'Group view did not settle its actual digest work within5seconds');
      if (dirty) { dirty = false; cursor = 0; tree = render(); while (effects.length) effects.shift()!(); }
      await new Promise(resolve => pendingDigests.size ? setTimeout(resolve, 1) : setImmediate(resolve));
    } },
    close() { for (const cell of cells) cell?.cleanup?.(); if (digestDescriptor) Object.defineProperty(subtle, 'digest', digestDescriptor); else Reflect.deleteProperty(subtle, 'digest'); for (const [key, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); },
  };
}

test('composer handlers keep writing, explicitly save/prepare, and recipient switch restores the original draft', async t => {
  const f = fixture(t), app = host(f);
  try {
    await app.flush();
    const textarea = () => nodes(app.tree).find(n => n.type === 'textarea');
    textarea().props.onChange({ target: { value: 'My Group message' } }); await app.flush();
    assert.equal(button(app.tree, 'Save Draft').props.disabled, false);
    button(app.tree, 'Save Draft').props.onClick(); await app.flush();
    assert.equal(f.calls.length, 1); assert.equal(button(app.tree, 'Prepare Message').props.disabled, false);
    button(app.tree, 'Prepare Message').props.onClick(); await app.flush();
    assert.equal(f.calls.length, 2); assert.match(text(app.tree), /Message Prepared/);
    nodes(app.tree).find(n => n.type === 'select').props.onChange({ target: { value: 'everyone' } }); await app.flush();
    assert.equal(textarea().props.value, 'My Group message');
    button(app.tree, 'Use These Recipients').props.onClick(); await app.flush();
    assert.equal(textarea().props.value, '');
    nodes(app.tree).find(n => n.type === 'select').props.onChange({ target: { value: 'default' } }); await app.flush();
    button(app.tree, 'Use These Recipients').props.onClick(); await app.flush();
    assert.equal(textarea().props.value, 'My Group message'); assert.equal(f.calls.length, 2);
    assert.equal(app.calls.some(c => c.url.includes('group-executions')), false);
  } finally { app.close(); }
});

test('transcript identities stay outside bubbles; failed/unknown replies never become selectable context', async t => {
  const f = fixture(t); write(f.journal, 'Message'); await f.journal.save(f.post); const prepared = await f.journal.prepare(1, f.post);
  const reader = new GroupMessageReader(f.epoch, f.groupId, () => true); await reader.load(f.get); await reader.open(prepared!.roundId!, f.get);
  const detail = reader.details.get(prepared!.roundId!)!;
  detail.responses[0] = { ...detail.responses[0], state: 'unknown', text: 'Partial answer', stop: { requestId: randomUUID(), state: 'unconfirmed' } };
  const changes: any[] = [];
  const tree = GroupTranscriptRound({ detail, members: [], writing: emptyGroupWriting(), change: x => changes.push(x), disabled: false });
  assert.match(text(tree), /Left Group/); assert.match(text(tree), /Stop Unconfirmed/); assert.match(text(tree), /Outcome Unconfirmed/);
  const bubbles = nodes(tree).filter(n => n.props.className === 'group-message-bubble');
  assert.deepEqual(bubbles.map(text), ['Message', 'Partial answer']);
  const checks = nodes(tree).filter(n => n.type === 'input');
  assert.equal(checks.length, 1); checks[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(changes[0].history, [{ roundId: detail.round.id, sha256: detail.sha256 }]);
  for (const state of ['failed', 'cancelled', 'accepted', 'unknown']) assert.notEqual(groupReplyLabel(state), 'Completed');
});

test('current membership/default changes cannot retarget kept writing after refresh or reload', async t => {
  const f = fixture(t); let app = host(f);
  try {
    await app.flush();
    nodes(app.tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'For my original responder' } }); await app.flush();
    f.props.group = { ...f.group, revision: 2, defaultRevision: 2, defaultMemberId: f.members.find(m => m.id !== f.group.defaultMemberId)!.id };
    app.refresh(); await app.flush();
    assert.equal(button(app.tree, 'Save Draft').props.disabled, true);
    assert.equal(nodes(app.tree).find(n => n.type === 'textarea').props.value, 'For my original responder');
    assert.match(text(app.tree), /original recipients.*changed/);
    app.close(); app = host(f); await app.flush();
    assert.equal(nodes(app.tree).find(n => n.type === 'textarea').props.value, 'For my original responder');
    assert.equal(button(app.tree, 'Save Draft').props.disabled, true);
    button(app.tree, 'Use These Recipients').props.onClick(); await app.flush();
    assert.equal(nodes(app.tree).find(n => n.type === 'textarea').props.value, '');
    assert.equal(f.calls.length, 0);
  } finally { app.close(); }
});

test('retained sources remain visible, do not adopt newer labels, and are removed only by explicit selection', t => {
  const f = fixture(t), changes: any[] = [];
  const writing = { ...emptyGroupWriting(), sources: [{ kind: 'content' as const, id: 'content:old', revision: 1, sha256: 'a'.repeat(64) }],
    history: [{ roundId: randomUUID(), sha256: 'b'.repeat(64) }],
    responses: [{ roundId: randomUUID(), attemptId: randomUUID(), terminalSequence: 1, terminalSha256: 'c'.repeat(64) }] };
  const snapshot = structuredClone(f.props.snapshot);
  snapshot.records!.content.push({ id: 'content:old', revision: 2, updatedAt: '2026-10-20T00:00:00.000Z', deviceId: f.deviceId,
    value: contentSchema.parse({ ...blankRecord('content', 'UTC'), title: 'Unrelated new label' }) });
  const tree = GroupContextChoices({ writing, snapshot, disabled: false, change: x => changes.push(x) });
  assert.match(text(tree), /Original Content Version 1/); assert.doesNotMatch(text(tree), /Unrelated new label/);
  assert.match(text(tree), /Earlier Reply 1 And Its Original Context/);
  button(tree, 'Remove Source').props.onClick(); assert.deepEqual(changes, [{ sources: [] }]);
  assert.equal(writing.sources.length, 1); assert.equal(writing.history.length, 1); assert.equal(writing.responses.length, 1);
});

test('composer explicitly reviews a known rejected preparation before creating a new operation', async t => {
  const f = fixture(t), app = host(f);
  try {
    await app.flush();
    nodes(app.tree).find(n => n.type === 'textarea').props.onChange({ target: { value: 'Keep this writing' } }); await app.flush();
    button(app.tree, 'Save Draft').props.onClick(); await app.flush();
    f.service.save(f.deviceId, { action: 'save-draft-v2', requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
      scope: { ...f.scope, windowId: randomUUID() }, expectedRaw: null, ...emptyGroupWriting(), text: 'Independent window' });
    button(app.tree, 'Prepare Message').props.onClick(); await app.flush();
    assert.match(text(app.tree), /Save Not Admitted/);
    const original = f.calls[1].requestId;
    assert.equal(f.calls.length, 2); assert.equal(button(app.tree, 'Prepare Message').props.disabled, true);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), hashStarted = new Promise<void>(resolve => { started = resolve; });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    t.mock.method(crypto.subtle, 'digest', (...args: Parameters<SubtleCrypto['digest']>) => digest(...args).then(async result => {
      started(); await gate; return result;
    }));
    button(app.tree, 'Review Rejected Save').props.onClick();
    await hashStarted; assert.equal(f.calls.length, 2); assert.equal(button(app.tree, 'Prepare Message').props.disabled, true);
    release(); await app.flush();
    assert.equal(f.calls.length, 2); assert.equal(nodes(app.tree).find(n => n.type === 'textarea').props.value, 'Keep this writing');
    button(app.tree, 'Prepare Message').props.onClick(); await app.flush();
    assert.equal(f.calls.length, 3); assert.notEqual(f.calls[2].requestId, original);
    assert.match(text(app.tree), /Message Prepared/);
    assert.ok([...f.rows.keys()].some(k => k.endsWith(':rejected:' + original)));
  } finally { app.close(); }
});

test('reply UI loads saved state only, explicit choices bind setup, and requesting a reply remains a separate control', async t => {
  const f = fixture(t), roundId = randomUUID(), attemptId = randomUUID();
  const binding = { epoch: f.epoch, deviceId: f.deviceId, groupId: f.groupId, roundId,
    roundSha256: 'a'.repeat(64), attemptId, author: { agentId: 'agent:fixture', agentRevision: 1,
      membershipId: f.scope.recipients[0].membershipId, roundId } };
  let view: any = null, changed = 0;
  const posts: any[] = [];
  const app = host(f, () => GroupReplyControls({ binding, originDevice: true, savedText: '', changed: () => { changed++; } }),
    async (url, init) => {
      if (url.endsWith('/assistant/account')) return { state: 'available', accounts: [
        { profileId: 'openai:ready', label: 'Ready Account', health: 'ready' },
        { profileId: 'openai:expired', label: 'Expired Account', health: 'reconnect' }] };
      if (url.endsWith('/assistant/models')) return [{ id: 'openai/model', name: 'Model', available: true },
        { id: 'other/model', name: 'Unsupported Provider', available: true }];
      if (init.method === 'GET') {
        if (!view) throw new ApiError('group_child_missing', 'No original child', undefined, 404);
        return view;
      }
      const command = JSON.parse(String(init.body)); posts.push(command);
      const receipt = { format: 1, kind: 'assistant-group-execution-receipt', requestId: command.requestId,
        epoch: binding.epoch, groupId: binding.groupId, attemptId, sequence: command.expectedRevision + 1, eventSha256: 'b'.repeat(64) };
      const phase = { requestId: command.requestId, commandId: command.requestId, state: 'ready', dispatchStarted: true, error: null, canContinueUnsent: false };
      view = { epoch: binding.epoch, groupId: binding.groupId, attemptId, roundId, roundSha256: binding.roundSha256,
        revision: command.expectedRevision + 3, originalReceipt: receipt, originalCommand: command, account: command.account ?? view.account,
        sha256: 'c'.repeat(64), setup: view?.setup ?? phase, send: command.action === 'send' ? { ...phase, state: 'accepted' } : null,
        stop: null, canSend: command.action === 'setup', canStop: command.action === 'send', observationInFlight: false,
        text: '', nativeTurnId: null, effectiveModel: null, author: binding.author, activity: null };
      return { receipt, current: view };
    });
  try {
    await app.flush(); assert.equal(app.calls.length, 1); assert.equal(posts.length, 0);
    button(app.tree, 'Choose Account And Model').props.onClick(); await app.flush();
    assert.equal(posts.length, 0); assert.equal(button(app.tree, 'Set Up Reply').props.disabled, true);
    assert.doesNotMatch(text(app.tree), /Unsupported Provider/);
    nodes(app.tree).find(n => n.props['aria-label'] === 'Reply Account').props.onChange({ target: { value: 'openai:ready' } });
    nodes(app.tree).find(n => n.props['aria-label'] === 'Reply Model').props.onChange({ target: { value: 'openai/model' } });
    await app.flush(); assert.equal(button(app.tree, 'Set Up Reply').props.disabled, false);
    button(app.tree, 'Set Up Reply').props.onClick(); await app.flush();
    assert.equal(posts.length, 1); assert.equal(posts[0].action, 'setup');
    assert.deepEqual(posts[0].account, { profileId: 'openai:ready', model: 'openai/model' });
    assert.equal(button(app.tree, 'Request Reply').props.disabled, false);
    button(app.tree, 'Request Reply').props.onClick(); await app.flush();
    assert.equal(posts.length, 2); assert.equal(posts[1].action, 'send');
    assert.equal(posts[1].attemptId, attemptId); assert.equal(posts[1].expectedRevision, 3);
    assert.equal(button(app.tree, 'Request Reply'), undefined); assert(button(app.tree, 'Stop This Reply'));
    assert.equal(changed, 2);
    await app.flush(); assert.equal(posts.length, 2);
  } finally { app.close(); }
});

test('a different device can read history but cannot fetch accounts, set up or dispatch this original child', async t => {
  const f = fixture(t), roundId = randomUUID();
  const binding = { epoch: f.epoch, deviceId: f.deviceId, groupId: f.groupId, roundId,
    roundSha256: 'a'.repeat(64), attemptId: randomUUID(), author: { agentId: 'agent:fixture',
      agentRevision: 1, membershipId: f.scope.recipients[0].membershipId, roundId } };
  const app = host(f, () => GroupReplyControls({ binding, originDevice: false, savedText: '', changed: () => {} }));
  try {
    await app.flush(); assert.equal(app.calls.length, 0);
    assert.equal(nodes(app.tree).filter(n => n.type === 'button').length, 0);
    assert.match(text(app.tree), /device that prepared this message/);
  } finally { app.close(); }
});

test('closed-tab recovery copies complete writing and context without moving its original or saving it', t => {
  const f = fixture(t), owner = { ...f.scope, windowId: randomUUID() };
  f.journal.change({ ...emptyGroupWriting(), text: 'Complete writing '.repeat(1000),
    history: [{ roundId: randomUUID(), sha256: 'a'.repeat(64) }] });
  const before = f.rows.get(f.journal.key)!;
  const list = discoverGroupMessages(f.storage, owner);
  assert.equal(list.entries.length, 1);
  const plan = planGroupMessageCopy(f.storage, list.entries[0], owner);
  assert.equal(f.rows.has(plan.key), false);
  const scope = applyGroupMessageCopy(f.storage, plan, owner);
  const copy = new GroupMessageJournal(f.storage, scope, () => true);
  assert.deepEqual(copy.value.writing, f.journal.value.writing);
  assert.equal(copy.value.savedRaw, null); assert.equal(copy.value.pending, undefined);
  assert.equal(f.rows.get(f.journal.key), before); assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(f.rows.get(plan.provenanceKey)!).source.raw, before);
});

test('message recovery refuses occupied destinations, changed originals and changed workspace identity', t => {
  const f = fixture(t), owner = { ...f.scope, windowId: randomUUID() };
  write(f.journal, 'Original'); const entry = discoverGroupMessages(f.storage, owner).entries[0];
  const plan = planGroupMessageCopy(f.storage, entry, owner);
  const target = new GroupMessageJournal(f.storage, plan.scope, () => true); write(target, 'New destination writing');
  const targetRaw = f.rows.get(target.key);
  assert.throws(() => applyGroupMessageCopy(f.storage, plan, owner), /New writing/);
  assert.equal(f.rows.get(target.key), targetRaw);
  assert.throws(() => planGroupMessageCopy(f.storage, entry, owner), /already has a draft/);
  assert.throws(() => planGroupMessageCopy(f.storage, entry, { ...owner, epoch: randomUUID() }), /another workspace/);
  write(f.journal, 'New original writing');
  assert.throws(() => planGroupMessageCopy(f.storage, entry, owner), /original writing changed/);
});

test('copy readback failure continues only exact attempted bytes and preserves original provenance', t => {
  const f = fixture(t), owner = { ...f.scope, windowId: randomUUID() };
  write(f.journal, 'Original copy'); const entry = discoverGroupMessages(f.storage, owner).entries[0];
  const plan = planGroupMessageCopy(f.storage, entry, owner);
  let failed = false, failRead = false;
  const storage = { ...f.storage, getItem: (key: string) => {
    if (failRead && key === plan.key) { failRead = false; throw Error('Target readback failed'); } return f.storage.getItem(key);
  }, setItem: (key: string, raw: string) => {
    f.storage.setItem(key, raw);
    if (!failed && key === plan.key) { failed = true; failRead = true; }
  } };
  assert.throws(() => applyGroupMessageCopy(storage, plan, owner), /readback failed/);
  assert.equal(f.rows.get(plan.key), plan.raw);
  assert.deepEqual(applyGroupMessageCopy(storage, plan, owner), plan.scope);
  assert.equal(f.rows.get(entry.key), entry.raw);
  assert.throws(() => applyGroupMessageCopy(storage, { ...plan, raw: plan.raw.replace('Original copy', 'Altered') }, owner), /destination window changed/);
});

test('an uncertain original message must reconcile before a separate recovered copy is possible', async t => {
  const f = fixture(t), owner = { ...f.scope, windowId: randomUUID() };
  write(f.journal, 'Original'); await f.journal.save(async c => { await f.post(c); throw Error('Lost acknowledgement'); });
  let entry = discoverGroupMessages(f.storage, owner).entries[0];
  assert.throws(() => planGroupMessageCopy(f.storage, entry, owner), /original request/);
  const reload = new GroupMessageJournal(f.storage, f.scope, () => true);
  await reload.observe(c => f.get(preparationUrl(c.groupId, { view: 'request', requestId: c.requestId })));
  entry = discoverGroupMessages(f.storage, owner).entries[0];
  const plan = planGroupMessageCopy(f.storage, entry, owner); applyGroupMessageCopy(f.storage, plan, owner);
  assert.equal(JSON.parse(f.rows.get(plan.key)!).pending, undefined); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.rows.get(entry.key)!).pending.receipt.requestId, f.calls[0].requestId);
});

test('recovery isolates device and Group, preserves malformed/old records and bounds oversize before allocation', t => {
  const f = fixture(t);
  write(f.journal, 'Current'); const raw = f.rows.get(f.journal.key)!;
  const old = { ...f.scope, epoch: randomUUID() }, foreign = { ...f.scope, deviceId: randomUUID() };
  f.rows.set(groupMessageKey(old), JSON.stringify({ format: 1, scope: old, writing: emptyGroupWriting(), savedRaw: null }));
  f.rows.set(groupMessageKey(foreign), raw);
  const malformed = { ...f.scope, windowId: randomUUID() };
  f.rows.set(groupMessageKey(malformed), '{"unrecognized":"keep me"}');
  let list = discoverGroupMessages(f.storage, f.scope);
  assert.equal(list.entries.length, 3); assert.equal(list.entries.filter(r => r.problem).length, 2);
  assert.equal(f.rows.get(groupMessageKey(malformed)), '{"unrecognized":"keep me"}');
  f.rows.clear(); f.rows.set(f.journal.key, 'x'.repeat(1024 * 1024 + 1));
  const encoder = globalThis.TextEncoder;
  try {
    globalThis.TextEncoder = class { constructor() { throw Error('Must not allocate'); } } as any;
    list = discoverGroupMessages(f.storage, f.scope);
    assert.match(list.notice, /oversized/); assert.equal(list.entries.length, 0);
  } finally { globalThis.TextEncoder = encoder; }
});

async function historyFixture(t: TestContext) {
  const f = fixture(t); write(f.journal, 'The first complete message'); await f.journal.save(f.post);
  const receipt = await f.journal.prepare(1, f.post);
  const round = f.store.readGroupPreparation(f.groupId).preparation.rounds.get(receipt!.roundId!)!;
  const ref = { roundId: round.id, sha256: await groupDigest(round) };
  const command: HistoryCommand = { action: 'grant-history-v2', requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    expectedGroupRevision: f.group.revision, expectedSequence: 2, membershipId: f.members[1].id,
    throughSequence: 2, history: [ref], responses: [] };
  const owner = { epoch: f.epoch, deviceId: f.deviceId, groupId: f.groupId };
  const preview = validateHistoryPreview(owner, command, await f.get(preparationUrl(f.groupId, {
    view: 'grant-preview', command: JSON.stringify(command),
  })));
  return { ...f, round, ref, command, owner, preview };
}

test('exact context inspection reads full captured input outside pagination and cannot mutate history', async t => {
  const f = await historyFixture(t), before = f.store.readGroupPreparation(f.groupId).preparation.events.length, calls = f.calls.length;
  const result = await inspectGroupContext(f.epoch, f.groupId, f.ref, f.get);
  assert.equal(result.round.text, 'The first complete message'); assert.equal(result.reply, null);
  await assert.rejects(inspectGroupContext(f.epoch, f.groupId, { ...f.ref, sha256: 'f'.repeat(64) }, f.get), /captured message changed/);
  await assert.rejects(inspectGroupContext(randomUUID(), f.groupId, f.ref, f.get), /different original/);
  assert.equal(f.store.readGroupPreparation(f.groupId).preparation.events.length, before); assert.equal(f.calls.length, calls);
});

test('history preview contains the transitive closure and rejects stale group, membership, sequence and digest', async t => {
  const f = await historyFixture(t), j = new GroupMessageJournal(f.storage, { ...f.scope, windowId: randomUUID() }, () => true);
  j.readSaved(null); j.change({ ...emptyGroupWriting(), text: 'Second with first context', history: [f.ref] });
  await j.save(f.post); const prepared = await j.prepare(3, f.post);
  const round = f.store.readGroupPreparation(f.groupId).preparation.rounds.get(prepared!.roundId!)!;
  const command = { ...f.command, expectedSequence: 4, throughSequence: 4, history: [{ roundId: round.id, sha256: await groupDigest(round) }] };
  const before = f.store.readGroupPreparation(f.groupId).preparation.events.length;
  const preview = validateHistoryPreview(f.owner, command, await f.get(preparationUrl(f.groupId, { view: 'grant-preview', command: JSON.stringify(command) })));
  assert.deepEqual(preview.includedHistory.map(r => r.roundId), [f.round.id, round.id]);
  for (const patch of [{ expectedSequence: 3 }, { expectedGroupRevision: 2 }, { membershipId: randomUUID() },
    { history: [{ ...f.ref, sha256: 'f'.repeat(64) }] }, { epoch: randomUUID() }])
    await assert.rejects(f.get(preparationUrl(f.groupId, { view: 'grant-preview', command: JSON.stringify({ ...command, ...patch }) })));
  assert.equal(f.store.readGroupPreparation(f.groupId).preparation.events.length, before);
});

test('explicit history sharing is retained, acknowledged by exact grant and archived before another choice', async t => {
  const f = await historyFixture(t), j = new GroupHistoryJournal(f.storage, f.owner, () => true), before = f.calls.length;
  assert(j.keep(f.preview)); assert.equal(f.calls.length, before);
  await j.send(f.post, f.get);
  assert.equal(f.calls.length, before + 1); assert(j.value.pending?.confirmation);
  assert.deepEqual(j.value.pending.confirmation.grant.history, f.preview.includedHistory);
  const reload = new GroupHistoryJournal(f.storage, f.owner, () => true);
  assert.equal(reload.invalid, false); assert.equal(reload.canContinue, false);
  await reload.send(f.post, f.get); assert.equal(f.calls.length, before + 1);
  assert(reload.finish()); assert.equal(reload.value.pending, undefined);
  assert(f.rows.has(`${j.key}:original:${f.command.requestId}`));
});

test('lost history-sharing acknowledgement and GET absence never authorize a second POST', async t => {
  const f = await historyFixture(t), j = new GroupHistoryJournal(f.storage, f.owner, () => true), before = f.calls.length;
  j.keep(f.preview);
  await j.send(async c => { await f.post(c); throw Error('Lost acknowledgement'); }, f.get);
  assert.equal(j.value.pending?.confirmation, undefined); assert.equal(j.canContinue, false);
  const reload = new GroupHistoryJournal(f.storage, f.owner, () => true);
  await reload.observe(async () => { throw new ApiError('missing', 'Not found', undefined, 404); });
  assert.equal(reload.canContinue, false); assert.equal(reload.finish(), false);
  await reload.send(f.post, f.get); assert.equal(f.calls.length, before + 1);
  await reload.observe(f.get); assert(reload.value.pending?.confirmation); assert.equal(f.calls.length, before + 1);
});

test('history sharing retains before dispatch and refuses competing windows or contradictory confirmation', async t => {
  const f = await historyFixture(t), j = new GroupHistoryJournal(f.storage, f.owner, () => true);
  const before = f.calls.length; f.faults.write = true;
  assert.equal(j.keep(f.preview), false); await j.send(f.post, f.get); assert.equal(f.calls.length, before);
  f.faults.write = false; await j.send(f.post, async path => {
    const value = await f.get(path); assert('grant' in value);
    return { ...value, grant: { ...value.grant, membershipId: randomUUID() } };
  });
  assert.equal(j.value.pending?.confirmation, undefined); assert.equal(j.canContinue, false);
  const other = new GroupHistoryJournal(f.storage, f.owner, () => true); await other.observe(f.get);
  assert(other.value.pending?.confirmation); assert.equal(j.retain(), false);
  assert.equal(f.calls.length, before + 1);
});

test('proven history rejection is retained but mismatched proof cannot unlock an uncertain request', async t => {
  const f = await historyFixture(t), j = new GroupHistoryJournal(f.storage, f.owner, () => true);
  j.keep(f.preview);
  await f.post({ action: 'save-draft-v2', requestId: randomUUID(), epoch: f.epoch, groupId: f.groupId,
    scope: { ...f.scope, windowId: randomUUID() }, expectedRaw: null, ...emptyGroupWriting(), text: 'Independent change' });
  await j.send(async c => {
    try { return await f.post(c); } catch (e: any) { throw new ApiError(e.code, e.message, e.current, e.status); }
  }, f.get);
  assert(j.value.pending?.rejection); assert(j.finish());
  const wrong = new GroupHistoryJournal(f.storage, f.owner, () => true); wrong.keep(f.preview);
  await wrong.send(async () => { throw new ApiError('conflict', 'Wrong proof', {
    kind: 'assistant-group-preparation-rejection', command: { ...f.command, requestId: randomUUID() },
  } as any, 409); }, f.get);
  assert.equal(wrong.value.pending?.rejection, undefined); assert.equal(wrong.finish(), false);
});

test('a closed sharing view cannot adopt a late result; its original can be read after reopening', async t => {
  const f = await historyFixture(t); let current = true;
  const j = new GroupHistoryJournal(f.storage, f.owner, () => current); j.keep(f.preview);
  await j.send(async c => { const receipt = await f.post(c); current = false; return receipt; }, f.get);
  assert.equal(j.value.pending?.confirmation, undefined);
  const reload = new GroupHistoryJournal(f.storage, f.owner, () => true); await reload.observe(f.get);
  assert(reload.value.pending?.confirmation);
  await assert.rejects(Promise.resolve().then(() => f.service.read(randomUUID(), {
    view: 'grant-request', groupId: f.groupId, requestId: f.command.requestId,
  })));
});

test('only a never-dispatched history choice can be archived without a receipt or rejection', async t => {
  const f = await historyFixture(t), j = new GroupHistoryJournal(f.storage, f.owner, () => true), before = f.calls.length;
  j.keep(f.preview); assert.equal(j.finish(), false); assert.equal(j.finish(true), true);
  assert.equal(f.calls.length, before); assert(f.rows.has(`${j.key}:original:${f.command.requestId}`));
  const next = { ...f.preview, command: { ...f.command, requestId: randomUUID() } };
  j.keep(next); await j.send(async () => { throw Error('Transport uncertain'); }, f.get);
  assert.equal(j.finish(true), false); assert.equal(j.canContinue, false);
});

test('history sharing UI separates readonly review from explicit share and does not send when opened', async t => {
  const f = await historyFixture(t), before = f.calls.length;
  const app = host(f, () => GroupHistorySharing({ owner: f.owner, groupRevision: f.group.revision, sequence: 2,
    members: f.members, selection: { history: [f.ref], responses: [] }, close() {}, changed() {} }));
  try {
    await app.flush(); assert.equal(app.calls.length, 0);
    nodes(app.tree).find(n => n.type === 'select').props.onChange({ target: { value: f.members[1].id } }); await app.flush();
    button(app.tree, 'Review Exact History').props.onClick(); await app.flush();
    assert.equal(f.calls.length, before); assert(button(app.tree, 'Inspect Message 1'));
    button(app.tree, 'Share This Exact History').props.onClick(); await app.flush();
    assert.equal(f.calls.length, before + 1); assert.match(text(app.tree), /history-sharing choice is saved/);
    await app.flush(); assert.equal(f.calls.length, before + 1);
  } finally { app.close(); }
});

test('recovery UI shows complete writing and opens only after preserving the current editor', async t => {
  const f = fixture(t), owner = { ...f.scope, windowId: randomUUID() };
  write(f.journal, 'Full draft '.repeat(1000)); let prepared = 0, opened = 0, closed = 0;
  const app = host(f, () => GroupMessageRecovery({ scope: owner, prepare: () => { prepared++; return true; },
    opened: () => { opened++; return true; }, close: () => { closed++; } }));
  try {
    await app.flush(); nodes(app.tree).find(n => n.props['aria-pressed'] === false).props.onClick(); await app.flush();
    assert.equal(nodes(app.tree).find(n => n.type === 'pre').props.children, f.journal.value.writing.text);
    button(app.tree, 'Copy Into This Window').props.onClick(); await app.flush();
    assert.equal(prepared, 1); assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(app.calls.length, 0);
  } finally { app.close(); }
});

test('context inspector is readonly and exposes full input without changing selected context', async t => {
  const f = await historyFixture(t), before = f.calls.length;
  let started!: () => void, release!: () => void;
  const hashStarted = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<SubtleCrypto['digest']>) => { started(); await gate; return digest(...args); });
  const app = host(f, () => GroupContextInspector({ epoch: f.epoch, groupId: f.groupId, reference: f.ref, close() {} }));
  try {
    let settled = false; const flushing = app.flush().then(() => { settled = true; });
    await hashStarted; assert.equal(settled, false); assert.doesNotMatch(text(app.tree), /The first complete message/);
    release(); await flushing; assert.match(text(app.tree), /The first complete message/);
    assert.equal(app.calls.every(row => row.method === 'GET'), true); assert.equal(f.calls.length, before);
  } finally { app.close(); }
});
