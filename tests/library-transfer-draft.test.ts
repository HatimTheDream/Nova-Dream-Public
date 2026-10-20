import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LibraryTransferDraftOwner, isLibraryTransferDraft, type LibraryTransferDraft } from '../apps/client/src/library-transfer-draft';
import { keepImportedLibraryText, readBoundedLibraryResponse, readLibraryInput } from '../apps/client/src/library-transfer-file';
import { isHomeLibraryCommand } from '../packages/domain/home-library-view';
import type { HomeLibraryReceipt } from '../packages/domain/home-library';

const scope = () => ({ deviceId: 'device:transfer', epoch: randomUUID(), windowId: 'window:transfer' });
const draft = (): LibraryTransferDraft => ({ file: { name: 'selected.json', sha256: 'a'.repeat(64), format: 'nova-json', entries: 1, unsupported: 0, archived: 0 },
 destination: { id: 'collection:target', expectedRevision: 4 },
 rows: [{ position: 199, rowId: 'row:original', id: 'library:original', selected: true, value: { kind: 'note', title: 'Exact note', body: 'Full\nwriting Ω', archived: false } }] });
function fixture() {
 const map = new Map<string, string>(), faults = { read: false, write: false, afterWrite: false }, lifetime = { active: true };
 const io = { getItem: (key: string) => { if (faults.read) throw Error('Synthetic read refusal');return map.get(key) ?? null; },
  setItem: (key: string, value: string) => { if (faults.write) throw Error('Synthetic write refusal');map.set(key, value);if (faults.afterWrite) { faults.afterWrite = false;faults.read = true; } } };
 const identity = scope(), owner = new LibraryTransferDraftOwner(io, identity, () => lifetime.active);
 return { map, faults, lifetime, io, identity, owner };
}
function receipt(command: NonNullable<ReturnType<LibraryTransferDraftOwner['command']>>): HomeLibraryReceipt {
 const time = '2026-10-20T12:00:00.000Z', reference = { kind: 'note' as const, id: command.rows[0].id, revision: 1 };
 return { format: 1, operationId: command.requestId, epoch: command.epoch, type: 'items-capture', appliedAt: time, changed: true,
  outcomes: [{ reference, rowId: command.rows[0].rowId, disposition: 'created-and-added' }],
  createdItems: [{ ...command.rows[0].value, kind: 'note', id: reference.id, revision: 1, updatedAt: time }],
  collections: [{ id: command.destination.id, revision: 5, title: 'Destination', subtitle: '', icon: 'folder', pinned: false, archived: false, references: [reference], updatedAt: time }],
  undo: { operationId: command.requestId, expected: { collections: [{ id: command.destination.id, expectedRevision: 5 }], organizationRevision: null } } };
}
test('selected-file original position is retained; invalid writing stays editable without creating a command', () => {
 const f = fixture();assert.equal(f.owner.begin(draft()), true);assert.equal(isLibraryTransferDraft(f.owner.value), true);
 f.owner.change(value => ({ ...value, rows: value.rows.map(row => ({ ...row, value: { ...row.value, title: '' } })) }));
 assert.equal(f.owner.command(randomUUID()), undefined);
 assert.equal(JSON.parse(f.map.get(f.owner.key)!).draft.rows[0].position, 199);
 assert.equal(f.owner.value?.rows[0].value.title, '');
});
test('review storage failure retains writing; own successful write with failed readback can be acknowledged', () => {
 const f = fixture();f.owner.begin(draft());f.faults.write = true;
 assert.equal(f.owner.change(value => ({ ...value, rows: value.rows.map(row => ({ ...row, value: { ...row.value, body: 'Newer local writing' } })) })), false);
 assert.equal(f.owner.value?.rows[0].value.body, 'Newer local writing');
 f.faults.write = false;f.faults.afterWrite = true;assert.equal(f.owner.keep(), false);
 f.faults.read = false;assert.equal(f.owner.keep(), true);
 assert.equal(JSON.parse(f.map.get(f.owner.key)!).draft.rows[0].value.body, 'Newer local writing');
});
test('changed destination journal and retired owner refuse overwrite or command construction', () => {
 const f = fixture();f.owner.begin(draft());const original = '{"other":"writing"}';f.map.set(f.owner.key, original);
 assert.equal(f.owner.keep(), false);assert.equal(f.owner.command(randomUUID()), undefined);assert.equal(f.map.get(f.owner.key), original);
 f.lifetime.active = false;assert.equal(f.owner.discard(), false);assert.equal(f.map.get(f.owner.key), original);
});
test('malformed journal and denied storage getters are preserved before editing', () => {
 const f = fixture();f.map.set(f.owner.key, '{original malformed');
 const owner = new LibraryTransferDraftOwner(f.io, f.identity, () => true);assert.equal(owner.invalid, true);assert.equal(owner.begin(draft()), false);
 assert.equal(f.map.get(f.owner.key), '{original malformed');
 const denied = new LibraryTransferDraftOwner({ getItem() { throw Error('Denied getter'); }, setItem() { assert.fail(); } }, f.identity, () => true);
 assert.equal(denied.invalid, true);assert.equal(denied.value, undefined);
});
test('exact confirmed original save survives acknowledgement refusal and keeps newer writing without replay authority', () => {
 const f = fixture();f.owner.begin(draft());const command = f.owner.command(randomUUID())!;assert.equal(isHomeLibraryCommand(command), true);
 f.owner.change(value => ({ ...value, rows: value.rows.map(row => ({ ...row, value: { ...row.value, body: 'Edited while original saved' } })) }));
 const result = receipt(command);f.faults.write = true;assert.equal(f.owner.acknowledge(command, result), false);
 assert.equal(f.owner.value?.rows[0].confirmation?.requestId, command.requestId);assert.equal(f.owner.value?.rows[0].value.body, 'Edited while original saved');
 assert.deepEqual(f.owner.value?.destination, { id: command.destination.id, expectedRevision: 5 });
 f.faults.write = false;assert.equal(f.owner.keep(), true);assert.equal(f.owner.command(randomUUID()), undefined);
 const reopened = new LibraryTransferDraftOwner(f.io, f.identity, () => true);assert.equal(reopened.hasNewerWriting(reopened.value!.rows[0]), true);
 reopened.anotherCopy(199, 'library:deliberate-copy', 'row:deliberate-copy');const next = reopened.command(randomUUID())!;
 assert.equal(next.rows[0].id, 'library:deliberate-copy');assert.equal(next.rows[0].value.body, 'Edited while original saved');
 assert.deepEqual(next.destination, { id: command.destination.id, expectedRevision: 5 });
});
test('own receipt advances only its exact original destination and repeated acknowledgement cannot move it backward', () => {
 const f = fixture();f.owner.begin(draft());const command = f.owner.command(randomUUID())!, result = receipt(command);
 assert.equal(f.owner.acknowledge(command, result), true);
 const saved = f.map.get(f.owner.key);assert.deepEqual(f.owner.value?.destination, { id: command.destination.id, expectedRevision: 5 });
 assert.equal(f.owner.acknowledge(command, result), true);assert.equal(f.map.get(f.owner.key), saved);
 f.owner.change(value => ({ ...value, destination: { id: command.destination.id, expectedRevision: 7 } }));
 assert.equal(f.owner.acknowledge(command, result), true);
 assert.deepEqual(f.owner.value?.destination, { id: command.destination.id, expectedRevision: 7 });
});
test('a late own save keeps a newer destination choice while still preserving its original row confirmation', () => {
 for (const destination of [{ id: 'collection:another', expectedRevision: 3 }, { id: 'collection:target', expectedRevision: 6 }]) {
  const f = fixture();f.owner.begin(draft());const command = f.owner.command(randomUUID())!;
  f.owner.change(value => ({ ...value, destination }));
  assert.equal(f.owner.acknowledge(command, receipt(command)), true);
  assert.deepEqual(f.owner.value?.destination, destination);
  assert.equal(f.owner.value?.rows[0].confirmation?.requestId, command.requestId);
 }
});
test('wrong receipt does not acknowledge and 500,000-byte bound preserves every selected row', () => {
 const f = fixture();f.owner.begin(draft());const command = f.owner.command(randomUUID())!, bad = receipt(command);bad.createdItems[0].body = 'Wrong body';
 assert.equal(f.owner.acknowledge(command, bad), false);assert.equal(f.owner.value?.rows[0].selected, true);
 f.owner.change(value => ({ ...value, file: { ...value.file, entries: 6 }, rows: Array.from({ length: 6 }, (_, index) => ({ position: index, rowId: `row:${index}`, id: `library:${index}`, selected: true, value: { kind: 'note', title: 'Large', body: 'x'.repeat(100000), archived: false } })) }));
 assert.equal(f.owner.command(randomUUID()), undefined);assert.equal(f.owner.value?.rows.length, 6);assert.match(f.owner.error, /500,000/);
});
test('a different file cannot replace an unfinished review and retired replies cannot acknowledge it', () => {
 const f = fixture();f.owner.begin(draft());const command = f.owner.command(randomUUID())!, original = JSON.stringify(f.owner.value);
 assert.equal(f.owner.begin({ ...draft(), file: { ...draft().file, sha256: 'b'.repeat(64) } }), false);assert.equal(JSON.stringify(f.owner.value), original);
 f.lifetime.active = false;assert.equal(f.owner.acknowledge(command, receipt(command)), false);assert.equal(JSON.stringify(f.owner.value), original);
});
test('response byte bound counts streamed bytes and cancels an over-limit body regardless of header', async () => {
 let cancelled = false;
 const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3));c.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Length': '1' } });
 await assert.rejects(readBoundedLibraryResponse(response, 5), /bounded/);assert.equal(cancelled, true);
 assert.deepEqual([...await readBoundedLibraryResponse(new Response(new Uint8Array([0, 10, 13, 26, 255])), 5)], [0, 10, 13, 26, 255]);
});
test('UTF-8 URL input preserves full Unicode and CRLF; invalid encoding or changed size refuses', async () => {
 const bytes = new TextEncoder().encode('https://example.com/Ω\r\nhttps://example.org/#keep\r\n');
 const file = { name: 'links.txt', size: bytes.length, arrayBuffer: async () => bytes.buffer };
 const parsed = await readLibraryInput(file, 'url-text');assert.equal('text' in parsed && parsed.text, 'https://example.com/Ω\r\nhttps://example.org/#keep\r\n');
 await assert.rejects(readLibraryInput({ ...file, size: bytes.length - 1 }, 'url-text'), /changed/);
 await assert.rejects(readLibraryInput({ name: 'bad.txt', size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer }, 'url-text'));
});
test('URL text adoption preserves old writer until explicit replacement and storage readback; retry never overwrites a changed writer', () => {
 const f = fixture(), key = 'original:paste';f.map.set(key, JSON.stringify('Existing writing'));
 assert.equal(keepImportedLibraryText(f.io, key, 'Existing writing', 'Incoming', false, () => true), false);
 f.faults.afterWrite = true;assert.equal(keepImportedLibraryText(f.io, key, 'Existing writing', 'Incoming', true, () => true), false);
 f.faults.read = false;assert.equal(keepImportedLibraryText(f.io, key, 'Existing writing', 'Incoming', true, () => true), true);
 f.map.set(key, JSON.stringify('Other writer'));assert.equal(keepImportedLibraryText(f.io, key, 'Existing writing', 'Incoming', true, () => true), false);
 assert.equal(f.map.get(key), JSON.stringify('Other writer'));
 f.map.set(key, '{malformed');assert.equal(keepImportedLibraryText(f.io, key, '', 'Incoming', false, () => true), false);assert.equal(f.map.get(key), '{malformed');
});
