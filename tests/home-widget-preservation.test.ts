import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store, Fault } from '../apps/service/store.js';
import { HomeLibrary } from '../apps/service/home-library.js';
import { deriveHomeWidgetPreservation, homeLibraryWithinCapacity, homeWidgetPreservationKey, homeWidgetPreservationState, preserveHomeWidgets, verifiedHomeWidgetPreservation } from '../apps/service/home-widget-preservation.js';
import { defaultLayout, type Command, type Entity, type Layout } from '../packages/domain/contracts.js';
import type { HomeItem, HomeItemValue } from '../packages/domain/home-library.js';
import { readHomeLibraryState } from '../packages/domain/home-library-view.js';
import type { HomeWidget } from '../packages/domain/home-widgets.js';
const native = { status: 'not-configured' as const, notes: [] };
const widget = (type: 'note' | 'links', settings: HomeWidget['settings'], hidden = false): HomeWidget => ({ id: `widget:${randomUUID()}`, type, size: 'wide', hidden, title: type === 'note' ? 'Original Note' : 'Original Links', settings });
function fixture(run: (store: Store, library: HomeLibrary, root: string) => void) {
 const root = mkdtempSync(join(tmpdir(), 'nova-home-preserve-')), store = new Store(join(root, 'workspace'));
 try { run(store, new HomeLibrary(store), root); } finally {
  store.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'nova-home-preserve-')); rmSync(root, { recursive: true, force: true });
 }
}
const envelope = (store: Store) => ({ requestId: randomUUID(), epoch: store.epoch });
function layout(store: Store, widgets: HomeWidget[]) {
 const current = store.readEntity('layout', 'layout')!;
 const command = { ...envelope(store), kind: 'layout', entityId: 'layout', expectedRevision: current.revision, payload: { ...current.value, widgets } } satisfies Command;
 return { command, saved: store.mutate('owner', command) as Entity<Layout> };
}
function savedItem(store: Store, id: string, value: HomeItemValue) {
 const item = { ...value, id, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' } as HomeItem;
 store.internalWrite(`home:library:version:item-save:${id}:1`, item); store.internalWrite('home:library:item:' + id, item); return item;
}
const stable = (store: Store) => {
 const { id: _id, createdAt: _created, ...value } = store.captureBackup('test', native); return value;
};

test('deterministic preservation retains hidden writing, link order and duplicate URLs as distinct identities', () => fixture((store, library) => {
 const note = widget('note', { text: '  Original\n雪 🌿\nwriting  ' }, true);
 const links = widget('links', { links: [{ id: randomUUID(), label: 'First', url: 'https://example.com/a?q=2&v=1#saved' }, { id: randomUUID(), label: 'Second', url: 'https://example.com/a?q=2&v=1#saved' }] }, true);
 const empty = widget('links', { links: [] }); empty.title = 'Empty but authored';
 const { saved } = layout(store, [note, links, empty]), before = stable(store);
 const a = deriveHomeWidgetPreservation(saved, store.epoch), b = deriveHomeWidgetPreservation(saved, store.epoch);
 assert.deepEqual(a, b); assert.equal(a.items.length, 4); assert.equal(new Set(a.items.map(item => item.id)).size, 4);
 assert.equal(a.items[0].body, note.settings!.text); assert.equal(a.items[3].title, empty.title);
 assert.equal(preserveHomeWidgets(store).status, 'ready');
 const after = stable(store);
 for (const key of ['entities', 'history', 'receipts', 'files', 'references', 'epoch', 'cursor'] as const) assert.deepEqual(after[key], before[key]);
 assert.deepEqual(after.services.filter(row => before.services.some(old => old.id === row.id)), before.services);
 assert.equal(after.services.length - before.services.length, 9);
 assert.equal(library.state('owner').resources.some(resource => resource.reference.kind === 'widget'), false, 'retired originals are not duplicate new-source choices');
 assert.ok(readHomeLibraryState(library.state('owner')));
 const once = stable(store); preserveHomeWidgets(store); assert.deepEqual(stable(store), once, 'second initialization does not rewrite records');
}));

test('complete 24-widget derivation has bounded provenance and full 288-row identity allowance', () => fixture(store => {
 const widgets = Array.from({ length: 24 }, () => widget('links', { links: Array.from({ length: 12 }, (_, n) => ({ id: randomUUID(), label: `Link ${n}`, url: 'https://example.com/same' })) }));
 const { saved } = layout(store, widgets), derived = deriveHomeWidgetPreservation(saved, store.epoch);
 assert.equal(derived.items.length, 288); assert.equal(new Set(derived.items.map(item => item.id)).size, 288);
 assert.equal(derived.manifest.allowance.bodyCharacters, 0);
 assert.throws(() => deriveHomeWidgetPreservation({ ...saved, value: { ...saved.value, widgets: [...widgets, widgets[0]] } }, store.epoch));
 const duplicate = structuredClone(widgets); duplicate[0].settings!.links![1].id = duplicate[0].settings!.links![0].id;
 assert.throws(() => deriveHomeWidgetPreservation({ ...saved, value: { ...saved.value, widgets: duplicate } }, store.epoch));
}));

test('full ordinary quotas preserve widgets without consuming collections or granting growth allowance', () => fixture((store, library) => {
 for (let n = 0; n < 300; n++) savedItem(store, 'library:ordinary:' + n, { kind: 'note', title: 'Existing ' + n, body: n < 20 ? 'x'.repeat(100000) : '', archived: false });
 for (let n = 0; n < 100; n++) store.internalWrite('home:library:collection:collection:' + n, { id: 'collection:' + n, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z', title: 'Collection ' + n, subtitle: '', icon: 'book', pinned: false, archived: false, references: [] });
 layout(store, [widget('note', { text: 'Original' }, true)]);
 assert.equal(preserveHomeWidgets(store).status, 'ready');
 const state = library.state('owner'); assert.equal(state.items.length, 301); assert.equal(state.collections.length, 100); assert.ok(readHomeLibraryState(state));
 const imported = state.items.find(item => item.id.startsWith('library:home:'))!;
 assert.throws(() => library.command('owner', { ...envelope(store), type: 'item-save', id: 'library:extra', expectedRevision: 0, value: { kind: 'note', title: 'Extra', body: '', archived: false } }), /storage is full/);
 assert.throws(() => library.command('owner', { ...envelope(store), type: 'items-capture', destination: { id: 'collection:0', expectedRevision: 1 }, rows: [{ rowId: 'new', id: 'library:extra', value: { kind: 'note', title: 'Extra', body: '', archived: false } }] }), /capacity/);
 assert.throws(() => library.command('owner', { ...envelope(store), type: 'item-save', id: imported.id, expectedRevision: 1, value: { kind: 'note', title: 'Larger', body: 'Original plus new growth', archived: false } }), /storage is full/);
 const edited = library.command('owner', { ...envelope(store), type: 'item-save', id: imported.id, expectedRevision: 1, value: { kind: 'note', title: 'Edited later', body: 'Kept', archived: true } }) as HomeItem;
 assert.equal(preserveHomeWidgets(store).status, 'ready'); assert.deepEqual(store.internalRead('home:library:item:' + imported.id), edited);
 assert.equal(verifiedHomeWidgetPreservation(store)!.items[0].body, 'Original');
}));

test('initial authenticated allowance is fixed despite later editing or forged manifest values', () => fixture((store, library) => {
 layout(store, [widget('note', { text: 'Original' })]); preserveHomeWidgets(store);
 const original = verifiedHomeWidgetPreservation(store)!, item = original.items[0];
 library.command('owner', { ...envelope(store), type: 'item-save', id: item.id, expectedRevision: 1, value: { kind: 'note', title: item.title, body: 'Later writing', archived: false } });
 assert.equal(verifiedHomeWidgetPreservation(store)!.manifest.allowance.bodyCharacters, 8);
 store.internalWrite(homeWidgetPreservationKey, { ...original.manifest, allowance: { items: 500, bodyCharacters: 9000000 } });
 assert.equal(homeWidgetPreservationState(store).status, 'needs-review');
 assert.equal(homeLibraryWithinCapacity(store, Array.from({ length: 301 }, (_, n) => ({ ...item, id: 'library:fake:' + n }))), false);
 const ordinary = library.command('owner', { ...envelope(store), type: 'item-save', id: 'library:ordinary', expectedRevision: 0, value: { kind: 'note', title: 'Unrelated', body: 'Still editable within ordinary limits', archived: false } }) as HomeItem;
 assert.equal(ordinary.body, 'Still editable within ordinary limits');
 assert.equal(library.state('owner').resources.some(resource => resource.reference.kind === 'widget'), true, 'unverified migration keeps original sources reachable');
}));

test('collision and interrupted atomic writes retain every original without partial copies', () => fixture(store => {
 const { saved } = layout(store, [widget('note', { text: 'First' }), widget('note', { text: 'Second' })]);
 const proposed = deriveHomeWidgetPreservation(saved, store.epoch);
 savedItem(store, proposed.items[0].id, { kind: 'note', title: 'Existing identity', body: 'Do not replace', archived: false });
 const collision = stable(store); assert.equal(preserveHomeWidgets(store).status, 'needs-review'); assert.deepEqual(stable(store), collision);
 store.internalDelete('home:library:item:' + proposed.items[0].id); store.internalDelete(`home:library:version:item-save:${proposed.items[0].id}:1`);
 const before = stable(store), write = store.internalWrite.bind(store); let count = 0;
 store.internalWrite = ((id: string, value: unknown) => { if (++count === 3) throw Error('Injected storage refusal'); return write(id, value); }) as Store['internalWrite'];
 assert.equal(preserveHomeWidgets(store).status, 'needs-review'); store.internalWrite = write; assert.deepEqual(stable(store), before);
}));

test('current and earlier original references keep exact text without new historical capture', () => fixture((store, library) => {
 const note = widget('note', { text: 'First words' }), first = layout(store, [note]);
 const ref = { kind: 'widget' as const, id: note.id, revision: first.saved.revision }, captureInput = { ...envelope(store), references: [ref] };
 const capture = library.capture('owner', captureInput);
 const second = layout(store, [{ ...note, settings: { text: 'Second words' } }]); preserveHomeWidgets(store);
 assert.equal(library.resolve('owner', ref).text, 'First words');
 assert.equal(library.resolve('owner', { ...ref, revision: second.saved.revision }).text, 'Second words');
 assert.equal(library.resolve('owner', ref).availability, 'changed');
 assert.deepEqual(library.capture('owner', captureInput), capture);
 assert.throws(() => library.capture('owner', { ...envelope(store), references: [ref] }), /changed/);
 assert.throws(() => library.capture('owner', { ...envelope(store), references: [{ ...ref, revision: second.saved.revision }] }), /changed/);
 assert.equal(library.resolve('owner', { ...ref, revision: 999 }).availability, 'missing');
 assert.equal(library.resolve('owner', { ...ref, sha256: 'a'.repeat(64) }).availability, 'missing');
}));

test('legacy command replay precedes widget retirement and unrelated Appearance remains editable', () => fixture(store => {
 const original = layout(store, [widget('note', { text: 'Accepted original' })]); preserveHomeWidgets(store);
 assert.deepEqual(store.mutate('owner', original.command), original.saved);
 assert.throws(() => store.mutate('another-device', original.command), /another device|different device|request/i);
 const pending = { ...original.command, ...envelope(store), expectedRevision: original.saved.revision, payload: { ...original.saved.value, theme: 'dark', widgets: [widget('note', { text: 'Kept old editor proposal' })] } } satisfies Command;
 const exactPending = structuredClone(pending);
 assert.throws(() => store.mutate('owner', pending), (reason: unknown) => reason instanceof Fault && reason.code === 'revision_conflict');
 assert.deepEqual(pending, exactPending); assert.deepEqual(store.readEntity('layout', 'layout'), original.saved);
 const appearance = store.mutate('owner', { ...pending, ...envelope(store), payload: { ...original.saved.value, theme: 'dark' } }) as Entity<Layout>;
 assert.equal(appearance.value.theme, 'dark'); assert.equal(homeWidgetPreservationState(store).status, 'ready');
}));

test('older-writer changed Layout is preserved as recovery state without remigration', () => fixture((store, _library, root) => {
 layout(store, [widget('note', { text: 'Original generation' })]); preserveHomeWidgets(store);
 const preserved = verifiedHomeWidgetPreservation(store)!;
 const portable = store.captureBackup('test', native);
 // An older schema55 writer does not know the retirement marker. Model its
 // genuine new Layout revision in a complete backup, leaving the old history intact.
 const current = portable.entities.find(entity => entity.id === 'layout')!;
 current.revision++; (current.value as Layout).widgets[0].settings!.text = 'Later old-editor writing';
 const { kind: _kind, ...historical } = current;
 portable.cursor++; portable.history.push({ cursor: portable.cursor, entityId: 'layout', revision: current.revision, value: structuredClone(historical) });
 const restored = Store.restoreBackup(join(root, 'older-writer'), portable);
 try {
  const before = stable(restored); assert.equal(preserveHomeWidgets(restored).status, 'changed'); assert.deepEqual(stable(restored), before);
  restored.activateRecoveredLocal(); const active = stable(restored);
  const state = preserveHomeWidgets(restored); assert.equal(state.status, 'changed');
  assert.equal((state.current!.widgets[0] as HomeWidget).settings!.text, 'Later old-editor writing');
  assert.equal((state.original!.widgets[0] as HomeWidget).settings!.text, 'Original generation');
  assert.deepEqual(verifiedHomeWidgetPreservation(restored)!.items, preserved.items); assert.deepEqual(stable(restored), active);
 } finally { restored.close(); }
}));

test('held, maintenance and review-only copies never initialize preservation; activated copies may', () => fixture((store, _library, root) => {
 layout(store, [widget('note', { text: 'Unmigrated original' })]);
 store.setUpdateMaintenanceHeld(true); const held = stable(store);
 assert.equal(preserveHomeWidgets(store).status, 'held'); assert.deepEqual(stable(store), held);
 store.setUpdateMaintenanceHeld(false);
 const restored = Store.restoreBackup(join(root, 'restored'), store.captureBackup('test', native));
 try {
  const before = stable(restored); assert.equal(preserveHomeWidgets(restored).status, 'held'); assert.deepEqual(stable(restored), before);
  restored.activateRecoveredLocal(); assert.equal(preserveHomeWidgets(restored).status, 'ready');
 } finally { restored.close(); }
 const readonly = new Store(join(root, 'readonly'), undefined, undefined, true);
 try { const before = stable(readonly); assert.equal(preserveHomeWidgets(readonly).status, 'held'); assert.deepEqual(stable(readonly), before); } finally { readonly.close(); }
}));

test('client reader accepts bounded recovery state but no forged state expansion', () => fixture((store, library) => {
 layout(store, [widget('note', { text: 'Kept' })]); preserveHomeWidgets(store);
 const state = library.state('owner'); assert.ok(readHomeLibraryState(state));
 assert.equal(readHomeLibraryState({ ...state, homePreservation: { ...state.homePreservation, mappings: Array(289).fill(state.homePreservation!.mappings[0]) } }), undefined);
 assert.equal(readHomeLibraryState({ ...state, homePreservation: { ...state.homePreservation, status: 'complete-without-proof' } }), undefined);
 assert.equal(readHomeLibraryState({ ...state, items: Array.from({ length: 589 }, (_, n) => ({ ...state.items[0], id: 'library:' + n })) }), undefined);
 const legacy = { ...state }; delete legacy.homePreservation; assert.ok(readHomeLibraryState(legacy));
}));
