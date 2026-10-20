import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConversationCleanupClient, retainedCleanupClient, type CleanupClientIO, type CleanupSelection } from '../apps/client/src/conversation-cleanup-client.js';
import type { ConversationCleanupBatch, ConversationCleanupSummary } from '../packages/domain/conversation-cleanup.js';
import { emptyWorkspace, restoreWorkspace, workspaceTabs } from '../apps/client/src/workspace-tabs.js';

function fixture() {
  const epoch = randomUUID(), scope = { space: 'chat' as const, folder: 'active' as const, query: '' }, id = randomUUID();
  let saved: CleanupSelection | undefined, writable = true, lost = false, batch: ConversationCleanupBatch | undefined;
  const calls: { url: string; input?: any }[] = [];
  const io: CleanupClientIO = { read: () => saved, write: value => { if (!writable) return false; saved = structuredClone(value); return true; }, uuid: randomUUID,
    async request<T>(url: string, input?: any): Promise<T> {
      calls.push({ url, input: structuredClone(input) });
      if (url.endsWith('/prepare')) batch = { format: 1, id: input.requestId, epoch, revision: 1, digest: 'a'.repeat(64), action: input.action, scope: input.scope, mode: input.targets ? 'selected' : 'matching', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', state: 'review', running: false, targets: [{ id, revision: 1, title: 'Retained', space: 'chat', projectId: null, archived: false, deleted: false }], outcomes: [{ id, state: 'pending' }], counts: { pending: 1, applied: 0, blocked: 0, unconfirmed: 0 }, remainder: { observedAt: '2026-01-01', verified: true, capturedRemaining: [id], matchingCount: 1, newMatchingCount: 0 } };
      if (url.endsWith('/decide')) {
        assert.ok(batch); batch = { ...batch, revision: batch.revision + 1, state: input.decision === 'cancel' ? 'cancelled' : 'complete', outcomes: [{ id, state: 'applied' }], counts: { pending: 0, applied: 1, blocked: 0, unconfirmed: 0 } };
      }
      if (lost) throw Error('Lost response');
      return structuredClone(batch) as T;
    } };
  const client = new ConversationCleanupClient(epoch, scope, io);
  return { client, io, epoch, scope, id, calls, saved: () => saved, writable: (value: boolean) => { writable = value; }, lost: (value: boolean) => { lost = value; } };
}

test('original capture is saved before POST and a lost response only observes that exact batch after reopening', async () => {
  const f = fixture(); f.client.configure({ scope: { ...f.scope, query: 'kept query' }, selected: [{ id: f.id, revision: 1 }] }); f.lost(true);
  await f.client.prepare('selected'); const original = f.saved()!.pending!;
  assert.equal(original.kind, 'prepare'); assert.deepEqual(f.calls[0].input, original.command);
  assert.equal(f.saved()!.scope.query, 'kept query');
  const reopened = new ConversationCleanupClient(f.epoch, f.scope, f.io); f.lost(false); await reopened.observe();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].input, undefined);
  assert.match(f.calls[1].url, new RegExp(original.command.requestId)); assert.equal(reopened.getSnapshot().saved.pending, undefined);
  assert.equal(reopened.getSnapshot().batch!.id, original.command.requestId);
});

test('lost apply is not sent again by Check, remount, or a second apply click', async () => {
  const f = fixture(); await f.client.prepare('matching'); f.lost(true); await f.client.decide('apply');
  const original = f.saved()!.pending!, calls = f.calls.length;
  await f.client.decide('apply'); assert.equal(f.calls.length, calls);
  const reopened = new ConversationCleanupClient(f.epoch, f.scope, f.io); f.lost(false); await reopened.observe(true);
  assert.equal(f.calls.filter(call => call.input?.decision === 'apply').length, 1);
  assert.equal(reopened.getSnapshot().batch!.state, 'complete'); assert.deepEqual(reopened.getSnapshot().saved.lastRequest, original);
});

test('failed durable save and current writing guard stop effects before request', async () => {
  const f = fixture(); f.writable(false); await f.client.prepare('matching'); assert.equal(f.calls.length, 0);
  f.writable(true); await f.client.prepare('matching'); await f.client.decide('apply', () => false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/decide')).length, 0);
  assert.match(f.client.getSnapshot().error, /writing/); assert.equal(f.client.getSnapshot().batch!.state, 'review');
});

test('changing filters during original request cannot replace its captured query or IDs', async () => {
  const f = fixture(); f.client.configure({ selected: [{ id: f.id, revision: 7 }], scope: { ...f.scope, query: 'Original' } }); f.lost(true);
  await f.client.prepare('selected'); const original = structuredClone(f.saved());
  f.client.configure({ scope: { ...f.scope, query: 'Replacement' }, selected: [] }); f.client.freshReview();
  assert.deepEqual(f.saved(), original);
});

test('unsupported local journals are retained and cannot be replaced by a new request', async () => {
  const f = fixture(), invalid = { format: 99, pending: { original: 'kept' } }; let writes = 0;
  const client = new ConversationCleanupClient(f.epoch, f.scope, { ...f.io, read: () => invalid, write: () => { writes++; return true; } });
  await client.prepare('matching'); client.configure({ selected: [] });
  assert.equal(client.getSnapshot().invalid, true); assert.equal(writes, 0); assert.equal(f.calls.length, 0);
});

test('window-scoped singleton keeps the original in-flight authority across editor remounts', () => {
  const f = fixture(), key = randomUUID();
  const one = retainedCleanupClient(key, f.epoch, f.scope, f.io), two = retainedCleanupClient(key, f.epoch, { ...f.scope, space: 'work' }, f.io);
  assert.equal(two, one); one.configure({ scope: { ...f.scope, query: 'Kept' } }); assert.equal(two.getSnapshot().saved.scope.query, 'Kept');
  assert.notEqual(retainedCleanupClient(key + ':other-window', f.epoch, f.scope, f.io), one);
});

test('cleanup view survives workspace reload without invalidating existing file/history tabs', () => {
  let tabs = workspaceTabs(emptyWorkspace(), { type: 'open', view: { kind: 'history' } });
  tabs = workspaceTabs(tabs, { type: 'open', view: { kind: 'cleanup' } });
  const restored = restoreWorkspace(tabs); assert.deepEqual(restored.tabs, tabs.tabs); assert.equal(restored.active, 'cleanup'); assert.equal(restored.visible, false);
});

test('an unconfirmed apply that has no saved transition cannot be applied again; explicit cancellation retains its original identity', async () => {
  const f = fixture(); await f.client.prepare('matching');
  const originalRequest = f.io.request;
  f.io.request = async <T>(url: string, input?: any): Promise<T> => { if (input?.decision === 'apply') throw Error('Never reached service'); return originalRequest<T>(url, input); };
  await f.client.decide('apply'); const original = f.saved()!.pending!;
  await f.client.observe(true); assert.deepEqual(f.saved()!.pending, original); assert.equal(f.client.getSnapshot().batch!.state, 'review');
  await f.client.decide('cancel'); assert.equal(f.client.getSnapshot().batch!.state, 'cancelled');
  assert.deepEqual(f.saved()!.originalDecision, original.command);
  assert.equal(f.calls.filter(c => c.input?.decision === 'apply').length, 0);
});

for (const decision of ['apply', 'cancel'] as const) for (const field of ['id', 'digest', 'epoch'] as const) test(`${decision} preserves its original pending request after a mismatched ${field}`, async () => {
  const f = fixture(); await f.client.prepare('matching');
  const review = structuredClone(f.client.getSnapshot().batch), request = f.io.request;
  f.io.request = async <T>(url: string, input?: unknown): Promise<T> => {
    const result = await request<ConversationCleanupBatch>(url, input);
    return { ...result, [field]: field === 'digest' ? 'b'.repeat(64) : randomUUID() } as T;
  };
  await f.client.decide(decision);
  assert.deepEqual(f.client.getSnapshot().batch, review);
  assert.equal(f.saved()!.batchId, review!.id);
  const pending = f.saved()!.pending!; assert.equal(pending.kind, 'decide');
  if (pending.kind === 'decide') {
    assert.equal(pending.command.batchId, review!.id); assert.equal(pending.command.digest, review!.digest); assert.equal(pending.command.decision, decision);
  }
  assert.match(f.client.getSnapshot().error, /identity did not match/);
});

for (const field of ['id', 'digest', 'epoch'] as const) test(`reconcile Check rejects a mismatched ${field} without clearing its original pending request`, async () => {
  const f = fixture(); await f.client.prepare('matching');
  const original = structuredClone(f.client.getSnapshot().batch!), request = f.io.request;
  f.io.request = async <T>(url: string, input?: any): Promise<T> => {
    if (!input) return { ...original, state: 'partial', revision: 2 } as T;
    const result = await request<ConversationCleanupBatch>(url, input);
    return { ...result, [field]: field === 'digest' ? 'b'.repeat(64) : randomUUID() } as T;
  };
  await f.client.observe(true);
  assert.equal(f.client.getSnapshot().batch!.id, original.id); assert.equal(f.client.getSnapshot().batch!.state, 'partial');
  assert.equal(f.client.getSnapshot().batch!.digest, original.digest);
  const pending = f.saved()!.pending!; assert.equal(pending.kind, 'decide');
  if (pending.kind === 'decide') { assert.equal(pending.command.decision, 'check'); assert.equal(pending.command.batchId, original.id); assert.equal(pending.command.digest, original.digest); }
  assert.match(f.client.getSnapshot().error, /identity did not match/);
});

test('GET observation also preserves a lost decision when the returned inventory digest changed', async () => {
  const f = fixture(); await f.client.prepare('matching'); f.lost(true); await f.client.decide('apply');
  const pending = structuredClone(f.saved()!.pending), review = structuredClone(f.client.getSnapshot().batch), request = f.io.request;
  f.lost(false); f.io.request = async <T>(url: string, input?: unknown): Promise<T> => ({ ...await request<ConversationCleanupBatch>(url, input), digest: 'b'.repeat(64) }) as T;
  await f.client.observe(true);
  assert.deepEqual(f.saved()!.pending, pending); assert.deepEqual(f.client.getSnapshot().batch, review);
  assert.equal(f.calls.filter(c => c.input?.decision === 'check').length, 0);
});

const missing = () => Object.assign(new Error('No original review'), { code: 'cleanup_missing', status: 404 });

test('an absent review retries only its exact saved prepare after an explicit action and fresh authoritative GET', async () => {
  const f = fixture(), request = f.io.request;
  const attempts: { url: string; input?: unknown }[] = [];
  let initial = true;
  f.io.request = async <T>(url: string, input?: unknown): Promise<T> => {
    attempts.push({ url, input: structuredClone(input) });
    if (!input) throw missing();
    if (initial) { initial = false; throw Error('Did not reach admission'); }
    return request<T>(url, input);
  };
  await f.client.prepare('matching'); const pending = structuredClone(f.saved()!.pending!);
  await f.client.retryOriginalReview(); assert.equal(attempts.length, 1);
  await f.client.observe(); assert.equal(attempts.length, 2);
  assert.equal(f.client.getSnapshot().missingPrepareId, pending.command.requestId);
  assert.deepEqual(f.saved()!.pending, pending);
  await f.client.retryOriginalReview();
  assert.deepEqual(attempts.map(a => !!a.input), [true, false, false, true]);
  assert.deepEqual(attempts[3].input, attempts[0].input);
  assert.equal(f.client.getSnapshot().batch!.id, pending.command.requestId);
  assert.equal(f.client.getSnapshot().saved.pending, undefined);
  assert.deepEqual(f.saved()!.originalCapture, pending.command);
  assert.equal(f.calls.filter(c => c.url.endsWith('/decide')).length, 0);
});

test('late admission after an absent observation is adopted before retry without another prepare POST', async () => {
  const f = fixture(), request = f.io.request;
  let admitted = false; const attempts: { url: string; input?: unknown }[] = [];
  f.io.request = async <T>(url: string, input?: unknown): Promise<T> => {
    attempts.push({ url, input });
    if (input) throw Error('Original response lost before admission became visible');
    if (!admitted) throw missing();
    return request<T>(url);
  };
  await f.client.prepare('matching'); const original = f.saved()!.pending!;
  await f.client.observe();
  // The initial request becomes admitted later, independently of this client.
  await request('assistant/conversation-cleanup/prepare', original.command); admitted = true;
  await f.client.retryOriginalReview();
  assert.equal(attempts.filter(a => a.input).length, 1);
  assert.equal(f.client.getSnapshot().batch!.id, original.command.requestId);
  assert.deepEqual(f.saved()!.lastRequest, original); assert.equal(f.saved()!.pending, undefined);
});

for (const error of [
  Object.assign(new Error('Unavailable'), { code: 'cleanup_missing', status: 503 }),
  Object.assign(new Error('Unrecognized missing page'), { code: 'not_found', status: 404 }),
  Object.assign(new Error('Authentication expired'), { code: 'session_expired', status: 401 }),
  new Error('Connection lost'),
]) test(`review retry stays disabled after ${error.message}`, async () => {
  const f = fixture(); let calls = 0;
  f.io.request = async <T>(): Promise<T> => { calls++; throw error; };
  await f.client.prepare('matching'); const pending = structuredClone(f.saved()!.pending);
  await f.client.observe(); await f.client.retryOriginalReview();
  assert.equal(calls, 2); assert.equal(f.client.getSnapshot().missingPrepareId, undefined);
  assert.deepEqual(f.saved()!.pending, pending);
});

test('absence is not persisted as retry authority and a failed fresh read or durable write cannot resend', async () => {
  const f = fixture(); let posts = 0, unavailable = false;
  f.io.request = async <T>(_url: string, input?: unknown): Promise<T> => {
    if (input) { posts++; throw Error('Not sent'); }
    if (unavailable) throw Error('Connection unavailable');
    throw missing();
  };
  await f.client.prepare('matching'); await f.client.observe();
  const reopened = new ConversationCleanupClient(f.epoch, f.scope, f.io);
  await reopened.retryOriginalReview(); assert.equal(posts, 1);
  unavailable = true; await f.client.retryOriginalReview(); assert.equal(posts, 1);
  assert.equal(f.client.getSnapshot().missingPrepareId, undefined);
  unavailable = false; await reopened.observe(); f.writable(false);
  await reopened.retryOriginalReview(); assert.equal(posts, 1); assert.ok(f.saved()!.pending);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function summary(id = randomUUID(), revision = 1): ConversationCleanupSummary {
  return { id, epoch: randomUUID(), revision, action: 'archive', scope: { space: 'chat', folder: 'active', query: '' }, mode: 'matching',
    createdAt: '2026-01-01', updatedAt: '2026-01-01', state: 'complete', running: false, count: 1,
    counts: { pending: 0, applied: 1, blocked: 0, unconfirmed: 0 } };
}
type Page = { items: ConversationCleanupSummary[]; total: number; nextOffset: number | null };

test('repeated history requests share one flight and overlapping pages deduplicate exact IDs without reverting revisions', async () => {
  const f = fixture(), first = deferred<Page>(), second = deferred<Page>(), item = summary();
  let calls = 0;
  f.io.request = <T>(): Promise<T> => (++calls === 1 ? first.promise : second.promise) as Promise<T>;
  const a = f.client.history(), b = f.client.history(); assert.equal(a, b); assert.equal(calls, 1);
  first.resolve({ items: [item, { ...item, revision: 2 }], total: 3, nextOffset: 2 }); await a;
  assert.equal(f.client.getSnapshot().history.items.length, 1); assert.equal(f.client.getSnapshot().history.items[0].revision, 2);
  const c = f.client.history(2), d = f.client.history(2); assert.equal(c, d); assert.equal(calls, 2);
  const next = summary(); second.resolve({ items: [item, next], total: 3, nextOffset: null }); await c;
  assert.deepEqual(f.client.getSnapshot().history.items.map(i => i.id), [item.id, next.id]);
  assert.equal(f.client.getSnapshot().history.items[0].revision, 2); assert.equal(f.client.getSnapshot().historyBusy, false);
  await f.client.history(2); assert.equal(calls, 2);
});

for (const staleFailure of [false, true]) test(`fresh history generation cannot be overwritten by stale pagination ${staleFailure ? 'failure' : 'success'}`, async () => {
  const f = fixture(), old = summary(), latest = summary(), stale = deferred<Page>(), refresh = deferred<Page>();
  let calls = 0;
  f.io.request = <T>(): Promise<T> => {
    calls++;
    return (calls === 1 ? Promise.resolve({ items: [old], total: 2, nextOffset: 1 }) : calls === 2 ? stale.promise : refresh.promise) as Promise<T>;
  };
  await f.client.history(); const previous = f.client.history(1), current = f.client.history();
  refresh.resolve({ items: [latest], total: 1, nextOffset: null }); await current;
  if (staleFailure) stale.reject(Error('Stale page failed')); else stale.resolve({ items: [old], total: 99, nextOffset: 2 });
  await previous;
  assert.deepEqual(f.client.getSnapshot().history.items, [latest]); assert.equal(f.client.getSnapshot().history.total, 1);
  assert.equal(f.client.getSnapshot().history.nextOffset, null); assert.equal(f.client.getSnapshot().historyBusy, false);
  assert.equal(f.client.getSnapshot().error, '');
});
