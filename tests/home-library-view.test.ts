import test from 'node:test';
import assert from 'node:assert/strict';
import { homeCollectionValueSchema, homeItemValueSchema, homeQuote as hostQuote, homeIdeaScope as hostScope } from '../packages/domain/home-library.js';
import { clockTime } from '../packages/domain/tasks.js';
import { homeClockTime, homeQuote, homeIdeaScope, isHomeCollectionDraft, isHomeItemDraft } from '../packages/domain/home-library-view.js';

const collection = { title: '', subtitle: '', icon: 'folder', pinned: false, archived: false, references: [] };
const note = { kind: 'note', title: '', body: '', archived: false };
const link = { kind: 'link', title: '', url: '', body: '', archived: false };
function oldCollection(value: unknown) { try { const v = value as typeof collection;return typeof v.title === 'string' && v.title.length <= 100 && homeCollectionValueSchema.safeParse({ ...v, title: 'Untitled' }).success; } catch { return false; } }
function oldItem(value: unknown) { try { const v = value as typeof link;return typeof v.title === 'string' && v.title.length <= 150 && (v.kind !== 'link' || typeof v.url === 'string' && v.url.length <= 2048) && homeItemValueSchema.safeParse({ ...v, title: 'Untitled', ...(v.kind === 'link' ? { url: 'https://example.test' } : {}) }).success; } catch { return false; } }

test('schema-free local draft guards preserve incomplete writing and strict former restore bounds', () => {
 const ref = { kind: 'note', id: 'library:one', revision: 1 }, changedRef = { ...ref, revision: 2 };
 const collections: unknown[] = [null, undefined, [], {}, collection, { ...collection, title: '  ' }, { ...collection, title: 'a'.repeat(100) }, { ...collection, title: 'a'.repeat(101) }, { ...collection, subtitle: 'a'.repeat(240) }, { ...collection, subtitle: 'a'.repeat(241) }, { ...collection, pinned: 0 }, { ...collection, archived: null }, { ...collection, icon: 'unknown' }, { ...collection, extra: true }, { ...collection, references: [ref] }, { ...collection, references: [ref, changedRef] }, { ...collection, references: [{ ...ref, revision: 0 }] }, { ...collection, references: [{ ...ref, revision: 1.5 }] }, { ...collection, references: [{ ...ref, revision: Number.MAX_SAFE_INTEGER + 1 }] }, { ...collection, references: [{ ...ref, id: '' }] }, { ...collection, references: [{ ...ref, id: 'a'.repeat(200) }] }, { ...collection, references: [{ ...ref, id: 'a'.repeat(200) + '\n' }] }, { ...collection, references: [{ ...ref, kind: 'unknown' }] }, { ...collection, references: [{ ...ref, extra: true }] }, { ...collection, references: [{ ...ref, sha256: 'a'.repeat(64) }] }, { ...collection, references: [{ ...ref, sha256: 'bad' }] }, { ...collection, references: [{ ...ref, sha256: null }] }, { ...collection, references: [null] }, { ...collection, references: Array.from({ length: 200 }, (_, n) => ({ ...ref, id: `note:${n}` })) }, { ...collection, references: Array.from({ length: 201 }, (_, n) => ({ ...ref, id: `note:${n}` })) }];
 for (const [index, value] of collections.entries()) assert.equal(isHomeCollectionDraft(value), oldCollection(value), `collection case ${index}`);
 const items: unknown[] = [null, undefined, [], {}, note, link, { ...note, title: '  ' }, { ...link, url: 'javascript:void(0)' }, { ...link, url: 'https://user:pass@example.test' }, { ...link, url: 'a'.repeat(2048) }, { ...link, url: 'a'.repeat(2049) }, { ...link, url: null }, { ...link, extra: true }, { ...note, url: '' }, { ...note, title: 'a'.repeat(150) }, { ...note, title: 'a'.repeat(151) }, { ...note, body: 'a'.repeat(100000) }, { ...note, body: 'a'.repeat(100001) }, { ...link, body: 'a'.repeat(10000) }, { ...link, body: 'a'.repeat(10001) }, { ...note, kind: 'unknown' }, { ...note, archived: 0 }, { ...note, body: null }];
 for (const [index, value] of items.entries()) assert.equal(isHomeItemDraft(value), oldItem(value), `item case ${index}`);
 assert.ok(isHomeItemDraft(link));assert.ok(isHomeItemDraft({ ...link, url: 'javascript:void(0)' }));
 assert.equal(homeItemValueSchema.safeParse({ ...link, title: 'Unsafe Link', url: 'javascript:void(0)' }).success, false, 'draft restoration never replaces host URL validation');
 assert.equal(homeCollectionValueSchema.safeParse(collection).success, false, 'unfinished titles remain a draft rather than a valid host save');
});

test('local planning time predicate matches the existing clock format including blank drafts', () => {
 for (let hours = 0; hours < 24; hours++) for (let minutes = 0; minutes < 60; minutes++) { const value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;assert.equal(homeClockTime(value), clockTime.safeParse(value).success); }
 for (const value of ['', '24:00', '23:60', '9:00', '09:0', '09:00:00', ' 09:00', '09:00\n', 0, null, undefined]) assert.equal(homeClockTime(value), clockTime.safeParse(value).success);
});

test('host helper exports retain their original function identities', () => { assert.equal(hostQuote, homeQuote);assert.equal(hostScope, homeIdeaScope); });
