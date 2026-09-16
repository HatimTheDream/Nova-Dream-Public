import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../apps/service/http.js';
import type { ReviewApproval } from '../packages/domain/approvals.js';

test('chat and assignment HTTP feeds retain their own approvals without an unopenable conversation link', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-approval-routing-')), host = await startServer({ directory, port: 0 });
  try {
    const chatId = randomUUID(), assignmentId = randomUUID(), orphanId = randomUUID();
    const chat = { id: chatId, revision: 1, title: 'Chat review', projectId: null, archived: false, model: null, thinking: null, createdAt: '', updatedAt: '', connectionGeneration: 'fixture', nativeKey: 'fixture-chat', nativeId: randomUUID(), state: 'ready' as const };
    host.store.internalWrite('assistant:conversation:' + chatId, chat);
    const items: ReviewApproval[] = [chatId, assignmentId, orphanId].map((conversationId, i) => ({ id: String(i).repeat(64), revision: 1, epoch: host.store.epoch, connectionGeneration: 'fixture', conversationId, nativeId: randomUUID(), nativeKey: 'fixture-' + i, updatedAtMs: Date.now(), snapshot: { id: randomUUID(), status: 'pending', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000, presentation: { kind: 'exec', commandText: 'Fixture only', allowedDecisions: ['allow-once', 'deny'] } } }));
    // Controlled provider feed: test the real authenticated HTTP routing, with
    // no native effect or permission grant.
    host.approvals.state = () => ({ state: 'ready', items });
    host.assignments.approvalTargets = () => [{ ...chat, id: assignmentId, nativeKey: 'fixture-worker' }];
    const session = await fetch(host.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const read = async (path: string) => { const response = await fetch(host.origin + '/api/' + path, { headers: { cookie } }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); };
    assert.deepEqual((await read('assistant/state')).approvals.items, [items[0]]);
    assert.deepEqual((await read('assignments/approvals')).items, [items[1]]);
    assert.equal((await fetch(host.origin + '/api/assignments/approvals')).status, 401);
    assert.equal((await fetch(host.origin + '/api/assistant/state')).status, 401);
    assert.equal(items.length, 3); // Unrelated history was not deleted.
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});
