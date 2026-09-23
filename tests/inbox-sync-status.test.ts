import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxSyncStatus } from '../apps/client/src/dreamclaw/services/inbox/inboxSyncStatus';

const now = Date.parse('2026-09-22T16:00:00Z');
const updated = new Date(now - 10_000).toISOString();
test('a saved indexing flag without recent progress is described as waiting, never completed', () => {
  const stale = { indexStatus: 'indexing' as const, indexUpdatedAt: new Date(now - 120_000).toISOString(), threads: [1, 2] };
  const original = structuredClone(stale);
  assert.equal(inboxSyncStatus([stale], now).label, 'Waiting for sync progress');
  assert.equal(inboxSyncStatus([stale], now).warning, true);
  assert.deepEqual(stale, original);
  assert.equal(inboxSyncStatus([{ ...stale, indexUpdatedAt: updated }], now).label, 'Syncing · 2 loaded');
  assert.equal(inboxSyncStatus([{ ...stale, indexUpdatedAt: undefined }], now).warning, true);
});
test('one active mailbox cannot conceal another failed or stalled mailbox', () => {
  const active = { indexStatus: 'indexing' as const, indexUpdatedAt: updated, threads: [1] };
  assert.equal(inboxSyncStatus([active, { indexStatus: 'error', indexError: 'Reconnect this account.', threads: [] }], now).detail, 'Reconnect this account.');
  assert.equal(inboxSyncStatus([active, { ...active, indexUpdatedAt: new Date(now - 120_000).toISOString() }], now).label, 'Waiting for sync progress');
  assert.match(inboxSyncStatus([active, { indexStatus: 'paused', threads: [] }], now).detail, /paused/);
});
test('complete means every selected mailbox completed; paused, idle and unknown states are distinct', () => {
  const complete = { indexStatus: 'complete' as const, threads: [1] };
  assert.equal(inboxSyncStatus([complete], now).label, 'Sync complete');
  assert.equal(inboxSyncStatus([complete, { indexStatus: 'paused', threads: [] }], now).label, 'Sync paused');
  assert.equal(inboxSyncStatus([complete, { indexStatus: 'idle', threads: [] }], now).label, 'Sync status');
  assert.equal(inboxSyncStatus([], now).label, 'Sync status');
});
