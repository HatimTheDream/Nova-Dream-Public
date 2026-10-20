import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/service/store.js';
import { HomeLibrary } from '../apps/service/home-library.js';
import { shelvesKey, shelvesOperationKey, shelvesUndoneKey } from '../apps/service/home-library-shelves.js';
import { homeShelvesSchema, type HomeCollection, type HomeItem, type HomeShelvesCommand, type HomeShelvesReceipt, type HomeReference, type LibraryReceipt } from '../packages/domain/home-library.js';
import { emptyHomeShelves, isHomeLibraryCommand, isHomeShelves, isHomeShelvesReceipt, readHomeLibraryState } from '../packages/domain/home-library-view.js';

function setup() {
 const directory = mkdtempSync(join(tmpdir(), 'nova-library-shelves-')), store = new Store(directory);
 const device = store.session().deviceId, library = new HomeLibrary(store);
 const envelope = () => ({ requestId: randomUUID(), epoch: store.epoch });
 const command = (input: HomeShelvesCommand) => {
  assert.equal(isHomeLibraryCommand(input), true);
  const result = library.command(device, input) as HomeShelvesReceipt;
  assert.equal(isHomeShelvesReceipt(result), true);return result;
 };
 const value = () => { const state = library.state(device).shelves!;assert.equal(state.status, 'ready');if (state.status !== 'ready') throw Error();return state.value; };
 const space = (id = 'space:one', name = 'Work') => command({ ...envelope(), type: 'space-save', expectedRevision: value().revision, id, name });
 const note = (id = 'note:one', revision = 0, body = 'Original writing') => library.command(device, {
  ...envelope(), type: 'item-save', id, expectedRevision: revision, value: { kind: 'note', title: id, body, archived: false },
 }) as HomeItem;
 const collection = (id = 'collection:one') => library.command(device, {
  ...envelope(), type: 'collection-save', id, expectedRevision: 0,
  value: { title: id, subtitle: '', icon: 'folder', pinned: false, archived: false, references: [] },
 }) as HomeCollection;
 return { directory, store, device, library, envelope, command, value, space, note, collection };
}
function fixture(run: (f: ReturnType<typeof setup>) => void) {
 const f = setup();let passed = false;
 try { run(f);passed = true; } finally {
  f.store.close();
  if (passed) { assert.ok(resolve(f.directory).startsWith(resolve(tmpdir()) + '\\') || resolve(f.directory).startsWith(resolve(tmpdir()) + '/'));rmSync(f.directory, { recursive: true }); }
  else console.error('Preserved failed shelves fixture:', f.directory);
 }
}
const reference = (item: HomeItem): HomeReference => ({ kind: item.kind, id: item.id, revision: item.revision });

test('shelves reads are pure and legacy state gets an empty projection without writing', () => fixture(f => {
 const before = f.store.captureBackup('before', { status: 'not-configured', notes: [] });
 const state = f.library.state(f.device);assert.deepEqual(state.shelves, { status: 'ready', value: emptyHomeShelves() });
 const { shelves: _shelves, ...legacy } = state;
 assert.deepEqual(readHomeLibraryState(legacy)?.shelves, state.shelves);
 assert.equal(f.store.internalRead(shelvesKey), undefined);
 const after = f.store.captureBackup('after', { status: 'not-configured', notes: [] });
 assert.deepEqual(after.services, before.services);assert.deepEqual(after.receipts, before.receipts);
}));

test('Space assignment/archive/restore preserves exact collection rows and authored names', () => fixture(f => {
 const collection = f.collection(), before = f.store.internalList('home:library:collection:');
 f.space('space:one', '  Work  ');
 f.command({ ...f.envelope(), type: 'collection-assign', expectedRevision: 1, collection: { id: collection.id, expectedRevision: 1 }, spaceId: 'space:one' });
 f.command({ ...f.envelope(), type: 'space-archive', expectedRevision: 2, id: 'space:one', archived: true });
 assert.deepEqual(f.value().assignments, [{ collectionId: collection.id, spaceId: 'space:one' }]);
 assert.equal(f.value().spaces[0].name, '  Work  ');
 assert.throws(() => f.space('space:other', 'ｗｏｒｋ'), /distinct name/);
 f.command({ ...f.envelope(), type: 'space-archive', expectedRevision: 3, id: 'space:one', archived: false });
 assert.deepEqual(f.store.internalList('home:library:collection:'), before);
 assert.equal(f.value().spaces[0].archived, false);
}));

test('assignment requires exact active collection and active Space; no partial write', () => fixture(f => {
 const collection = f.collection();f.space();
 const original = f.store.internalList('home:library:');
 const input = { ...f.envelope(), type: 'collection-assign' as const, expectedRevision: 1, collection: { id: collection.id, expectedRevision: 9 }, spaceId: 'space:one' };
 assert.throws(() => f.command(input), /collection changed/);
 assert.deepEqual(f.store.internalList('home:library:'), original);
 assert.throws(() => f.command({ ...input, ...f.envelope(), collection: { ...input.collection, expectedRevision: 1 }, spaceId: 'space:missing' }), /active destination/);
 f.command({ ...f.envelope(), type: 'space-archive', expectedRevision: 1, id: 'space:one', archived: true });
 assert.throws(() => f.command({ ...input, ...f.envelope(), expectedRevision: 2, collection: { ...input.collection, expectedRevision: 1 } }), /active destination/);
}));

test('shelf-only historical link resolves its exact URL; duplicate saved version is a no-op', () => fixture(f => {
 const input = { type: 'item-save' as const, id: 'link:one', expectedRevision: 0, value: { kind: 'link' as const, title: 'Original', url: 'https://example.com/original', body: '', archived: false } };
 const item = f.library.command(f.device, { ...f.envelope(), ...input }) as HomeItem, ref = reference(item);
 const added = f.command({ ...f.envelope(), type: 'up-next-add', expectedRevision: 0, reference: ref });
 f.library.command(f.device, { ...f.envelope(), ...input, expectedRevision: 1, value: { ...input.value, title: 'New', url: 'https://example.com/new' } });
 const state = f.library.state(f.device);
 assert.equal(state.collections.length, 0);
 const old = state.resources.find(row => row.reference.id === item.id && row.reference.revision === 1)!;
 assert.equal(old.url, input.value.url);assert.equal(old.availability, 'changed');
 const duplicate = f.command({ ...f.envelope(), type: 'up-next-add', expectedRevision: 1, reference: ref });
 assert.equal(duplicate.changed, false);assert.equal(duplicate.undo, null);assert.equal(duplicate.shelves.revision, 1);
 assert.throws(() => f.command({ ...f.envelope(), type: 'up-next-add', expectedRevision: 1, reference: { ...ref, revision: 2 } }), /another version/);
 assert.deepEqual(f.library.command(f.device, { requestId: added.operationId, epoch: added.epoch, type: 'up-next-add', expectedRevision: 0, reference: ref }), added);
}));

test('Up Next order preserves full exact membership; missing entries remove without source mutation', () => fixture(f => {
 const a = reference(f.note('note:a')), b = reference(f.note('note:b'));
 f.command({ ...f.envelope(), type: 'up-next-add', expectedRevision: 0, reference: a });
 f.command({ ...f.envelope(), type: 'up-next-add', expectedRevision: 1, reference: b });
 assert.throws(() => f.command({ ...f.envelope(), type: 'up-next-order', expectedRevision: 2, references: [b] }), /every exact/);
 f.note('note:a', 1, 'New writing');
 const sources = f.store.internalList('home:library:item:');
 f.command({ ...f.envelope(), type: 'up-next-order', expectedRevision: 2, references: [b, a] });
 f.command({ ...f.envelope(), type: 'up-next-remove', expectedRevision: 3, reference: a });
 assert.deepEqual(f.value().upNext, [b]);assert.deepEqual(f.store.internalList('home:library:item:'), sources);
 assert.throws(() => f.command({ ...f.envelope(), type: 'up-next-add', expectedRevision: 4, reference: { kind: 'note', id: 'missing', revision: 1 } }), /changed or disappeared/);
}));

test('new Undo is opaque to legacy Undo and restores exactly once with monotonic revision', () => fixture(f => {
 const saved = f.space();
 assert.ok(f.store.internalRead(shelvesOperationKey + saved.operationId));
 assert.equal(f.store.internalRead('home:library:operation:' + saved.operationId), undefined);
 assert.throws(() => f.library.command(f.device, { ...f.envelope(), type: 'library-undo', operationId: saved.operationId,
  expected: { collections: [], organizationRevision: null } }), /original organization/);
 assert.equal(f.store.internalRead('home:library:undone:' + saved.operationId), undefined);
 const undo = { ...f.envelope(), type: 'shelves-undo' as const, ...saved.undo! };
 const undone = f.command(undo);assert.equal(undone.shelves.revision, 2);assert.deepEqual(undone.shelves.spaces, []);
 assert.ok(f.store.internalRead(shelvesUndoneKey + saved.operationId));
 assert.deepEqual(f.command(undo), undone);
 assert.throws(() => f.command({ ...undo, ...f.envelope(), expectedRevision: 2 }), /exact confirmed/);
}));

test('old collection Undo leaves later shelves exact; shelves Undo refuses intervening changes', () => fixture(f => {
 const c = f.collection();
 const changed = f.library.command(f.device, { ...f.envelope(), type: 'collection-save', id: c.id, expectedRevision: c.revision,
  value: { title: c.title, subtitle: c.subtitle, icon: c.icon, pinned: true, archived: false, references: [] } }) as HomeCollection;
 const legacyOperation = f.store.internalList<{ device: string }>('home:library:operation:');
 assert.equal(legacyOperation.length, 1);
 const operationId = f.store.captureBackup('ops', { status: 'not-configured', notes: [] }).services.find(row => row.id.startsWith('home:library:operation:'))!.id.slice('home:library:operation:'.length);
 const first = f.space();f.space('space:two', 'Personal');const before = f.value();
 f.library.command(f.device, { ...f.envelope(), type: 'library-undo', operationId, expected: { collections: [{ id: c.id, expectedRevision: changed.revision }], organizationRevision: null } }) as LibraryReceipt;
 assert.deepEqual(f.value(), before);
 assert.throws(() => f.command({ ...f.envelope(), type: 'shelves-undo', ...first.undo!, expectedRevision: before.revision }), /exact confirmed/);
}));

test('unreadable shelves stay intact and ordinary Library editing remains usable', () => fixture(f => {
 const raw = { format: 99, revision: 4, unfinished: 'Keep original bytes' };f.store.internalWrite(shelvesKey, raw);
 f.note();const state = f.library.state(f.device);
 assert.equal(state.shelves?.status, 'needs-review');assert.equal(state.items[0].body, 'Original writing');
 assert.ok(readHomeLibraryState(state));
 assert.throws(() => f.command({ ...f.envelope(), type: 'space-save', expectedRevision: 0, id: 'space:new', name: 'New' }), /need review/);
 assert.deepEqual(f.store.internalRead(shelvesKey), raw);
}));

test('limits, duplicates and original epoch/request authority refuse atomically', () => fixture(f => {
 const full = { ...emptyHomeShelves(), revision: 1, spaces: Array.from({ length: 32 }, (_, n) => ({ id: `space:${n}`, name: `Space ${n}`, archived: n % 2 === 0 })) };
 f.store.internalWrite(shelvesKey, full);
 assert.equal(isHomeShelves(full), true);assert.equal(homeShelvesSchema.safeParse(full).success, true);
 assert.throws(() => f.command({ ...f.envelope(), type: 'space-save', expectedRevision: 1, id: 'space:new', name: 'New' }), /32 Space slots/);
 assert.deepEqual(f.value(), full);
 const input = { ...f.envelope(), type: 'space-save' as const, expectedRevision: 1, id: 'space:1', name: 'Renamed' };
 const saved = f.command(input);assert.deepEqual(f.command(input), saved);
 assert.throws(() => f.command({ ...input, name: 'Other' }), /already used/);
 assert.throws(() => f.command({ ...input, ...f.envelope(), epoch: randomUUID() }), /workspace changed/);
 assert.throws(() => f.command({ ...input, ...f.envelope() }), /Up Next changed/);
 const bad = { ...full, spaces: [...full.spaces, full.spaces[0]] };
 assert.equal(isHomeShelves(bad), false);assert.equal(homeShelvesSchema.safeParse(bad).success, false);
}));

test('failed inverse persistence rolls back shelves and original receipt together', () => fixture(f => {
 const input = { ...f.envelope(), type: 'space-save' as const, expectedRevision: 0, id: 'space:one', name: 'Work' };
 const write = f.store.internalWrite.bind(f.store);
 f.store.internalWrite = ((id: string, value: unknown) => { if (id.startsWith(shelvesOperationKey)) throw Error('Injected inverse failure');return write(id, value); }) as typeof f.store.internalWrite;
 try { assert.throws(() => f.command(input), /inverse failure/); } finally { f.store.internalWrite = write; }
 assert.equal(f.store.internalRead(shelvesKey), undefined);
 assert.equal(f.command(input).shelves.revision, 1);
}));

test('full shelves and assignment capacity retain every hidden or missing member', () => fixture(f => {
 const collection = f.collection(), item = f.note();
 const full = { ...emptyHomeShelves(), revision: 1, spaces: [{ id: 'space:one', name: 'Work', archived: false }],
  assignments: Array.from({ length: 100 }, (_, i) => ({ collectionId: `collection:kept:${i}`, spaceId: 'space:one' })),
  upNext: Array.from({ length: 200 }, (_, i) => ({ kind: 'note' as const, id: `note:kept:${i}`, revision: 1 })) };
 f.store.internalWrite(shelvesKey, full);
 assert.throws(() => f.command({ ...f.envelope(), type: 'up-next-add', expectedRevision: 1, reference: reference(item) }), /200 sources/);
 assert.throws(() => f.command({ ...f.envelope(), type: 'collection-assign', expectedRevision: 1, collection: { id: collection.id, expectedRevision: 1 }, spaceId: 'space:one' }), /100 saved assignments/);
 assert.deepEqual(f.value(), full);
 assert.equal(f.library.state(f.device).resources.filter(row => row.availability === 'missing').length, 200);
}));

test('strict shelves receipts and foreign Undo owner never grant new authority', () => fixture(f => {
 const saved = f.space();
 assert.equal(isHomeShelvesReceipt({ ...saved, changed: false }), false);
 assert.equal(isHomeShelvesReceipt({ ...saved, unexpected: true }), false);
 assert.equal(isHomeShelvesReceipt({ ...saved, undo: { ...saved.undo, expectedRevision: 99 } }), false);
 assert.throws(() => f.library.command(randomUUID(), { ...f.envelope(), type: 'shelves-undo', ...saved.undo! }), /exact confirmed/);
 assert.equal(f.value().revision, 1);
}));
