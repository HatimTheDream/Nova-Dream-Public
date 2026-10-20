import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyIdeaScope, ideaScopeKey, isIdeaScope, readIdeaScope, retainIdeaScope, readIdeasView, savedAssistantDrafts } from '../apps/client/src/home-ideas-state.js';
import { emptyDraft, type Draft, type Entity } from '../packages/domain/contracts.js';

class Storage {
 rows = new Map<string, string>(); writes = 0; fail = false;
 getItem(key: string) { return this.rows.get(key) ?? null; }
 setItem(key: string, value: string) { if (this.fail) throw Error('Storage full');this.writes++;this.rows.set(key, value); }
}
const key = ideaScopeKey('device:one', 'epoch-one', 'draft-notes');
test('opening an old Idea scope preserves original bytes and every exact selection without a write', () => {
 const storage = new Storage(), value = { ...emptyIdeaScope('draft-notes'), instructions: 'Keep every word\n雪', sources: [{ kind: 'note', id: 'note:one', revision: 8 }] };
 const raw = '  ' + JSON.stringify(value) + '\n';storage.rows.set(key, raw);
 const kept = readIdeaScope(storage, key, 'draft-notes');
 assert.equal(kept.invalid, false);assert.equal(kept.raw, raw);assert.deepEqual(kept.value, value);assert.equal(storage.writes, 0);
});
test('malformed, oversized and incompatible scope records remain untouched and cannot be replaced by fallback defaults', () => {
 for (const raw of ['{"unfinished":', 'x'.repeat(128001), JSON.stringify({ ...emptyIdeaScope('draft-notes'), outputs: ['unknown-output'] }), JSON.stringify({ ...emptyIdeaScope('draft-notes'), sources: [{ kind: 'note', id: 'n', revision: 0 }] })]) {
  const storage = new Storage();storage.rows.set(key, raw);const kept = readIdeaScope(storage, key, 'draft-notes');
  assert.equal(kept.invalid, true);assert.equal(kept.raw, raw);
  assert.throws(() => retainIdeaScope(storage, kept, emptyIdeaScope('draft-notes'), 'draft-notes'));
  assert.equal(storage.rows.get(key), raw);assert.equal(storage.writes, 0);
 }
});
test('another window cannot overwrite a changed scope; storage refusal leaves the exact original intact', () => {
 const storage = new Storage(), kept = readIdeaScope(storage, key, 'draft-notes');
 const edited = { ...kept.value, instructions: 'Newer local writing' };
 storage.fail = true;assert.throws(() => retainIdeaScope(storage, kept, edited, 'draft-notes'), /Storage full/);assert.equal(storage.getItem(key), null);
 storage.fail = false;const other = JSON.stringify({ ...kept.value, instructions: 'Other window' });storage.rows.set(key, other);
 assert.throws(() => retainIdeaScope(storage, kept, edited, 'draft-notes'), /another window/);assert.equal(storage.getItem(key), other);assert.equal(storage.writes, 0);
});
test('retained collection/type/search and all source revisions survive a scope roundtrip with combined limit18', () => {
 const storage = new Storage(), kept = readIdeaScope(storage, key, 'draft-notes');
 const value = { ...kept.value, sources: Array.from({ length: 17 }, (_, i) => ({ kind: 'note' as const, id: 'note:' + i, revision: i + 1 })), tasks: ['task:1'], picker: { collection: 'collection:one', type: 'note' as const, query: 'Exact query', searchOpen: false, limit: 120 } };
 const result = retainIdeaScope(storage, kept, value, 'draft-notes');assert.deepEqual(readIdeaScope(storage, key, 'draft-notes').value, value);assert.equal(result.raw, storage.getItem(key));
 assert.equal(isIdeaScope({ ...value, tasks: ['task:1', 'task:2'] }, 'draft-notes'), false);
 assert.equal(isIdeaScope({ ...value, sources: [value.sources[0], value.sources[0]] }, 'draft-notes'), false);
});
test('view restoration validates identity and never writes malformed original navigation', () => {
 const storage = new Storage();storage.rows.set('view', JSON.stringify({ view: 'drafts', category: 'Writing', selected: 'draft-notes' }));
 assert.deepEqual(readIdeasView(storage, 'view'), { value: { view: 'drafts', category: 'Writing', selected: 'draft-notes' }, invalid: false });
 storage.rows.set('view', '{bad');assert.equal(readIdeasView(storage, 'view').invalid, true);assert.equal(storage.getItem('view'), '{bad');assert.equal(storage.writes, 0);
});
test('saved Assistant drafts keep exact real identities without inferring an Idea from title', () => {
 const entity = (id: string, title: string, text: string): Entity<Draft> => ({ id, revision: 2, deviceId: 'device:one', updatedAt: '2026-10-20T05:00:00Z', value: { ...emptyDraft, title, text } });
 const rows = [entity('draft:a', 'Unrelated writing', 'Keep me'), entity('draft:b', 'Plan My Week', ''), entity('draft:c', 'Renamed writing', 'Hand-edited source text')];
 assert.deepEqual(savedAssistantDrafts(rows).map(d => d.id), ['draft:a', 'draft:c']);assert.equal(rows[0].value.text, 'Keep me');
});
