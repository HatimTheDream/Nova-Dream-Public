import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PermanentConversationCleanupClient, readPermanentCleanupBatch, readCleanupMode, keepCleanupMode,
  type PermanentCleanupIO, type PermanentCleanupSelection } from '../apps/client/src/conversation-permanent-cleanup-client';
import type { PermanentConversationCleanupBatch } from '../packages/domain/conversation-cleanup';

function fixture(count = 1) {
  const owner = { epoch: randomUUID(), deviceId: 'fixture-device', windowId: randomUUID() };
  const scope = { space: 'all' as const, folder: 'deleted' as const, query: '' };
  const targets = Array.from({ length: count }, () => ({ id: randomUUID(), revision: 3, title: 'Original Trash', space: 'chat' as const, projectId: null, deleted: true as const, archived: false })).sort((a, b) => a.id.localeCompare(b.id));
  let stored: unknown, writable = true, lost = false, batch: PermanentConversationCleanupBatch;
  const calls: { url: string; input?: any }[] = [];
  const io: PermanentCleanupIO = {
    read: () => structuredClone(stored),
    write(value) { if (!writable) return false; stored = JSON.parse(JSON.stringify(value)); return true; },
    uuid: randomUUID,
    async request<T>(url: string, input?: any): Promise<T> {
      calls.push({ url, input: structuredClone(input) });
      if (input) assert.deepEqual((stored as PermanentCleanupSelection).pending?.command, input, 'original command must be durable before POST');
      if (url.endsWith('/prepare')) batch = {
        format: 2, id: input.requestId, epoch: owner.epoch, revision: 1, digest: 'a'.repeat(64), action: 'remove',
        scope: input.scope, mode: input.targets ? 'selected' : 'matching', createdAt: '2026-01-01', updatedAt: '2026-01-01',
        state: 'review', targets: structuredClone(targets), outcomes: targets.map(t => ({ id: t.id, state: 'pending' })),
        chunks: [], counts: { pending: count, applied: 0, blocked: 0, unconfirmed: 0 },
        remainder: { observedAt: '2026-01-01', verified: true, capturedRemaining: targets.map(t => t.id), matchingCount: count, newMatchingCount: 0 }, running: false,
      };
      if (url.endsWith('/decide')) {
        if (input.decision === 'cancel') batch = { ...batch, revision: batch.revision + 1, state: 'cancelled' };
        else {
          const target = batch.outcomes.find(o => o.state === 'pending')!;
          const outcomes = batch.outcomes.map(o => o.id === target.id ? { id: o.id, state: 'applied' as const, chunkId: input.requestId, removalId: randomUUID() } : o);
          const counts = { pending: outcomes.filter(o => o.state === 'pending').length, applied: outcomes.filter(o => o.state === 'applied').length, blocked: 0, unconfirmed: 0 };
          batch = { ...batch, revision: batch.revision + 1, state: counts.pending ? 'partial' : 'complete', outcomes, counts,
            chunks: [...batch.chunks, { id: input.requestId, decision: input.decision, state: 'closed', startedAt: '2026-01-01', settledAt: '2026-01-01', itemIds: [target.id] }],
            remainder: { ...batch.remainder, capturedRemaining: outcomes.filter(o => o.state !== 'applied').map(o => o.id), matchingCount: counts.pending } };
        }
      }
      if (lost) throw Error('Lost original response');
      if (!url.includes('?id=') && !input) return { items: [], total: 0, nextOffset: null } as T;
      return structuredClone(batch) as T;
    },
  };
  const client = new PermanentConversationCleanupClient(owner, scope, io);
  return { owner, scope, targets, io, client, calls, saved: () => stored as PermanentCleanupSelection, replace: (value: unknown) => { stored = value; },
    writable: (value: boolean) => { writable = value; }, lost: (value: boolean) => { lost = value; }, batch: () => batch, change: (change: Partial<PermanentConversationCleanupBatch>) => { batch = { ...batch, ...change }; } };
}
const start = (f: ReturnType<typeof fixture>) => f.client.decide('start', f.client.decisionToken('start'));
const missing = () => Object.assign(Error('Original review missing'), { status: 404, code: 'cleanup_missing' });

test('capture survives a lost reply and reopening observes only the original GET', async () => {
  const f = fixture(); f.client.configure({ selected: f.targets.map(t => ({ id: t.id, revision: t.revision })) }); f.lost(true);
  await f.client.prepare('selected'); const original = structuredClone(f.saved().pending);
  assert.equal(f.calls.length, 1);
  const reopened = new PermanentConversationCleanupClient(f.owner, f.scope, f.io); f.lost(false); await reopened.observe();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].input, undefined); assert.deepEqual(reopened.getSnapshot().saved.lastRequest, original);
  assert.deepEqual(reopened.getSnapshot().saved.anchor?.targets, f.targets); assert.equal(reopened.getSnapshot().saved.pending, undefined);
});
test('uncertain start is reconciled by its exact chunk, never resent on check or remount', async () => {
  const f = fixture(); await f.client.prepare('matching'); f.lost(true); await start(f);
  const original = structuredClone(f.saved().pending); await start(f); assert.equal(f.calls.length, 2);
  f.lost(false); const reopened = new PermanentConversationCleanupClient(f.owner, f.scope, f.io); await reopened.observe();
  assert.equal(f.calls.filter(c => c.input?.decision).length, 1);
  assert.deepEqual(reopened.getSnapshot().saved.lastRequest, original); assert.equal(reopened.getSnapshot().batch?.counts.applied, 1);
});
test('different completed chunk cannot confirm the original lost decision', async () => {
  const f = fixture(); await f.client.prepare('matching'); f.lost(true); await start(f); const original = structuredClone(f.saved().pending);
  const other = randomUUID(), batch = f.batch();
  f.change({ chunks: batch.chunks.map(c => ({ ...c, id: other })), outcomes: batch.outcomes.map(o => ({ ...o, chunkId: other })) }); f.lost(false);
  await f.client.observe(); assert.deepEqual(f.saved().pending, original); assert.equal(f.client.decisionToken('continue_remaining'), undefined);
  assert.match(f.client.getSnapshot().error, /original decision remains unconfirmed/i);
});
test('remaining work needs a fresh exact acknowledgement and starts only a new explicit chunk', async () => {
  const f = fixture(2); await f.client.prepare('matching'); const first = f.client.decisionToken('start')!;
  await f.client.decide('start', first); assert.equal(f.client.getSnapshot().batch?.counts.pending, 1);
  await f.client.decide('continue_remaining', first); assert.equal(f.calls.filter(c => c.input?.decision).length, 1);
  const next = f.client.decisionToken('continue_remaining')!; assert.ok(next);
  await f.client.decide('continue_remaining', next);
  assert.equal(f.calls.filter(c => c.input?.decision).length, 2); assert.equal(f.client.getSnapshot().batch?.counts.applied, 2);
  assert.notEqual(f.calls[1].input.requestId, f.calls[2].input.requestId);
});
test('raw unreadable, foreign owner and read failure preserve bytes with zero requests or writes', async () => {
  for (const raw of [null, { format: 99 }, '{bad json', { ...fixture().saved(), owner: { epoch: randomUUID() } }]) {
    const f = fixture(); f.replace(raw); let writes = 0;
    const client = new PermanentConversationCleanupClient(f.owner, f.scope, { ...f.io, write() { writes++; return true; } });
    await client.prepare('matching'); client.configure({ selected: [] });
    assert.equal(client.getSnapshot().invalid, true); assert.equal(writes, 0); assert.equal(f.calls.length, 0); assert.deepEqual(f.saved(), raw);
  }
  const f = fixture(), client = new PermanentConversationCleanupClient(f.owner, f.scope, { ...f.io, read() { throw Error('Read refused'); } });
  await client.prepare('matching'); assert.equal(client.getSnapshot().invalid, true); assert.equal(f.calls.length, 0);
});
test('storage refusal and writing refusal happen before destructive admission', async () => {
  const f = fixture(); f.writable(false); await f.client.prepare('matching'); assert.equal(f.calls.length, 0);
  f.writable(true); await f.client.prepare('matching');
  await f.client.decide('start', f.client.decisionToken('start'), () => false); assert.equal(f.calls.length, 1);
  f.writable(false); await start(f); assert.equal(f.calls.length, 1); assert.equal(f.saved().pending, undefined);
});
test('late reply cannot erase a changed journal or a new owner command', async () => {
  const f = fixture(), request = f.io.request; let release!: () => void;
  f.io.request = async <T>(url: string, input?: unknown) => { const value = await request<T>(url, input); await new Promise<void>(resolve => { release = resolve; }); return value; };
  const pending = f.client.prepare('matching'); await Promise.resolve(); await Promise.resolve();
  const newer = { ...f.saved(), pending: { kind: 'prepare', command: { ...(f.saved().pending as any).command, requestId: randomUUID() } } };
  f.replace(newer); release(); await pending;
  assert.deepEqual(f.saved(), newer); assert.equal(f.client.getSnapshot().batch, undefined); assert.match(f.client.getSnapshot().error, /changed/);
});
test('same digest with changed captured titles, IDs, scope or revision refuses authority', async () => {
  for (const change of ['targets', 'scope', 'revision'] as const) {
    const f = fixture(); await f.client.prepare('matching'); const original = structuredClone(f.saved());
    f.change(change === 'targets' ? { targets: f.targets.map(t => ({ ...t, title: 'Changed' })) } : change === 'scope' ? { scope: { ...f.scope, query: 'Other' } } : { revision: 0 });
    await f.client.observe(); assert.deepEqual(f.saved(), original); assert.equal(f.client.decisionToken('start'), undefined);
    await start(f); assert.equal(f.calls.filter(c => c.input?.decision).length, 0);
  }
});
test('missing or malformed refreshed projection disables old acknowledgement without inferring completion', async () => {
  const f = fixture(); await f.client.prepare('matching'); const token = f.client.decisionToken('start')!;
  f.io.request = async <T>() => ({ ...f.batch(), outcomes: [] }) as T;
  await f.client.observe(); await f.client.decide('start', token); assert.equal(f.client.decisionToken('start'), undefined);
  assert.equal(f.calls.filter(c => c.input?.decision).length, 0); assert.equal(f.client.getSnapshot().batch?.state, 'review');
});
test('inactive owner does no observation, history or new admission while retaining its exact journal', async () => {
  const f = fixture(); await f.client.prepare('matching'); const saved = structuredClone(f.saved());
  f.client.setActive(false); await f.client.observe(); await f.client.history(); await f.client.decide('cancel'); f.client.freshReview();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.saved(), saved);
});
test('only absent non-effectful review can be explicitly retried after a fresh authoritative GET', async () => {
  const f = fixture(), request = f.io.request; let unavailable = true;
  f.io.request = async <T>(url: string, input?: unknown) => {
    if (unavailable) { f.calls.push({ url, input }); if (!input) throw missing(); throw Error('Original capture response lost'); }
    return request<T>(url, input);
  };
  await f.client.prepare('matching'); const original = structuredClone(f.saved().pending);
  await f.client.retryOriginalReview(); assert.equal(f.calls.length, 1);
  await f.client.observe(); assert.equal(f.client.getSnapshot().missingPrepareId, f.saved().batchId);
  f.io.request = async <T>(url: string, input?: unknown) => { if (!input) { f.calls.push({ url }); throw missing(); } unavailable = false; return request<T>(url, input); };
  await f.client.retryOriginalReview(); assert.deepEqual(f.calls.at(-1)?.input, original?.command);
  assert.equal(f.calls.filter(c => c.input).length, 2); assert.equal(f.calls.filter(c => c.input?.decision).length, 0);
});
test('cancelling an unstarted uncertain start preserves that original command', async () => {
  const f = fixture(), request = f.io.request; await f.client.prepare('matching');
  f.io.request = async <T>(url: string, input?: any) => { if (input?.decision === 'start') throw Error('Unknown admission'); return request<T>(url, input); };
  await start(f); const original = structuredClone(f.saved().pending); await f.client.observe(); await f.client.decide('cancel');
  assert.equal(f.client.getSnapshot().batch?.state, 'cancelled'); assert.deepEqual(f.saved().originalDecision, original?.command);
  assert.equal(f.calls.filter(c => c.input?.decision === 'start').length, 0);
});
test('mode changes are storage-first, raw-aware and refuse a later owner replacement', () => {
  const f = fixture(); let raw: unknown, writes = 0;
  assert.equal(readCleanupMode(raw, f.owner), 'organize');
  assert.throws(() => keepCleanupMode('permanent', f.owner, raw, () => raw, () => false));
  raw = keepCleanupMode('permanent', f.owner, raw, () => raw, () => { writes++; return true; });
  assert.equal(readCleanupMode(raw, f.owner), 'permanent'); assert.equal(writes, 1);
  assert.throws(() => readCleanupMode(null, f.owner));
  assert.throws(() => readCleanupMode(raw, { ...f.owner, epoch: randomUUID() }));
  assert.throws(() => keepCleanupMode('organize', f.owner, raw, () => ({ unreadable: true }), () => { writes++; return true; }));
  assert.equal(writes, 1);
});
test('wire reader rejects incomplete totals, duplicated started items and false applied records', async () => {
  const f = fixture(); await f.client.prepare('matching'); const original = f.batch();
  assert.throws(() => readPermanentCleanupBatch({ ...original, counts: { ...original.counts, applied: 1 } }));
  assert.throws(() => readPermanentCleanupBatch({ ...original, outcomes: [{ id: f.targets[0].id, state: 'applied' }] }));
  await start(f); const result = f.batch();
  assert.throws(() => readPermanentCleanupBatch({ ...result, chunks: [result.chunks[0], { ...result.chunks[0], id: randomUUID() }] }));
});
test('wire reader derives completion from all outcomes and chunk closure rather than accepting a terminal label', async () => {
  const f = fixture(2); await f.client.prepare('matching'); const review = f.batch();
  assert.throws(() => readPermanentCleanupBatch({ ...review, state: 'complete' }));
  await start(f); const partial = f.batch();
  assert.throws(() => readPermanentCleanupBatch({ ...partial, state: 'complete' }));
  assert.throws(() => readPermanentCleanupBatch({ ...partial, state: 'partial', chunks: partial.chunks.map(c => ({ ...c, state: 'unconfirmed' })) }));
  await f.client.decide('continue_remaining', f.client.decisionToken('continue_remaining'));
  assert.equal(readPermanentCleanupBatch(f.batch()).state, 'complete');
});
test('lost cancellation stays unconfirmed on GET; explicitly leaving cancelled review keeps its original command', async () => {
  const f = fixture(); await f.client.prepare('matching'); f.lost(true); await f.client.decide('cancel');
  const original = structuredClone(f.saved().pending); f.lost(false); await f.client.observe();
  assert.equal(f.client.getSnapshot().batch?.state, 'cancelled'); assert.deepEqual(f.saved().pending, original);
  assert.match(f.client.getSnapshot().error, /remains unconfirmed/); const requests = f.calls.length;
  f.client.freshReview(); assert.equal(f.saved().batchId, undefined); assert.equal(f.saved().pending, undefined);
  assert.deepEqual(f.saved().lastRequest, original); assert.equal(f.calls.length, requests);
});
test('complete history pagination preserves original IDs and refuses a truncated page', async () => {
  const f = fixture(); await f.client.prepare('matching');
  const { targets: _t, chunks: _c, outcomes: _o, remainder: _r, digest: _d, ...summary } = f.batch();
  const items = Array.from({ length: 21 }, () => ({ ...summary, id: randomUUID(), count: 1 }));
  f.io.request = async <T>(url: string) => {
    const offset = Number(new URL('https://fixture.invalid/' + url).searchParams.get('offset'));
    return { items: items.slice(offset, offset + 20), total: 21, nextOffset: offset ? null : 20 } as T;
  };
  await f.client.history(); assert.equal(f.client.getSnapshot().history.items.length, 20);
  await f.client.history(20); assert.deepEqual(f.client.getSnapshot().history.items.map(i => i.id), items.map(i => i.id));
  f.io.request = async <T>() => ({ items: items.slice(0, 1), total: 21, nextOffset: null }) as T;
  await f.client.history(); assert.equal(f.client.getSnapshot().history.items.length, 21); assert.match(f.client.getSnapshot().error, /unreadable|changed/);
});
test('an original chunk at or before the commanded revision does not acknowledge that command', async () => {
  const f = fixture(); await f.client.prepare('matching'); f.lost(true); await start(f); const pending = f.saved().pending!;
  f.change({ revision: pending.kind === 'decide' ? pending.command.expectedRevision : 1 }); f.lost(false); await f.client.observe();
  assert.deepEqual(f.saved().pending, pending); assert.equal(f.client.decisionToken('continue_remaining'), undefined);
});
