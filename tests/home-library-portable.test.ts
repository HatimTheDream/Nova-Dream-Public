import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibraryPortable, isLibraryPortable, libraryPortableBytes, libraryPortableUrls, parseLibraryPortable, readLibraryExportQuery, serializeLibraryPortable } from '../packages/domain/home-library-portable.js';
import { captureResultMatches } from '../packages/domain/home-library-view.js';
import type { HomeCollection, HomeItem, HomeLibraryCommand, HomeLibraryReceipt, HomeReference } from '../packages/domain/home-library.js';

const epoch = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222', at = '2026-10-20T12:00:00.000Z';
const note: HomeItem = { id: 'library:note', revision: 3, kind: 'note', title: 'Exact “writing”', body: 'First\r\nSecond\u0000 🌍', archived: false, updatedAt: at };
const link: HomeItem = { id: 'library:link', revision: 1, kind: 'link', title: 'Exact link', body: 'Keep my annotation.', url: 'https://example.com/path?a=2&a=1#original', archived: true, updatedAt: at };
const reference = (item: HomeItem): HomeReference => ({ kind: item.kind, id: item.id, revision: item.revision });
const collection: HomeCollection = { id: 'collection:original', revision: 4, title: 'Saved Sources', subtitle: 'Original scope', icon: 'book', pinned: true, archived: false, updatedAt: at,
 references: [reference(note), reference(link), { kind: 'task', id: 'task:original', revision: 7 }, { kind: 'note', id: 'library:missing', revision: 2 }] };
const query = { epoch, collection: collection.id, revision: collection.revision };
const read = (ref: HomeReference) => [note, link].find(item => item.id === ref.id && item.revision === ref.revision);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const document = () => buildLibraryPortable(epoch, collection, query, at, read);

test('portable exact versions round trip complete Unicode/CRLF writing and explicitly unavailable/internal references', () => {
 const exported = document(), loaded = parseLibraryPortable(encode(exported));
 assert.deepEqual(loaded, exported);
 assert.deepEqual(loaded.entries[0], { position: 0, reference: reference(note), status: 'portable', item: note });
 assert.equal(loaded.entries[1].status, 'portable');
 assert.equal(loaded.entries[2].status, 'reference-only');
 assert.equal(loaded.entries[3].status, 'unavailable');
 assert.equal(loaded.source.collection.pinned, true);
 assert.equal(serializeLibraryPortable(loaded), JSON.stringify(exported));
 assert.deepEqual(libraryPortableUrls(loaded), { text: link.url, included: 1, excluded: 3 });
});

test('export selection follows original member order and preserves original positions', () => {
 const parsed = readLibraryExportQuery(new URLSearchParams({ epoch, collection: collection.id, revision: '4', positions: '3,0,2' }));
 assert.deepEqual(parsed.positions, [0, 2, 3]);
 const exported = buildLibraryPortable(epoch, collection, parsed, at, read);
 assert.equal(exported.selection, 'selected');assert.equal(exported.source.memberCount, 4);
 assert.deepEqual(exported.entries.map(row => row.position), [0, 2, 3]);
 assert.equal(isLibraryPortable(exported), true);
 assert.throws(() => buildLibraryPortable(epoch, collection, { ...query, positions: [4] }, at, read));
});

test('strict query refuses duplicate/unknown parameters, aliases, wrong revision and stale workspace', () => {
 for (const tail of ['&revision=4', '&extra=true', '&positions=0,0', '&positions=01', '&positions=200', '&positions=', '&positions=-1']) {
  assert.throws(() => readLibraryExportQuery(new URLSearchParams(`epoch=${epoch}&collection=${collection.id}&revision=4${tail}`)), tail);
 }
 assert.throws(() => buildLibraryPortable(epoch, collection, { ...query, revision: 5 }, at, read));
 assert.throws(() => buildLibraryPortable(epoch, collection, { ...query, epoch: requestId }, at, read));
});

test('no newer-version or malformed saved-item fallback is exported', () => {
 const newer = buildLibraryPortable(epoch, collection, query, at, ref => ref.kind === 'note' ? { ...note, revision: 4 } : undefined);
 assert.equal(newer.entries[0].status, 'unavailable');
 const malformed = buildLibraryPortable(epoch, collection, query, at, () => ({ ...note, secret: 'must not leak' }));
 assert.equal(malformed.entries[0].status, 'unavailable');
 assert.equal(JSON.stringify(malformed).includes('must not leak'), false);
});

test('unknown/Toby shapes, forged identities, invalid UTF-8 and over-size files refuse without source mutation', () => {
 const original = document(), before = JSON.stringify(original);
 const variants: unknown[] = [{ collections: [] }, { ...original, version: 2 }, { ...original, extra: true },
  { ...original, entries: [{ ...original.entries[0], reference: reference(link) }] },
  { ...original, selection: 'selected', entries: [] },
  { ...original, source: { ...original.source, memberCount: 5 } },
  { ...original, entries: [{ ...original.entries[0], position: 1 }, original.entries[1], ...original.entries.slice(2)] }];
 for (const value of variants) assert.throws(() => parseLibraryPortable(encode(value)));
 assert.throws(() => parseLibraryPortable(new Uint8Array([0xc3, 0x28])));
 assert.throws(() => parseLibraryPortable(new Uint8Array(libraryPortableBytes + 1)));
 assert.equal(JSON.stringify(original), before);
});

test('export stops its cumulative bound before reading later entries; selected empty collection remains honest', () => {
 let reads = 0;
 const large: HomeCollection = { ...collection, references: Array.from({ length: 35 }, (_, index) => ({ kind: 'note', id: `library:${index}`, revision: 1 })) };
 assert.throws(() => buildLibraryPortable(epoch, large, query, at, ref => {
  reads++;return { ...note, id: ref.id, revision: 1, body: '\u0000'.repeat(100000) };
 }), /16 MiB/);
 assert.ok(reads < large.references.length);
 const empty = buildLibraryPortable(epoch, { ...collection, references: [] }, query, at, () => { throw Error('unexpected read'); });
 assert.equal(isLibraryPortable(empty), true);assert.equal(empty.entries.length, 0);
});

function capture() {
 const command: Extract<HomeLibraryCommand, { type: 'items-capture' }> = { type: 'items-capture', requestId, epoch, destination: { id: collection.id, expectedRevision: 4 }, rows: [
  { rowId: 'row:1', id: 'library:new', value: { kind: 'link', title: '  New title  ', body: 'New exact writing', url: 'https://example.com', archived: false } },
  { rowId: 'row:2', id: 'library:duplicate', value: { kind: 'link', title: 'Skipped title', body: 'Keep skipped writing', url: 'https://example.com/', archived: false } },
  { rowId: 'row:3', id: 'library:new-note', value: { kind: 'note', title: 'Note', body: 'Whole body', archived: false } },
 ] };
 const createdItems: HomeItem[] = [{ ...command.rows[0].value, title: 'New title', id: 'library:new', kind: 'link', url: 'https://example.com/', revision: 1, updatedAt: at },
  { ...command.rows[2].value, kind: 'note', id: 'library:new-note', revision: 1, updatedAt: at }];
 const result: HomeLibraryReceipt = { format: 1, type: 'items-capture', operationId: requestId, epoch, appliedAt: at, changed: true,
  collections: [{ ...collection, revision: 5, references: [...collection.references, ...createdItems.map(reference)] }],
  createdItems, outcomes: [
   { rowId: 'row:1', reference: reference(createdItems[0]), disposition: 'created-and-added' },
   { rowId: 'row:2', reference: reference(createdItems[0]), disposition: 'duplicate-in-batch' },
   { rowId: 'row:3', reference: reference(createdItems[1]), disposition: 'created-and-added' },
  ], undo: { operationId: requestId, expected: { collections: [{ id: collection.id, expectedRevision: 5 }], organizationRevision: null } } };
 return { command, result };
}

test('existing capture response joins exact normalized created values/order and duplicate original row identity', () => {
 const { command, result } = capture();
 assert.equal(captureResultMatches(command, result), true);
 assert.equal(result.createdItems.some(item => item.title === 'Skipped title'), false);
 for (const change of [
  (value: HomeLibraryReceipt) => { value.outcomes[1].rowId = 'wrong'; },
  (value: HomeLibraryReceipt) => { value.createdItems[0].body = 'Different writing'; },
  (value: HomeLibraryReceipt) => { value.collections[0].revision = 6;value.undo!.expected.collections[0].expectedRevision = 6; },
  (value: HomeLibraryReceipt) => { value.collections[0].id = 'collection:other';value.undo!.expected.collections[0].id = 'collection:other'; },
  (value: HomeLibraryReceipt) => { value.collections[0].references.reverse(); },
  (value: HomeLibraryReceipt) => { value.outcomes[1].disposition = 'already-in-destination'; },
  (value: HomeLibraryReceipt) => { value.createdItems[0].updatedAt = '2026-10-19T12:00:00.000Z'; },
 ]) { const bad = structuredClone(result);change(bad);assert.equal(captureResultMatches(command, bad), false); }
});

test('unchanged duplicate-only receipt cannot claim imported writing or a new note', () => {
 const { command } = capture();command.rows = command.rows.slice(0, 1);
 const result: HomeLibraryReceipt = { format: 1, operationId: requestId, epoch, type: 'items-capture', appliedAt: at, changed: false, collections: [], createdItems: [],
  outcomes: [{ rowId: 'row:1', reference: reference(link), disposition: 'already-in-destination' }], undo: null };
 assert.equal(captureResultMatches(command, result), true);
 command.rows[0].value = { kind: 'note', title: 'Never deduplicated', body: 'Keep', archived: false };
 assert.equal(captureResultMatches(command, result), false);
});
