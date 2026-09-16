import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mic, MicOff, PanelLeftOpen, PanelLeftClose, ContentIcon, FileText } from '../apps/client/src/icons';
import { Reply, ReplyAll, Flag, FlagOff } from '../apps/client/src/dreamclaw/components/icons';
import { savedRecordMatches } from '../apps/client/src/saved-record-search';
import { blankRecord } from '../packages/domain/workspace-records';
import type { Snapshot } from '../packages/domain/contracts';

test('icon control states use distinct geometry with inherited paint and decorative defaults', () => {
  for (const [a, b] of [[Mic, MicOff], [PanelLeftOpen, PanelLeftClose], [Reply, ReplyAll], [Flag, FlagOff], [ContentIcon, FileText]]) {
    const first = renderToStaticMarkup(createElement(a)), second = renderToStaticMarkup(createElement(b));
    assert.notEqual(first.match(/<svg.*<\/svg>/)?.[0], second.match(/<svg.*<\/svg>/)?.[0]);
    assert.match(first, /viewBox="0 0 24 24"/);
    assert.match(first, /stroke="currentColor"/);
    assert.match(first, /aria-hidden="true"/);
    assert.doesNotMatch(first, /<script|<image|foreignObject/);
  }
  const named = renderToStaticMarkup(createElement(MicOff, { title: 'Microphone muted', size: 16 }));
  assert.match(named, /role="img" aria-label="Microphone muted"/);
  assert.match(named, /width:16px;height:16px/);
});

test('saved record search keeps exact types and archived identity without indexing opaque recipe data', () => {
  const entity = (id: string, kind: 'contact' | 'content' | 'agent', fields: object) => ({ id, revision: 1, updatedAt: '2026-09-11T12:00:00Z', value: { ...blankRecord(kind, 'UTC'), ...fields } });
  const snapshot = { records: {
    contact: [entity('contact:maya', 'contact', { name: 'Maya', email: 'maya@example.test', notes: 'Café launch' })],
    content: [entity('content:launch', 'content', { title: 'Café launch', archived: true })],
    agent: [entity('agent:research', 'agent', { name: 'Research', appearance: { internalKey: 'opaque-fixture-match' } })],
    assignment: [], profile: [],
  } } as unknown as Pick<Snapshot, 'records'>;
  assert.deepEqual(savedRecordMatches(snapshot, ' CAFÉ ').map(({ id, kind, archived }) => ({ id, kind, archived })), [
    { id: 'contact:maya', kind: 'contact', archived: false }, { id: 'content:launch', kind: 'content', archived: true },
  ]);
  assert.equal(savedRecordMatches(snapshot, 'maya@example.test')[0]?.id, 'contact:maya');
  assert.deepEqual(savedRecordMatches(snapshot, 'opaque-fixture-match'), []);
  assert.deepEqual(savedRecordMatches(snapshot, '  '), []);
  assert.deepEqual(savedRecordMatches({}, 'Maya'), []);
});
