import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/store.js';
import { captureTeamHandoff, readTeamHandoff, teamHandoffMetadata } from '../apps/service/team-handoffs.js';
import type { AssistantOperation } from '../packages/domain/assistant.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-handoff-'));
  let store = new Store(directory);
  const operation: AssistantOperation = {
    id: randomUUID(), requestId: randomUUID(), deviceId: store.session().deviceId, epoch: store.epoch, conversationId: randomUUID(), conversationRevision: 1,
    connectionGeneration: randomUUID(), nativeKey: 'agent:main:e3:' + randomUUID(), nativeId: randomUUID(), nativeRunId: randomUUID(), state: 'completed', input: 'Inspect the repository',
    context: { project: null, attachments: [], draftId: 'fixture', draftRevision: 1, digest: 'a'.repeat(64) }, model: null, thinking: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), text: '', lastSequence: 1,
  };
  const identity = { epoch: store.epoch, teamId: randomUUID(), stage: 0, attempt: 1, operation };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, operation, identity, restart() { store.close(); store = new Store(directory); } };
}

test('complete Unicode handoffs remain retrievable beyond both prior cutoffs with bounded pages', t => {
  const f = fixture(t);
  f.operation.text = '🧭'.repeat(15001) + 'x'.repeat(17000) + '\nCritical final constraint: preserve the owner’s files.\n👩🏽‍💻';
  const handoff = captureTeamHandoff(f.store, f.identity, 1000);
  assert.equal(handoff.characters, Array.from(f.operation.text).length);
  assert.equal(handoff.bytes, Buffer.byteLength(f.operation.text));
  assert.equal(handoff.sha256, createHash('sha256').update(f.operation.text).digest('hex'));
  let offset: number | null = 0, reconstructed = '', pages = 0;
  while (offset !== null) {
    const page = readTeamHandoff(f.store, f.identity.teamId, handoff.id, offset, 12000);
    assert.equal(page.offset, offset); assert(Array.from(page.text).length <= 12000);
    assert.equal(page.sha256, handoff.sha256); assert.equal(page.text.includes('\uFFFD'), false);
    reconstructed += page.text; offset = page.nextOffset; pages++;
  }
  assert(pages >= 3); assert.equal(reconstructed, f.operation.text);
  assert.match(reconstructed.slice(20000), /Critical final constraint/);
  const one = readTeamHandoff(f.store, f.identity.teamId, handoff.id, 0, 1);
  assert.equal(one.text, '🧭'); assert.equal(one.nextOffset, 1);
  assert.equal(readTeamHandoff(f.store, f.identity.teamId, handoff.id, handoff.characters).text, '');
});

test('first immutable snapshot survives late text changes, conversation removal and restart', t => {
  const f = fixture(t); f.operation.text = 'Original saved result';
  f.store.internalWrite('assistant:operation:' + f.operation.id, f.operation);
  const original = captureTeamHandoff(f.store, f.identity, 1000);
  f.operation.text = 'Later observation must not replace the original'; f.operation.state = 'failed';
  assert.deepEqual(captureTeamHandoff(f.store, f.identity, 2000), original);
  f.store.removeConversationData(f.operation.conversationId);
  assert.equal(f.store.internalRead('assistant:operation:' + f.operation.id), undefined);
  f.restart();
  assert.deepEqual(teamHandoffMetadata(f.store, f.identity.teamId, original.id), original);
  assert.equal(readTeamHandoff(f.store, f.identity.teamId, original.id).text, 'Original saved result');
});

test('handoff capture rejects unsettled work, stale epochs and reused execution identity', t => {
  const f = fixture(t); f.operation.state = 'unknown';
  assert.throws(() => captureTeamHandoff(f.store, f.identity), /Confirm the original/);
  f.operation.state = 'failed'; f.operation.text = 'Partial output retained';
  const original = captureTeamHandoff(f.store, f.identity);
  assert.equal(original.state, 'failed');
  assert.throws(() => captureTeamHandoff(f.store, { ...f.identity, epoch: randomUUID() }), /different workspace/);
  assert.throws(() => captureTeamHandoff(f.store, { ...f.identity, stage: 1 }), /different execution/);
  assert.throws(() => captureTeamHandoff(f.store, { ...f.identity, operation: { ...f.operation, nativeId: randomUUID() } }), /different execution/);
  assert.throws(() => captureTeamHandoff(f.store, { ...f.identity, operation: { ...f.operation, nativeRunId: randomUUID() } }), /different execution/);
  assert.throws(() => readTeamHandoff(f.store, randomUUID(), original.id), /unavailable/);
  assert.throws(() => readTeamHandoff(f.store, f.identity.teamId, original.id, original.characters + 1), /offset/);
  assert.throws(() => readTeamHandoff(f.store, f.identity.teamId, original.id, 0, 24001));
  const saved = f.store.internalRead<Record<string, unknown>>('team:handoff:' + original.id)!;
  f.store.internalWrite('team:handoff:' + original.id, { ...saved, text: 'Corrupted text' });
  assert.throws(() => readTeamHandoff(f.store, f.identity.teamId, original.id), /original content/);
});

test('a confirmed pre-dispatch failure keeps its handoff without requiring a native run', t => {
  const f = fixture(t); f.operation.state = 'failed'; f.operation.nativeId = 'external-session'; f.operation.nativeRunId = null;
  f.operation.text = 'No changes were executed.';
  const handoff = captureTeamHandoff(f.store, f.identity);
  assert.equal(handoff.state, 'failed');
  assert.equal(readTeamHandoff(f.store, f.identity.teamId, handoff.id).text, f.operation.text);
});
