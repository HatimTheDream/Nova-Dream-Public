import test from 'node:test';
import assert from 'node:assert/strict';
import { homeCollectionValueSchema, homeItemValueSchema, homeLibraryCommandSchema, homeQuote as hostQuote, homeIdeaScope as hostScope, type HomeLibraryCommand, type HomeLibraryJournal, type HomeLibraryReceipt, type HomeCollection } from '../packages/domain/home-library.js';
import { clockTime } from '../packages/domain/tasks.js';
import { homeClockTime, homeQuote, homeIdeaScope, isHomeCollectionDraft, isHomeItemDraft, exactHomeReference, normalizeHomeUrl, isHomeLibraryCommand, isHomeLibraryReceipt, isHomeLibraryResult, isHomeLibraryState, readHomeLibraryState, readHomeLibraryJournal } from '../packages/domain/home-library-view.js';

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

const epoch = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const otherRequest = '33333333-3333-4333-8333-333333333333', at = '2026-10-19T04:00:00.000Z';
const owner = { deviceId: 'device:one', epoch, windowId: 'window:one' };
const source = { id: 'collection:source', expectedRevision: 3 }, destination = { id: 'collection:destination', expectedRevision: 2 };
const captured = { kind: 'link' as const, id: 'library:captured', revision: 1 };
const savedCollection = (id: string, references = [captured]): HomeCollection => ({ id, revision: 4, updatedAt: at, title: 'Sources', subtitle: '', icon: 'folder', pinned: false, archived: false, references });
const captureCommand = { requestId, epoch, type: 'items-capture', destination, rows: [{ rowId: 'row:one', id: captured.id, value: { kind: 'link', title: 'Saved source', url: 'https://example.test/path?b=2&a=1#part', body: 'My annotation', archived: false } }] } satisfies HomeLibraryCommand;

test('new commands keep bounded rows, full reference identities and exact guarded scopes', () => {
 const commands: HomeLibraryCommand[] = [
  captureCommand,
  { requestId, epoch, type: 'collections-order', expectedRevision: 0, collectionIds: [source.id, destination.id] },
  { requestId, epoch, type: 'references-transfer', mode: 'move', source, destination, references: [captured, { kind: 'output', id: 'output:one', revision: 5, sha256: 'a'.repeat(64) }], before: null },
  { requestId, epoch, type: 'references-order', collection: source, references: [] },
  { requestId, epoch, type: 'library-undo', operationId: otherRequest, expected: { collections: [source, destination], organizationRevision: null } },
 ];
 for (const command of commands) { assert.ok(homeLibraryCommandSchema.safeParse(command).success);assert.ok(isHomeLibraryCommand(command)); }
 const transfer = commands[2] as Extract<HomeLibraryCommand, { type: 'references-transfer' }>;
 const rows = captureCommand.rows;
 const refused: unknown[] = [
  { ...captureCommand, extra: true }, { ...captureCommand, rows: [] }, { ...captureCommand, rows: Array.from({ length: 21 }, (_, n) => ({ ...rows[0], rowId: `row:${n}`, id: `library:${n}` })) },
  { ...captureCommand, rows: [rows[0], { ...rows[0], id: 'library:another' }] }, { ...captureCommand, rows: [rows[0], { ...rows[0], rowId: 'row:another' }] },
  { ...captureCommand, rows: [{ ...rows[0], value: { ...rows[0].value, archived: true } }] }, { ...captureCommand, rows: [{ ...rows[0], value: { ...rows[0].value, url: 'https://user:secret@example.test' } }] },
  { ...captureCommand, destination: { ...destination, expectedRevision: Number.MAX_SAFE_INTEGER + 1 } },
  { ...transfer, destination: source }, { ...transfer, mode: 'replace' }, { ...transfer, references: [] }, { ...transfer, references: [captured, { ...captured, revision: 2 }] }, { ...transfer, before: { ...captured, revision: 0 } },
  { ...commands[1], collectionIds: [source.id, source.id] }, { ...commands[1], collectionIds: ['collection:one\n'] }, { ...commands[1], expectedRevision: 1.5 },
  { ...commands[3], references: [{ ...captured, sha256: 'a'.repeat(64) + '\n' }] }, { ...commands[3], references: [{ ...captured, id: 'library:captured\n' }] },
  { ...commands[4], expected: { collections: [source, source], organizationRevision: null } }, { ...commands[4], expected: { collections: [source], organizationRevision: -1 } },
  { ...commands[4], expected: { collections: [source, destination, { id: 'collection:third', expectedRevision: 1 }], organizationRevision: null } },
  { ...commands[0], requestId: requestId + '\n' }, { ...commands[0], epoch: 'not-an-epoch' },
 ];
 for (const [index, command] of refused.entries()) { assert.equal(homeLibraryCommandSchema.safeParse(command).success, false, `host refusal ${index}`);assert.equal(isHomeLibraryCommand(command), false, `kept-request refusal ${index}`); }
 const full = { ...captureCommand, rows: Array.from({ length: 20 }, (_, n) => ({ ...rows[0], rowId: `row:${n}`, id: `library:${n}` })) };
 assert.ok(homeLibraryCommandSchema.safeParse(full).success);assert.ok(isHomeLibraryCommand(full));
});

test('URL normalization and reference comparison never replace captured provenance', () => {
 assert.equal(normalizeHomeUrl(' HTTPS://Example.Test:443/a/../source?b=2&a=1#Keep '), 'https://example.test/source?b=2&a=1#Keep');
 assert.notEqual(normalizeHomeUrl('http://example.test/source'), normalizeHomeUrl('https://example.test/source'));
 assert.notEqual(normalizeHomeUrl('https://example.test/source?a=1&b=2'), normalizeHomeUrl('https://example.test/source?b=2&a=1'));
 assert.notEqual(normalizeHomeUrl('https://example.test/source#one'), normalizeHomeUrl('https://example.test/source#two'));
 for (const url of ['javascript:alert(1)', 'file:///saved/private', 'data:text/plain,hello', '//example.test', 'https://name:password@example.test', 'not a URL']) assert.equal(normalizeHomeUrl(url), undefined);
 assert.ok(exactHomeReference(captured, { ...captured }));
 assert.equal(exactHomeReference(captured, { ...captured, revision: 2 }), false);
 assert.equal(exactHomeReference(captured, { ...captured, sha256: 'a'.repeat(64) }), false);
 assert.equal(exactHomeReference({ ...captured, sha256: 'a'.repeat(64) }, { ...captured, sha256: 'b'.repeat(64) }), false);
});

test('a pending journal preserves exact command bytes and separates corrupt or foreign ownership from absence', () => {
 const kept: HomeLibraryJournal = { format: 1, ...owner, uncertain: true, command: captureCommand };
 const raw = JSON.stringify(kept), restored = readHomeLibraryJournal(raw, owner);
 assert.equal(restored.status, 'valid');if (restored.status !== 'valid') return;
 assert.equal(JSON.stringify(restored.journal), raw);assert.deepEqual(restored.journal.command, captureCommand);
 assert.equal(restored.journal.command.requestId, requestId);
 assert.deepEqual(readHomeLibraryJournal(null, owner), { status: 'absent' });assert.deepEqual(readHomeLibraryJournal('null', owner), { status: 'absent' });
 for (const rawValue of ['', '{', 'false', '[]', '{}', JSON.stringify({ ...kept, uncertain: undefined }), JSON.stringify({ ...kept, extra: 'ignored?' }), JSON.stringify({ ...kept, command: { ...captureCommand, rows: [] } })]) assert.equal(readHomeLibraryJournal(rawValue, owner).status, 'invalid');
 for (const foreignOwner of [{ ...owner, deviceId: 'device:two' }, { ...owner, windowId: 'window:two' }, { ...owner, epoch: otherRequest }]) assert.equal(readHomeLibraryJournal(raw, foreignOwner).status, 'invalid');
 assert.equal(readHomeLibraryJournal(JSON.stringify({ ...kept, command: { ...captureCommand, epoch: otherRequest } }), owner).status, 'invalid');
 const old = readHomeLibraryJournal(JSON.stringify(captureCommand), owner);
 assert.equal(old.status, 'valid');if (old.status === 'valid') { assert.deepEqual(old.journal.command, captureCommand);assert.equal(old.journal.uncertain, true);assert.equal(old.journal.windowId, owner.windowId); }
 assert.equal(readHomeLibraryJournal(JSON.stringify(captureCommand), { ...owner, epoch: otherRequest }).status, 'invalid');
 assert.equal(raw, JSON.stringify(kept), 'reading or refusing a journal never edits its original data');
});

test('legacy reads derive stable order without rewriting records and reject incoherent modern order', () => {
 const a = savedCollection('collection:a'), b = savedCollection('collection:b'), pinned = { ...savedCollection('collection:pinned'), pinned: true, updatedAt: '2020-01-01T00:00:00.000Z' };
 const old = { epoch, collections: [b, pinned, a], items: [], resources: [{ reference: captured, title: 'Captured URL', subtitle: 'Kept revision', url: 'https://example.test/old', updatedAt: at, availability: 'changed', currentRevision: 2 }], ideaPreferences: { revision: 0, saved: [], hidden: [] } };
 const bytes = JSON.stringify(old), read = readHomeLibraryState(old);
 assert.ok(read);assert.deepEqual(read.organization, { revision: 0, collectionIds: [pinned.id, a.id, b.id] });assert.deepEqual(read.collections.map(collection => collection.id), read.organization.collectionIds);assert.equal(JSON.stringify(old), bytes);
 assert.equal(read.resources[0].reference.revision, 1);assert.equal(read.resources[0].url, 'https://example.test/old');assert.equal(read.resources[0].currentRevision, 2);
 assert.equal(isHomeLibraryState(old), false);assert.ok(isHomeLibraryState(read));
 const ordered = { ...old, organization: { revision: 7, collectionIds: [b.id, a.id, pinned.id] } };
 assert.deepEqual(readHomeLibraryState(ordered)?.organization, ordered.organization);assert.deepEqual(readHomeLibraryState(ordered)?.collections.map(collection => collection.id), ordered.organization.collectionIds);
 for (const organization of [null, {}, { revision: 1, collectionIds: [a.id] }, { revision: 1, collectionIds: [a.id, a.id, pinned.id] }, { revision: 1, collectionIds: [a.id, b.id, 'collection:unknown'] }, { revision: Number.MAX_SAFE_INTEGER + 1, collectionIds: [a.id, b.id, pinned.id] }]) assert.equal(readHomeLibraryState({ ...old, organization }), undefined);
 assert.equal(readHomeLibraryState({ ...old, collections: [a, { ...a }] }), undefined);
 assert.equal(readHomeLibraryState({ ...old, items: [{ id: 'library:unsafe', revision: 1, updatedAt: at, kind: 'link', title: 'Unsafe', body: '', archived: false, url: 'javascript:alert(1)' }] }), undefined);
 assert.equal(readHomeLibraryState({ ...old, resources: [{ ...old.resources[0], reference: { ...captured, sha256: 'bad' } }] }), undefined);
});

function captureReceipt(): HomeLibraryReceipt {
 const changed = savedCollection(destination.id);
 return { format: 1, operationId: requestId, epoch, type: 'items-capture', appliedAt: at, changed: true, collections: [changed], organization: { revision: 1, collectionIds: [changed.id] }, createdItems: [{ ...captureCommand.rows[0].value, id: captured.id, revision: 1, updatedAt: at }], outcomes: [{ rowId: 'row:one', reference: captured, disposition: 'created-and-added' }], undo: { operationId: requestId, expected: { collections: [{ id: changed.id, expectedRevision: changed.revision }], organizationRevision: null } } };
}
test('receipts bind created references and guarded Undo to actual changed records, including a seeded order', () => {
 const value = captureReceipt();assert.ok(isHomeLibraryReceipt(value));assert.ok(isHomeLibraryResult(value));
 const malformed: unknown[] = [
  { ...value, extra: true }, { ...value, operationId: 'unknown' }, { ...value, changed: false }, { ...value, undo: null },
  { ...value, undo: { ...value.undo!, operationId: otherRequest } },
  { ...value, undo: { ...value.undo!, expected: { collections: [{ id: destination.id, expectedRevision: 3 }], organizationRevision: null } } },
  { ...value, undo: { ...value.undo!, expected: { collections: [{ id: 'collection:unrelated', expectedRevision: 4 }], organizationRevision: null } } },
  { ...value, undo: { ...value.undo!, expected: { collections: value.undo!.expected.collections, organizationRevision: 5 } } },
  { ...value, createdItems: [{ ...value.createdItems[0], id: 'library:different' }] },
  { ...value, outcomes: [{ ...value.outcomes[0], reference: { ...captured, revision: 2 } }] },
  { ...value, outcomes: [{ ...value.outcomes[0], reference: { ...captured, sha256: 'a'.repeat(64) } }] },
  { ...value, outcomes: [{ ...value.outcomes[0], disposition: 'moved' }] },
  { ...value, outcomes: [{ ...value.outcomes[0], rowId: undefined }] },
  { ...value, outcomes: [...value.outcomes, ...value.outcomes] },
  { ...value, collections: [...value.collections, ...value.collections] }, { ...value, undoneOperationId: otherRequest },
 ];
 for (const [index, receipt] of malformed.entries()) assert.equal(isHomeLibraryReceipt(receipt), false, `receipt refusal ${index}`);
 const duplicate: HomeLibraryReceipt = { ...value, changed: false, collections: [], organization: undefined, createdItems: [], outcomes: [{ rowId: 'row:one', reference: captured, disposition: 'already-in-destination' }], undo: null };
 assert.ok(isHomeLibraryReceipt(duplicate));
 const historical = structuredClone(value);historical.collections[0].revision = 8;historical.undo!.expected.collections[0].expectedRevision = 8;
 assert.ok(isHomeLibraryReceipt(historical), 'a well-formed historical receipt is not replaced by later local state');
 const undo: HomeLibraryReceipt = { ...value, operationId: otherRequest, type: 'library-undo', createdItems: [], outcomes: [], undo: null, undoneOperationId: requestId };
 assert.ok(isHomeLibraryReceipt(undo));assert.equal(isHomeLibraryReceipt({ ...undo, undoneOperationId: undefined }), false);assert.equal(isHomeLibraryReceipt({ ...undo, undo: value.undo }), false);assert.equal(isHomeLibraryReceipt({ ...undo, changed: false, collections: [], organization: undefined }), false);
});
