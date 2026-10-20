import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StudioEditor, studioJournalKey, type StudioScope } from '../apps/client/src/profile-studio-client.js';
import { readProfileSlot, writeProfileSlot } from '../apps/client/src/profile-kept-state.js';
import type { StudioCommand, StudioState } from '../packages/domain/profile-studio.js';

function setup() {
  const scope: StudioScope = { epoch: randomUUID(), device: randomUUID(), window: randomUUID() }, a = randomUUID(), b = randomUUID();
  const state: StudioState = { epoch: scope.epoch, curation: { format: 1, revision: 0, questIds: [] }, availableQuestIds: [], unavailable: [] };
  const values = new Map<string, string>(); let refuseRead = false, refuseWrite = false, loseReadback = false;
  const storage = { getItem(key: string) { if (refuseRead) throw Error('read refused'); return values.get(key) ?? null; }, setItem(key: string, value: string) { if (refuseWrite) throw Error('write refused'); values.set(key, value); if (loseReadback) { refuseRead = true; loseReadback = false; } } };
  const calls: StudioCommand[] = [];
  const receipt = (input: unknown) => { const cmd = input as StudioCommand; return { requestId: cmd.requestId, epoch: cmd.epoch, curation: { format: 1 as const, revision: cmd.expectedRevision + 1, questIds: cmd.questIds } }; };
  const post = async (input: unknown) => { calls.push(structuredClone(input as StudioCommand)); return receipt(input); };
  return { scope, a, b, state, storage, values, calls, post, receipt, key: studioJournalKey(scope),
    readRefusal(value: boolean) { refuseRead = value; }, writeRefusal(value: boolean) { refuseWrite = value; }, loseReadback() { loseReadback = true; } };
}
test('raw-aware slots preserve malformed, unreadable, future-format and foreign-owner journals', () => {
  for (const raw of ['{broken', JSON.stringify({ format: 3 }), JSON.stringify({ format: 1, epoch: randomUUID(), device: 'other', window: 'other', baseRevision: 0, questIds: [], dirty: false })]) {
    const f = setup(); f.values.set(f.key, raw); const editor = new StudioEditor(f.storage, f.scope, f.state, f.post);
    assert(editor.slot.invalid); assert(editor.retain(), 'Read-only unknown bytes can be left intact'); assert(!editor.choose([f.a])); assert.equal(f.values.get(f.key), raw);
  }
  const f = setup(); f.readRefusal(true); const editor = new StudioEditor(f.storage, f.scope, f.state, f.post); f.readRefusal(false); assert(editor.slot.invalid); assert(editor.retain()); assert.equal(f.values.size, 0);
});
test('failed choice retention keeps newer in-memory choices and blocks leaving until durable', () => {
  const f = setup(), editor = new StudioEditor(f.storage, f.scope, f.state, f.post); f.writeRefusal(true);
  assert(!editor.choose([f.a])); assert.deepEqual(editor.journal.questIds, [f.a]); assert(!editor.retain()); assert.equal(f.values.size, 0);
  f.writeRefusal(false); assert(editor.retain()); assert.deepEqual(JSON.parse(f.values.get(f.key)!).questIds, [f.a]);
});
test('CAS protects another owner while exact write followed by lost readback can be acknowledged', () => {
  const f = setup(), editor = new StudioEditor(f.storage, f.scope, f.state, f.post); assert(editor.choose([f.a]));
  const other = f.values.get(f.key)!.replace(f.a, f.b); f.values.set(f.key, other); assert(!editor.choose([f.a, f.b])); assert.equal(f.values.get(f.key), other);
  const g = setup(), next = new StudioEditor(g.storage, g.scope, g.state, g.post); g.loseReadback(); assert(!next.choose([g.a])); g.readRefusal(false); assert(next.retain());
});
test('save persists the exact original before POST; a storage failure never sends', async () => {
  const f = setup(); let observed = false;
  const editor = new StudioEditor(f.storage, f.scope, f.state, async input => { assert.deepEqual(JSON.parse(f.values.get(f.key)!).pending, input); observed = true; return f.post(input); });
  editor.choose([f.a]); f.writeRefusal(true); assert.equal(await editor.save(f.state), undefined); assert.equal(f.calls.length, 0);
  f.writeRefusal(false); const result = await editor.save(f.state); assert(observed); assert.equal(result?.curation.revision, 1); assert.equal(editor.journal.pending, undefined); assert(!editor.journal.dirty);
});
test('lost response and reload retry only the original command without new request identity', async () => {
  const f = setup(), editor = new StudioEditor(f.storage, f.scope, f.state, async input => { f.calls.push(structuredClone(input as StudioCommand)); throw Error('response lost'); });
  editor.choose([f.a]); await editor.save(f.state); const original = editor.journal.pending!; assert(original);
  const next = new StudioEditor(f.storage, f.scope, f.state, f.post); assert.deepEqual(next.journal.pending, original); assert(!next.choose([f.b]));
  await next.save(f.state); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1], f.calls[0]);
});
test('confirmed save with failed local acknowledgement cannot issue another same-window POST', async () => {
  const f = setup(), editor = new StudioEditor(f.storage, f.scope, f.state, async input => { const result = await f.post(input); f.writeRefusal(true); return result; });
  editor.choose([f.a]); assert.equal(await editor.save(f.state), undefined); const original = editor.journal.pending!; assert(original); assert.equal(f.calls.length, 1);
  f.writeRefusal(false); const result = await editor.save(f.state); assert.equal(f.calls.length, 1); assert.equal(result?.requestId, original.requestId); assert.equal(editor.journal.pending, undefined);
});
test('malformed or mismatched response keeps the exact original pending command', async () => {
  for (const change of [(reply: any) => ({ ...reply, requestId: randomUUID() }), (reply: any) => ({ ...reply, epoch: randomUUID() }), (reply: any) => ({ ...reply, curation: { ...reply.curation, revision: 19 } }), (reply: any) => ({ ...reply, curation: { ...reply.curation, questIds: [] } })]) {
    const f = setup(), editor = new StudioEditor(f.storage, f.scope, f.state, async input => change(await f.post(input))); editor.choose([f.a]);
    assert.equal(await editor.save(f.state), undefined); assert(editor.journal.pending); assert.deepEqual(editor.journal.questIds, [f.a]);
  }
});
test('a definite conflict requires explicit current-selection review before a new command', async () => {
  const f = setup(); let conflict = true;
  const editor = new StudioEditor(f.storage, f.scope, f.state, async input => { if (conflict) throw Object.assign(Error('changed'), { status: 409 }); return f.post(input); });
  editor.choose([f.a]); await editor.save(f.state); assert(editor.conflict); assert.equal(editor.journal.pending, undefined); assert.deepEqual(editor.journal.questIds, [f.a]);
  const current: StudioState = { ...f.state, curation: { format: 1, revision: 2, questIds: [f.b] }, availableQuestIds: [f.b] };
  conflict = false; assert.equal(await editor.save(current), undefined); assert.equal(f.calls.length, 0); assert(editor.review(current));
  await editor.save(current); assert.equal(f.calls[0].expectedRevision, 2); assert.deepEqual(f.calls[0].questIds, [f.a]);
});
test('retired and different-epoch owners cannot act or clear a current owner after a late reply', async () => {
  const f = setup(); let release!: (value: unknown) => void;
  const editor = new StudioEditor(f.storage, f.scope, f.state, input => { f.calls.push(structuredClone(input as StudioCommand)); return new Promise(resolve => { release = resolve; }); });
  editor.choose([f.a]); const pending = editor.save(f.state); const raw = f.values.get(f.key); editor.retire(); release(f.receipt(f.calls[0])); await pending;
  assert.equal(f.values.get(f.key), raw); assert(!editor.choose([f.b])); assert.equal(await editor.save(f.state), undefined);
  const next = new StudioEditor(f.storage, f.scope, f.state, f.post); assert.equal(await next.save({ ...f.state, epoch: randomUUID() }), undefined); assert.equal(f.calls.length, 1); assert.equal(f.values.get(f.key), raw);
});
test('unavailable saved selections remain host metadata while explicit editable choices use visible slots', () => {
  const f = setup(), state: StudioState = { ...f.state, curation: { format: 1, revision: 4, questIds: [f.a, f.b] }, unavailable: [{ id: f.a, reason: 'archived' }, { id: f.b, reason: 'missing' }] };
  const editor = new StudioEditor(f.storage, f.scope, state, f.post); assert.deepEqual(editor.journal.questIds, []); assert(editor.journal.dirty); assert.deepEqual(state.curation.questIds, [f.a, f.b]); assert.equal(f.calls.length, 0);
});
test('clean journals adopt current saved selection without a POST, while dirty original proposals survive', async () => {
  const f = setup(), first = new StudioEditor(f.storage, f.scope, f.state, f.post); assert(first.retain());
  const current: StudioState = { ...f.state, curation: { format: 1, revision: 3, questIds: [f.a] }, availableQuestIds: [f.a] };
  const clean = new StudioEditor(f.storage, f.scope, current, f.post); assert.deepEqual(clean.journal.questIds, [f.a]); assert.equal(clean.journal.baseRevision, 3); assert.equal(await clean.save(current), undefined); assert.equal(f.calls.length, 0);
  assert(clean.choose([f.b])); const newer: StudioState = { ...current, curation: { ...current.curation, revision: 4 } };
  const dirty = new StudioEditor(f.storage, f.scope, newer, f.post); assert.deepEqual(dirty.journal.questIds, [f.b]); assert.equal(dirty.journal.baseRevision, 3);
});
test('slot readback failure never authorizes overwriting different later bytes', () => {
  const f = setup(), slot = readProfileSlot(f.storage, 'metadata', { text: '' }, (value): value is { text: string } => !!value && typeof value === 'object' && 'text' in value && typeof value.text === 'string');
  f.loseReadback(); assert.throws(() => writeProfileSlot(f.storage, slot, { text: 'new writing' })); f.readRefusal(false); f.values.set('metadata', JSON.stringify({ text: 'other owner' }));
  assert.throws(() => writeProfileSlot(f.storage, slot, { text: 'new writing' }), /another window/); assert.equal(JSON.parse(f.values.get('metadata')!).text, 'other owner');
});
