import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceLoadingPercent, playfulStartupSubtitle, moduleLoadingSubtitles } from '../apps/client/src/loading-progress';
import { inboxLoadingPercent } from '../apps/client/src/inbox-startup-progress';

test('workspace progress keeps one denominator and completes only with an accepted workspace', () => {
  assert.equal(workspaceLoadingPercent(), 0);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 300, totalBytes: 1000 }), 30);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 1000, totalBytes: 1000, complete: true }), 99);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 1000, totalBytes: 1000, complete: true }, true), 100);
  assert.equal(workspaceLoadingPercent({ loadedBytes: 300 }), undefined);
  assert.equal(workspaceLoadingPercent(undefined, true), 100);
});

test('Inbox progress never restarts at its account, first page and recent message boundaries', () => {
  const values = [
    inboxLoadingPercent({ phase: 'accounts', completed: 0 }),
    ...[0,1,2,3].map(completed => inboxLoadingPercent({ phase: 'mailboxes', completed, total: 3 })),
    ...Array.from({ length: 26 }, (_, completed) => inboxLoadingPercent({ phase: 'messages', completed, total: 25 })),
    inboxLoadingPercent({ phase: 'ready', completed: 25, total: 25 }),
  ];
  assert.deepEqual(values, [...values].sort((a,b) => a-b));
  assert.equal(values[0], 0); assert.equal(values.at(-2), 99); assert.equal(values.at(-1), 100);
  assert.equal(inboxLoadingPercent({ phase: 'messages', completed: 0, total: 0 }), 20);
  assert.equal(inboxLoadingPercent({ phase: 'ready', completed: 0, total: 0 }), 100);
});

test('all module routes have playful loading copy; startup does not name Inbox', () => {
  for (const module of ['Assistant','Calendar','Inbox','Tasks','Settings','Contacts','Agents','Content','Profile','Phone pairing']) assert.ok(moduleLoadingSubtitles[module]);
  for (const percent of [0,15,55,95,100]) assert.doesNotMatch(playfulStartupSubtitle(percent), /inbox|mail|account|session|bytes/i);
});
