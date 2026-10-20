import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { blankRecord, type AgentDesign } from '../packages/domain/workspace-records';
import { emptyDraft } from '../packages/domain/contracts';
import type { AssistantState, Conversation, AssistantOperation } from '../packages/domain/assistant';
import {
  DirectChatCommands, DirectChatNavigation, createDirectChat, continueDirectChat, confirmedDirectConversation,
  keepDirectChatSelection, observedDirectSubmit, readDirectSelection, settleDirectSelection, hasKeptDirectSubmit, type DirectChatScope, type DirectChatTarget,
} from '../apps/client/src/direct-agent-chat';

const scope: DirectChatScope = { epoch: randomUUID(), deviceId: 'device', windowId: 'window' };
const recipient = { agentId: 'agent:one', agentRevision: 3 };
const design = { ...blankRecord('agent', 'UTC') as AgentDesign, name: 'Same Name', position: 'Researcher', archived: false };
class Storage {
  rows = new Map<string, string>(); writes: string[] = [];
  failed = ''; denied = '';
  getItem(key: string) { if (key === this.denied) throw Error('read denied'); return this.rows.get(key) ?? null; }
  setItem(key: string, value: string) { if (key === this.failed) throw Error('full'); this.rows.set(key, value); this.writes.push(key); }
  removeItem(key: string) { if (key === this.failed) throw Error('full'); this.rows.delete(key); this.writes.push(key); }
}
function conversation(requestId: string): Conversation {
  return { id: randomUUID(), revision: 1, title: 'Same Name', space: 'chat', permissionMode: 'read-only', projectId: null,
    archived: false, model: null, thinking: null, connectionGeneration: '', nativeKey: '', nativeId: null,
    state: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    directAgent: { format: 1, recipient, design, createdBy: { requestId, epoch: scope.epoch, deviceId: scope.deviceId } } };
}
const state = (conversations: Conversation[] = [], operations: AssistantOperation[] = []): AssistantState => ({
  connection: { state: 'unconfigured', message: '', methods: [], grantedScopes: [], modelAuthReady: false }, conversations, operations,
});
const target = (): DirectChatTarget => ({ format: 1, scope, recipient, token: randomUUID(), origin: 'agents', previousSelection: { space: 'chat', id: null } });

test('reading valid, missing or malformed retained commands never sends or overwrites', () => {
  for (const raw of [null, '{', JSON.stringify({ format: 1 }), JSON.stringify({ scope: { ...scope, epoch: randomUUID() } })]) {
    const storage = new Storage(); if (raw !== null) storage.rows.set('command', raw);
    const owner = new DirectChatCommands(storage, 'command', scope, recipient);
    assert.deepEqual(storage.writes, []);
    assert.equal(!!owner.error, raw !== null);
    assert.equal(storage.getItem('command'), raw);
  }
});
test('actual denied read and failed original command write refuse before POST', async () => {
  for (const deny of [true, false]) {
    const storage = new Storage(); if (deny) storage.denied = 'command'; else storage.failed = 'command';
    const owner = new DirectChatCommands(storage, 'command', scope, recipient);
    let calls = 0;
    await owner.send(createDirectChat(scope, recipient, design.name, randomUUID()), async () => { calls++; }, () => true);
    assert.equal(calls, 0); assert.equal(storage.rows.size, 0); assert.ok(owner.error);
  }
});
test('unknown creation remains the same original request across reload; explicit check joins exact saved origin', async () => {
  const storage = new Storage(), requestId = randomUUID(), original = createDirectChat(scope, recipient, design.name, requestId);
  let calls = 0;
  const owner = new DirectChatCommands(storage, 'command', scope, recipient);
  await owner.send(original, async () => { calls++; throw Error('lost response'); }, () => true);
  const kept = storage.getItem('command');
  const reopened = new DirectChatCommands(storage, 'command', scope, recipient);
  await reopened.send(createDirectChat(scope, recipient, design.name, randomUUID()), async () => { calls++; }, () => true);
  assert.equal(calls, 1); assert.equal(storage.getItem('command'), kept);
  const wrong = conversation(randomUUID()); assert.equal(reopened.observe(state([wrong])), undefined);
  const actual = conversation(requestId);
  assert.equal(reopened.observe(state([wrong, actual]))?.id, actual.id);
  assert.equal(reopened.value?.confirmation?.conversationId, actual.id);
  assert.equal(calls, 1);
});
test('same-name recipient, foreign device/epoch and ambiguous saved origin do not confirm a create', async () => {
  const storage = new Storage(), requestId = randomUUID(), owner = new DirectChatCommands(storage, 'command', scope, recipient);
  await owner.send(createDirectChat(scope, recipient, design.name, requestId), async () => { throw Error('unknown'); }, () => true);
  const actual = conversation(requestId);
  for (const wrong of [
    { ...actual, directAgent: { ...actual.directAgent!, recipient: { ...recipient, agentId: 'agent:two' } } },
    { ...actual, directAgent: { ...actual.directAgent!, createdBy: { ...actual.directAgent!.createdBy, deviceId: 'other' } } },
    { ...actual, directAgent: { ...actual.directAgent!, createdBy: { ...actual.directAgent!.createdBy, epoch: randomUUID() } } },
  ]) assert.equal(confirmedDirectConversation(owner.value!, wrong), undefined);
  assert.equal(owner.observe(state([actual, { ...actual, id: randomUUID() } ])), undefined);
});
test('valid reply with local storage failure is retained without POST on the next keep', async () => {
  const storage = new Storage(), requestId = randomUUID(), owner = new DirectChatCommands(storage, 'command', scope, recipient);
  let calls = 0; const actual = conversation(requestId);
  await owner.send(createDirectChat(scope, recipient, design.name, requestId), async () => { calls++; storage.failed = 'command'; return actual; }, () => true);
  assert.equal(owner.value?.confirmation, undefined); assert.equal(owner.retain(), false);
  storage.failed = ''; assert.equal(owner.retain(), true);
  assert.equal(JSON.parse(storage.getItem('command')!).confirmation.conversationId, actual.id); assert.equal(calls, 1);
});
test('late response cannot overwrite an intervening original request', async () => {
  const storage = new Storage(), requestId = randomUUID(), owner = new DirectChatCommands(storage, 'command', scope, recipient);
  let finish!: (value: unknown) => void;
  const pending = owner.send(createDirectChat(scope, recipient, design.name, requestId), () => new Promise(resolve => { finish = resolve; }), () => true);
  const newer = JSON.stringify({ retained: 'other owner writing' }); storage.rows.set('command', newer);
  finish(conversation(requestId)); await pending;
  assert.equal(storage.getItem('command'), newer); assert.equal(owner.retain(), false);
});
test('rapid second click and stale view do not start a second command', async () => {
  const storage = new Storage(), requestId = randomUUID(), owner = new DirectChatCommands(storage, 'command', scope, recipient);
  let calls = 0, finish!: (value: unknown) => void;
  const pending = owner.send(createDirectChat(scope, recipient, design.name, requestId), () => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => true);
  await owner.send(createDirectChat(scope, recipient, design.name, randomUUID()), async () => { calls++; }, () => true);
  finish(conversation(requestId)); await pending; assert.equal(calls, 1);
  const other = new DirectChatCommands(storage, 'other', scope, recipient);
  await other.send(createDirectChat(scope, recipient, design.name, randomUUID()), async () => { calls++; }, () => false);
  assert.equal(calls, 1); assert.equal(storage.getItem('other'), null);
});
test('new separate chat is explicit and preserves a confirmed original before clearing the current pointer', async () => {
  const storage = new Storage(), requestId = randomUUID(), owner = new DirectChatCommands(storage, 'command', scope, recipient);
  await owner.send(createDirectChat(scope, recipient, design.name, requestId), async () => conversation(requestId), () => true);
  const original = storage.getItem('command');
  storage.failed = `command:confirmed:${requestId}`; assert.equal(owner.beginAnother(), false);
  assert.equal(storage.getItem('command'), original);
  storage.failed = ''; assert.equal(owner.beginAnother(), true);
  assert.equal(storage.getItem(`command:confirmed:${requestId}`), original); assert.equal(storage.getItem('command'), 'null');
});
test('Continue requires exact current proven-unsent projection; absent capped rows grant nothing', () => {
  const row = conversation(randomUUID()), originalRequestId = randomUUID();
  const status = { conversationId: row.id, conversationRevision: row.revision, setupRevision: 1,
    originalRequestId, setupSha256: 'a'.repeat(64), state: 'failed' as const, canContinueUnsent: true };
  const command = continueDirectChat(scope, row, status, randomUUID());
  assert.equal(command.kind, 'continue'); assert.equal((command.body as any).originalRequestId, originalRequestId);
  for (const changed of [undefined, { ...status, state: 'unknown' as const }, { ...status, conversationRevision: 2 }, { ...status, canContinueUnsent: false }])
    assert.throws(() => continueDirectChat(scope, row, changed, randomUUID()));
  assert.throws(() => continueDirectChat(scope, { ...row, nativeId: randomUUID() }, status, randomUUID()));
});
test('retained route entry and return require exact token, raw storage and retained editor', () => {
  const storage = new Storage(), navigation = new DirectChatNavigation(storage, 'view', scope), first = target();
  assert.equal(navigation.set(first, () => false), false); assert.equal(storage.rows.size, 0);
  assert.equal(navigation.set(first, () => true), true);
  const second = target(); assert.equal(navigation.set(second, () => true), true);
  assert.equal(navigation.set(undefined, () => true, first.token), false);
  assert.deepEqual(navigation.value, second);
  storage.failed = 'view'; assert.equal(navigation.set(undefined, () => true, second.token), false);
  assert.deepEqual(navigation.value, second);
});
test('malformed existing route/selection metadata is preserved without destination writes', () => {
  const storage = new Storage(); storage.rows.set('view', '{invalid');
  assert.equal(new DirectChatNavigation(storage, 'view', scope).set(target(), () => true), false);
  storage.rows.set(`e3:conversation:${scope.deviceId}`, '{"originalDraft":"kept"}');
  assert.equal(keepDirectChatSelection(storage, scope.epoch, scope.deviceId, randomUUID()), false);
  assert.deepEqual(storage.writes, []);
});
test('exact GET-observed submit joins original payload and request, never another operation', () => {
  const row = conversation(randomUUID()), requestId = randomUUID(), draftId = `draft:${scope.deviceId}:${row.id}`;
  const captured = { ...emptyDraft, conversationId: row.id, text: 'Original writing' };
  const pending = { request: { requestId, epoch: scope.epoch, conversationId: row.id, conversationRevision: row.revision, draftId, draftRevision: 2, projectRevision: 0 }, captured };
  const operation = { id: randomUUID(), requestId, epoch: scope.epoch, deviceId: scope.deviceId, conversationId: row.id,
    conversationRevision: row.revision, input: captured.text, context: { draftId, draftRevision: 2, attachments: [], directAgent: { conversationId: row.id, requestId, recipient } } } as unknown as AssistantOperation;
  assert.equal(observedDirectSubmit(pending, state([row], [operation]), scope, row)?.operation.id, operation.id);
  for (const wrong of [{ ...operation, requestId: randomUUID() }, { ...operation, deviceId: 'other' }, { ...operation, input: 'Newer writing' }])
    assert.equal(observedDirectSubmit(pending, state([row], [wrong]), scope, row), undefined);
});

test('direct request presence preserves malformed and unreadable originals as reconciliation boundaries', () => {
  const storage = new Storage(); assert.equal(hasKeptDirectSubmit(storage, 'submit'), false);
  for (const raw of ['{', 'null', '{}']) { storage.rows.set('submit', raw); assert.equal(hasKeptDirectSubmit(storage, 'submit'), true); }
  storage.denied = 'submit'; assert.equal(hasKeptDirectSubmit(storage, 'submit'), true);
  assert.deepEqual(storage.writes, []);
});

test('failed second selection or target write restores exact original active Chat pointers', () => {
  for (const fail of ['space', 'view']) {
    const storage = new Storage(), oldId = randomUUID(), nextId = randomUUID();
    const spaceKey = `e3:assistant-space:${scope.epoch}:${scope.deviceId}`, selected = `e3:conversation:${scope.deviceId}`;
    const viewKey = `e3:direct-chat-view:${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
    storage.rows.set(spaceKey, '"chat"'); storage.rows.set(selected, JSON.stringify(oldId));
    const nav = new DirectChatNavigation(storage, viewKey, scope), first = target(); assert.equal(nav.set(first, () => true), true);
    const prepared = nav.prepare({ ...first, conversationId: nextId }, () => true, first.token)!;
    const before = new Map(storage.rows); storage.failed = fail === 'space' ? spaceKey : viewKey;
    assert.equal(keepDirectChatSelection(storage, scope.epoch, scope.deviceId, nextId, 'chat', prepared), false);
    assert.deepEqual(storage.rows, before); assert.equal(nav.value?.conversationId, undefined);
  }
});

test('failed rollback retains original reload selection and refuses an intervening owner', () => {
  const storage = new Storage(), oldId = randomUUID(), nextId = randomUUID();
  const spaceKey = `e3:assistant-space:${scope.epoch}:${scope.deviceId}`, selected = `e3:conversation:${scope.deviceId}`;
  storage.rows.set(spaceKey, '"chat"'); storage.rows.set(selected, JSON.stringify(oldId));
  const originalSet = storage.setItem.bind(storage); let blocked = true;
  storage.setItem = (key, value) => {
    if (blocked && (key === spaceKey || key === selected && value === JSON.stringify(oldId))) throw Error('full');
    originalSet(key, value);
  };
  assert.equal(keepDirectChatSelection(storage, scope.epoch, scope.deviceId, nextId), false);
  assert.equal(storage.getItem(selected), JSON.stringify(nextId), 'physical partial write remains honestly recorded');
  assert.equal(readDirectSelection(storage, scope.epoch, scope.deviceId)?.id, oldId, 'reload uses original authority');
  assert.equal(settleDirectSelection(storage, scope.epoch, scope.deviceId), false);
  blocked = false; const newer = JSON.stringify(randomUUID()); storage.rows.set(selected, newer);
  assert.equal(settleDirectSelection(storage, scope.epoch, scope.deviceId), false); assert.equal(storage.getItem(selected), newer);
  storage.rows.set(selected, JSON.stringify(nextId)); assert.equal(settleDirectSelection(storage, scope.epoch, scope.deviceId), true);
  assert.equal(storage.getItem(selected), JSON.stringify(oldId)); assert.equal(readDirectSelection(storage, scope.epoch, scope.deviceId), undefined);
});

test('a committed marker whose cleanup is refused remains exact successful reload authority', () => {
  const storage = new Storage(), id = randomUUID();
  storage.failed = `e3:direct-selection:${scope.epoch}:${scope.deviceId}`;
  // Refuse only removal, after all writes and the durable commit.
  storage.setItem = (key, value) => { storage.rows.set(key, value); };
  assert.equal(keepDirectChatSelection(storage, scope.epoch, scope.deviceId, id), true);
  assert.deepEqual(readDirectSelection(storage, scope.epoch, scope.deviceId), { space: 'chat', id, error: '' });
  storage.failed = ''; assert.equal(settleDirectSelection(storage, scope.epoch, scope.deviceId), true);
});


test('direct view publication requires exact readback after a dropped or changed write', () => {
  for (const fault of ['drop', 'change']) {
    const storage = new Storage(), nav = new DirectChatNavigation(storage, 'view', scope), first = target();
    assert.equal(nav.set(first, () => true), true); const original = storage.getItem('view'), replacement = JSON.stringify(target());
    storage.setItem = (key, _value) => { if (fault === 'change') storage.rows.set(key, replacement); };
    assert.equal(nav.set(target(), () => true, first.token), false); assert.deepEqual(nav.value, first);
    assert.equal(storage.getItem('view'), fault === 'drop' ? original : replacement);
  }
});

test('selection refuses dropped final commits and preserves a replacement marker without publishing', () => {
  for (const fault of ['drop', 'change']) {
    const storage = new Storage(), old = randomUUID(), next = randomUUID();
    const selected = `e3:conversation:${scope.deviceId}`, space = `e3:assistant-space:${scope.epoch}:${scope.deviceId}`, marker = `e3:direct-selection:${scope.epoch}:${scope.deviceId}`;
    const view = `e3:direct-chat-view:${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
    storage.rows.set(selected, JSON.stringify(old)); storage.rows.set(space, '"chat"');
    let accepted = false, replaced: string | undefined;
    storage.setItem = (key, value) => {
      if (key === marker && JSON.parse(value).phase === 'committed') {
        if (fault === 'change') { replaced = JSON.stringify({ ...JSON.parse(value), id: randomUUID(), phase: 'pending' }); storage.rows.set(key, replaced!); }
        return;
      }
      storage.rows.set(key, value);
    };
    assert.equal(keepDirectChatSelection(storage, scope.epoch, scope.deviceId, next, 'chat', { write: { key: view, before: null, after: 'null' }, accept() { accepted = true; } }), false);
    assert.equal(accepted, false);
    if (fault === 'drop') { assert.equal(storage.getItem(selected), JSON.stringify(old)); assert.equal(storage.getItem(marker), null); }
    else { assert.equal(storage.getItem(marker), replaced); assert.equal(storage.getItem(selected), JSON.stringify(next)); }
  }
});

test('a final commit with changed destination bytes is not published or trusted on reload', () => {
  const storage = new Storage(), selected = `e3:conversation:${scope.deviceId}`, marker = `e3:direct-selection:${scope.epoch}:${scope.deviceId}`;
  const intervening = JSON.stringify(randomUUID()); let accepted = false;
  storage.setItem = (key, value) => { storage.rows.set(key, value); if (key === marker && JSON.parse(value).phase === 'committed') storage.rows.set(selected, intervening); };
  const view = `e3:direct-chat-view:${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
  assert.equal(keepDirectChatSelection(storage, scope.epoch, scope.deviceId, randomUUID(), 'chat', { write: { key: view, before: null, after: 'null' }, accept() { accepted = true; } }), false);
  assert.equal(accepted, false); assert.equal(storage.getItem(selected), intervening); assert.ok(storage.getItem(marker));
  assert.ok(readDirectSelection(storage, scope.epoch, scope.deviceId)?.error); assert.equal(settleDirectSelection(storage, scope.epoch, scope.deviceId), false);
});

test('rollback verifies each restored slot and its final aggregate before removing original authority', () => {
  for (const fault of ['dropped restore', 'intervening restored slot']) {
    const storage = new Storage(), selected = `e3:conversation:${scope.deviceId}`, space = `e3:assistant-space:${scope.epoch}:${scope.deviceId}`, marker = `e3:direct-selection:${scope.epoch}:${scope.deviceId}`;
    const before = JSON.stringify(randomUUID()), after = JSON.stringify(randomUUID());
    const raw = JSON.stringify({ format: 1, epoch: scope.epoch, deviceId: scope.deviceId, id: randomUUID(), phase: 'pending', writes: [{ key: selected, before, after }, { key: space, before: '"work"', after: '"chat"' }] });
    storage.rows.set(marker, raw); storage.rows.set(selected, after); storage.rows.set(space, '"chat"');
    storage.setItem = (key, value) => { if (key === selected && fault === 'dropped restore') return; storage.rows.set(key, value); if (key === selected && fault === 'intervening restored slot') storage.rows.set(space, '"intervening"'); };
    assert.equal(settleDirectSelection(storage, scope.epoch, scope.deviceId), false); assert.equal(storage.getItem(marker), raw);
    assert.equal(storage.getItem(selected), fault === 'dropped restore' ? after : before);
    if (fault === 'intervening restored slot') assert.equal(storage.getItem(space), '"intervening"');
  }
});

test('rollback verifies marker removal and preserves an intervening replacement', () => {
  for (const fault of ['drop', 'change']) {
    const storage = new Storage(), selected = `e3:conversation:${scope.deviceId}`, space = `e3:assistant-space:${scope.epoch}:${scope.deviceId}`, marker = `e3:direct-selection:${scope.epoch}:${scope.deviceId}`;
    const before = JSON.stringify(randomUUID()), after = JSON.stringify(randomUUID());
    const raw = JSON.stringify({ format: 1, epoch: scope.epoch, deviceId: scope.deviceId, id: randomUUID(), phase: 'pending', writes: [{ key: selected, before, after }, { key: space, before: '"chat"', after: '"chat"' }] });
    storage.rows.set(marker, raw); storage.rows.set(selected, after); storage.rows.set(space, '"chat"');
    const replacement = JSON.stringify({ ...JSON.parse(raw), id: randomUUID() });
    storage.removeItem = key => { if (key === marker) { if (fault === 'change') storage.rows.set(key, replacement); } else storage.rows.delete(key); };
    assert.equal(settleDirectSelection(storage, scope.epoch, scope.deviceId), false);
    assert.equal(storage.getItem(selected), before); assert.equal(storage.getItem(marker), fault === 'drop' ? raw : replacement);
  }
});


test('commit cleanup cannot publish or retire a replacement selection marker', () => {
  const storage = new Storage(), marker = `e3:direct-selection:${scope.epoch}:${scope.deviceId}`;
  let replacement = '', accepted = false;
  storage.removeItem = key => {
    if (key === marker) { replacement = JSON.stringify({ ...JSON.parse(storage.getItem(key)!), id: randomUUID() }); storage.rows.set(key, replacement); }
    else storage.rows.delete(key);
  };
  const view = `e3:direct-chat-view:${scope.epoch}:${scope.deviceId}:${scope.windowId}`;
  assert.equal(keepDirectChatSelection(storage, scope.epoch, scope.deviceId, randomUUID(), 'chat', { write: { key: view, before: null, after: 'null' }, accept() { accepted = true; } }), false);
  assert.equal(accepted, false); assert.equal(storage.getItem(marker), replacement);
});
