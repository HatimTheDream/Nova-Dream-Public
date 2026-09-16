import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ConnectedAccount } from '../packages/domain/accounts';
import type { MailIndexCommand, MailIndexResult } from '../packages/domain/mail-index';
import { createMailIndexSnapshot } from '../packages/domain/dreamclaw/mail-index';
import { createInboxMailApi, installInboxMailApi, type InboxMailContext } from '../apps/client/src/dreamclaw/inbox-transport';
import type { InboxIndexTransport } from '../apps/client/src/dreamclaw/inbox-index-transport';
import { getNativeMailIndexSnapshot } from '../apps/client/src/dreamclaw/services/native/mailIndex';
import { loadInboxFolder, useInboxSessionStore, reconcileInboxAccountSnapshots } from '../apps/client/src/dreamclaw/services/inbox/inboxSession';

const stamp = '2026-09-08T16:00:00Z';
function fixture(transport: (owner: ConnectedAccount, run: string) => InboxIndexTransport) {
  const owner: ConnectedAccount = { id: randomUUID(), generation: randomUUID(), provider: 'google', subject: 'fixture', email: 'studio@example.test', label: 'Studio', revision: 1, state: 'connected', scopes: [], capabilities: { mailRead: true, mailDraft: false, mailSend: false, calendarRead: false, calendarWrite: false, contactsRead: false }, connectedAt: stamp, updatedAt: stamp };
  const context: InboxMailContext = { epoch: randomUUID(), deviceId: randomUUID(), accounts: { clients: [], accounts: [owner], attempts: [], probes: [] } };
  const run = randomUUID(), api = createInboxMailApi(context, async () => { throw new Error('Unexpected ordinary mail read'); }, transport(owner, run));
  return { api, owner, run, identity: { provider: 'gmail' as const, accountId: owner.id }, context };
}
function result(owner: ConnectedAccount, run: string, revision: number, status: 'indexing' | 'paused' | 'complete' = 'indexing'): MailIndexResult {
  return { accountId: owner.id, generation: owner.generation, runId: run, revision: `${run}.${revision}`, snapshot: { ...createMailIndexSnapshot('gmail', owner.id, stamp), status, exhausted: status === 'complete', pagesIndexed: revision, threads: [{ id: `mail-${revision}`, sourceMessageId: `source-${revision}`, subject: `Planning ${revision}`, from: 'maya@example.test', date: stamp, labels: ['INBOX'], providerTags: [], messageCount: 1, category: 'other', summary: '', latestBody: '', latestSnippet: '', attentionScore: 0 }] } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function eventually(check: () => boolean) { const deadline = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 2)); } }

test('older in-flight index reads cannot replace a newer rebuilt run or notify stale progress', async () => {
  const old = deferred<MailIndexResult>(); let calls = 0;
  const f = fixture((owner, run) => ({ read: async () => ++calls === 1 ? result(owner, run, 1) : old.promise, command: async () => result(owner, randomUUID(), 3) }));
  const progress: number[] = [], off = f.api.mailIndex!.onProgress(snapshot => progress.push(snapshot.indexRevision!));
  try {
    await f.api.mailIndex!.getSnapshot(f.identity);
    const waiting = f.api.mailIndex!.getSnapshot(f.identity);
    const rebuilt = await f.api.mailIndex!.sync({ ...f.identity, mode: 'rebuild' });
    assert.equal(rebuilt.snapshot?.indexRevision, 3);
    old.resolve(result(f.owner, f.run, 2));
    assert.equal((await waiting).snapshot?.indexRevision, 3);
    assert.deepEqual(progress, [1, 3]);
  } finally { off(); f.api.dispose(); }
});

test('lost command responses retry the exact receipt and serialized pause binds to the new run', async () => {
  const calls: MailIndexCommand[] = [], newRun = randomUUID();
  const f = fixture((owner, run) => ({ read: async () => result(owner, run, 1), command: async input => {
    calls.push(input); if (calls.length === 1) throw new TypeError('Response lost after admission');
    return result(owner, newRun, input.action === 'pause' ? 4 : 3, input.action === 'pause' ? 'paused' : 'indexing');
  } }));
  try {
    const sync = f.api.mailIndex!.sync({ ...f.identity, mode: 'rebuild' });
    const pause = f.api.mailIndex!.pause(f.identity);
    assert.equal((await sync).success, true); assert.equal((await pause).snapshot?.status, 'paused');
    assert.deepEqual(calls[0], calls[1]); assert.equal(calls[2].expectedRunId, newRun);
    assert.notEqual(calls[1].requestId, calls[2].requestId);
  } finally { f.api.dispose(); }
});

test('progress polls revision tokens, skips unchanged payloads and stops when unsubscribed', async () => {
  const requested: (string | undefined)[] = [];
  const f = fixture((owner, run) => ({ pollMs: 2, read: async input => {
    requested.push(input.revision);
    if (requested.length === 1) return result(owner, run, 1);
    if (requested.length === 2) return result(owner, run, 2, 'complete');
    return { accountId: owner.id, generation: owner.generation, runId: run, revision: `${run}.2`, unchanged: true };
  }, command: async () => { throw new Error('Unexpected control'); } }));
  const progress: number[] = [], off = f.api.mailIndex!.onProgress(snapshot => progress.push(snapshot.indexRevision!));
  try {
    await f.api.mailIndex!.getSnapshot(f.identity);
    await eventually(() => requested.length >= 3);
    assert.deepEqual(progress, [1, 2]); assert.equal(requested[1], `${f.run}.1`); assert.equal(requested[2], `${f.run}.2`);
    off(); const count = requested.length; await new Promise(resolve => setTimeout(resolve, 12)); assert.equal(requested.length, count);
  } finally { off(); f.api.dispose(); }
});

test('connection replacement aborts the original native wrapper and rejects late account data', async () => {
  const late = deferred<MailIndexResult>(); let signal: AbortSignal | undefined;
  const f = fixture(() => ({ read: async (_input, captured) => { signal = captured; return late.promise; }, command: async () => { throw new Error('Unexpected control'); } }));
  const close = installInboxMailApi(f.api);
  const pending = getNativeMailIndexSnapshot('gmail', f.owner.id);
  const rejected = assert.rejects(pending);
  close(); assert.equal(signal?.aborted, true); late.resolve(result(f.owner, f.run, 1)); await rejected;
  const bad = fixture((owner, run) => ({ read: async () => ({ ...result(owner, run, 1), generation: randomUUID() }), command: async () => { throw new Error('Unexpected control'); } }));
  try { assert.equal((await bad.api.mailIndex!.getSnapshot(bad.identity)).success, false); } finally { bad.api.dispose(); }
});

test('the original Inbox opens a paused searchable index without resuming it, and ignores older multi-account load results', async () => {
  let commands = 0;
  const f = fixture((owner, run) => ({ read: async () => result(owner, run, 4, 'paused'), command: async () => { commands++; return result(owner, run, 5); } }));
  const close = installInboxMailApi(f.api);
  try {
    await loadInboxFolder('inbox');
    const folder = useInboxSessionStore.getState().folders.inbox;
    assert.equal(folder.loaded, true); assert.equal(commands, 0); assert.equal(folder.snapshots[0].indexStatus, 'paused');
    assert.equal(folder.snapshots[0].threads[0].sourceMessageId, 'source-4');
    const snapshot = folder.snapshots[0];
    const merged = reconcileInboxAccountSnapshots([snapshot], [{ ...snapshot, indexRevision: 3, threads: [] }], [snapshot.account]);
    assert.equal(merged[0], snapshot);
    await loadInboxFolder('inbox', { force: true }); assert.equal(commands, 1);
  } finally { close(); }
});
