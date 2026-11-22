import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectedResultDetail } from '../packages/domain/connected-work.js';
import { clearResultCommand, pendingResultCommand, reviewCanBeAccepted, type ResultCommand } from '../apps/client/src/connected-result-draft.js';
import { restoredWorkRoute } from '../apps/client/src/connected-work-route.js';

function browserStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test('reload returns to the open connected record only in its own workspace and tab', () => {
  const session = browserStorage(), local = browserStorage(), scope = { epoch: 'epoch', deviceId: 'owner' };
  assert.equal(restoredWorkRoute(scope, 'tab', { getItem() { throw new Error('Session storage unavailable'); } }, local), undefined);
  session.setItem('e3:connected-view:epoch:owner:tab', JSON.stringify({ page: 'agents', id: 'library-work:original' }));
  local.setItem('e3:record-index:owner:assignment:tab', JSON.stringify({ selected: 'library-work:original' }));
  local.setItem('e3:agent-view:owner:tab', JSON.stringify({ view: 'assignment' }));
  assert.equal(restoredWorkRoute(scope, 'tab', session, local), 'agents');
  assert.equal(restoredWorkRoute(scope, 'other-tab', session, local), undefined);
  assert.equal(restoredWorkRoute({ ...scope, epoch: 'replaced' }, 'tab', session, local), undefined);
  local.setItem('e3:agent-view:owner:tab', JSON.stringify({ view: 'skills' }));
  assert.equal(restoredWorkRoute(scope, 'tab', session, local), undefined);
  session.setItem('e3:connected-view:epoch:owner:tab', JSON.stringify({ page: 'content', id: 'content:accepted' }));
  local.setItem('e3:record-index:owner:content:tab', JSON.stringify({ selected: 'content:accepted' }));
  assert.equal(restoredWorkRoute(scope, 'tab', session, local), 'content');
  local.setItem('e3:record-index:owner:content:tab', JSON.stringify({ selected: 'content:another' }));
  assert.equal(restoredWorkRoute(scope, 'tab', session, local), undefined);
});

test('a late confirmation cannot clear another pending command or reconcile the wrong result', () => {
  const storage = browserStorage(), subject = { epoch:'e', attemptId:'attempt', sha256:'digest' };
  const original: ResultCommand = { action: 'save', input: { ...subject, requestId: 'first' } };
  const later: ResultCommand = { action: 'save', input: { ...subject, requestId: 'second' } };
  storage.setItem('pending', JSON.stringify(later)); clearResultCommand(storage, 'pending', original);
  assert.deepEqual(pendingResultCommand(storage, 'pending', subject), later);
  assert.throws(() => pendingResultCommand(storage, 'pending', { ...subject, sha256: 'different' }));
  clearResultCommand(storage, 'pending', later);
  assert.equal(pendingResultCommand(storage, 'pending', subject), null);
});

test('acceptance requires a visible exact result, completed review and acknowledgment of every nonblocking finding', () => {
  const detail = { available: true, document:'Original body', review: { available:true, state:'complete', attempt:{result:{}}, report:{findings:[
    { id:'optional', severity:'advisory', detail:'Optional change' },
  ]} } } as ConnectedResultDetail;
  assert.equal(reviewCanBeAccepted(detail, new Set()), false);
  assert.equal(reviewCanBeAccepted(detail, new Set(['optional'])), true);
  detail.review.report!.findings[0].severity = 'blocking';
  assert.equal(reviewCanBeAccepted(detail, new Set(['optional'])), false);
  detail.review.report!.findings = [];
  assert.equal(reviewCanBeAccepted({ ...detail, available:false }, new Set()), false);
  assert.equal(reviewCanBeAccepted({ ...detail, review: { ...detail.review, available:false } }, new Set()), false);
  detail.review.state = 'running';
  assert.equal(reviewCanBeAccepted(detail, new Set()), false);
});
