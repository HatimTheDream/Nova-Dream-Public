import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../packages/domain/contracts';
import { blankRecord } from '../packages/domain/workspace-records';
import type { HomeLibraryState } from '../packages/domain/home-library';
import { SearchNavigation, defaultSearchFilters, searchKey, searchProjection, searchMatches, searchReturn, matchesSearchReturn, readSearchView, sameSearchTarget } from '../apps/client/src/search-workspace';

const scope = { epoch: 'epoch-one', deviceId: 'device-one', windowId: 'window-one' };
const entity = (id: string, value: unknown, revision = 1) => ({ id, revision, value, deviceId: scope.deviceId, updatedAt: '2026-10-20T05:00:00Z' });
const snapshot = () => ({
  ...scope, tasks: Array.from({ length: 132 }, (_, index) => entity(`task:${String(index).padStart(3, '0')}`, { title: `Shared launch ${index}`, notes: 'Searchable planning', status: index === 2 ? 'done' : 'open', projectId: index === 3 ? 'project:one' : null })),
  drafts: [], projects: [], records: { contact: [entity('contact:one', { ...blankRecord('contact', 'UTC'), name: 'Shared launch', notes: 'Contact text' })],
    content: [entity('content:one', { ...blankRecord('content', 'UTC'), title: 'Shared launch', archived: true })],
    agent: [entity('agent:one', { ...blankRecord('agent', 'UTC'), appearance: { secretFixture: 'not indexed' } })], assignment: [], profile: [] },
}) as unknown as Snapshot;

test('complete typed projection reaches the 101st match with duplicates and real status/project filters', () => {
  const rows = searchProjection(snapshot()), matches = searchMatches(rows, 'shared launch', defaultSearchFilters);
  assert.equal(matches.length, 134);
  assert.ok(matches.slice(0, 120).some(row => row.target.id === 'task:100'));
  assert.deepEqual(new Set(matches.filter(row => row.title === 'Shared launch').map(row => row.target.kind)), new Set(['contact', 'content']));
  assert.equal(searchMatches(rows, '', { ...defaultSearchFilters, status: 'archived' })[0].target.kind, 'content');
  assert.equal(searchMatches(rows, '', { ...defaultSearchFilters, status: 'completed' })[0].target.id, 'task:002');
  assert.equal(searchMatches(rows, '', { ...defaultSearchFilters, project: 'project:one' })[0].target.id, 'task:003');
  assert.equal(searchMatches(rows, 'not indexed', defaultSearchFilters).length, 0);
});

test('Library reads search actual note/body and stored URL, while wrong epochs and removed saved drafts are excluded', () => {
  const current = snapshot();
  current.drafts = [entity('draft:removed', { title: 'Removed', text: 'Removed needle' }) as Snapshot['drafts'][number]];
  current.draftRemovals = [{ draftId: 'draft:removed', revision: 1 }] as Snapshot['draftRemovals'];
  const library = { epoch: scope.epoch, collections: [{ id: 'collection:one', revision: 1, title: 'Writing', subtitle: 'Collection clue', updatedAt: '', archived: false }],
    items: [{ id: 'note:one', revision: 2, title: 'A note', body: 'Needle deep inside note body', kind: 'note', updatedAt: '', archived: false },
      { id: 'link:one', revision: 3, title: 'A link', body: 'My notes', url: 'https://example.test/stored-path', kind: 'link', updatedAt: '', archived: true }] } as HomeLibraryState;
  const rows = searchProjection(current, library);
  assert.equal(searchMatches(rows, 'deep inside', defaultSearchFilters)[0].target.id, 'note:one');
  assert.equal(searchMatches(rows, 'stored-path', defaultSearchFilters)[0].target.id, 'link:one');
  assert.equal(searchMatches(rows, 'Removed needle', defaultSearchFilters).length, 0);
  assert.equal(searchProjection(current, { ...library, epoch: 'old' }).some(row => row.target.kind === 'note'), false);
});

test('only a current exact mounted Assistant owner contributes device writing', () => {
  const local = { token: 'owner-one', id: 'draft:device-one', revision: 2, epoch: scope.epoch, deviceId: scope.deviceId, pending: true,
    value: { title: 'Current writing', text: 'Unsent needle', projectId: null } } as Parameters<typeof searchProjection>[2];
  const hit = searchProjection(snapshot(), undefined, local).find(row => row.target.kind === 'local-draft')!;
  assert.equal(hit.provenance, 'device'); assert.equal(hit.target.ownerToken, 'owner-one');
  assert.equal(sameSearchTarget(hit.target, { ...hit.target, ownerToken: 'another-owner' }), false);
  assert.equal(searchProjection(snapshot(), undefined, { ...local!, epoch: 'old' }).some(row => row.target.kind === 'local-draft'), false);
});

test('Search persistence refusal retains exact original navigation, query, batch, selection and scroll', () => {
  const storage = new Map<string, unknown>(); let refuse = false;
  const io = { read: (key: string) => storage.get(key), write: (key: string, value: unknown) => { if (refuse) return false; storage.set(key, structuredClone(value)); return true; } };
  const nav = new SearchNavigation(scope, io, () => 'session-one');
  assert.equal(nav.begin({ route: 'settings', label: 'Settings', settingsTab: 'general' }), true);
  assert.equal(nav.update({ query: 'shared', batch: 120, scroll: 713, selected: { kind: 'task', id: 'task:100', revision: 1 }, detail: true }), true);
  const original = structuredClone(nav.view!); refuse = true;
  assert.equal(nav.update({ query: 'replacement' }), false); assert.deepEqual(nav.view, original);
  assert.equal(nav.close('session-one'), false); assert.equal(nav.view?.open, true);
  refuse = false;
  const reopened = new SearchNavigation(scope, io);
  assert.deepEqual(reopened.view, original); assert.equal(reopened.prepareReturn(searchReturn(original)), true);
  assert.equal(matchesSearchReturn(original, { ...searchReturn(original), token: 'another' }, scope), false);
  assert.equal(reopened.update({ scroll: -1 }), false);
  assert.equal(readSearchView(storage.get(searchKey(scope)), { ...scope, epoch: 'other' }), undefined);
  assert.equal(reopened.close('session-one'), true);
  assert.equal(reopened.prepareReturn(searchReturn(original)), false);
});
