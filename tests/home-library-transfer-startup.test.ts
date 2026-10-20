import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { HomeLibrary } from '../apps/service/home-library.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';
import { canonical } from '../packages/domain/contracts.js';
import { spaceDraftId } from '../packages/domain/assistant-space.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { captureResultMatches } from '../packages/domain/home-library-view.js';
import { parseLibraryPortable } from '../packages/domain/home-library-portable.js';
import type { HomeItem, HomeCollection, HomeLibraryCommand, HomeLibraryReceipt } from '../packages/domain/home-library.js';

const capture = (store: Store) => store.captureBackup('library-transfer-qualification', { status: 'not-configured', notes: [] });
type Backup = ReturnType<typeof capture>;
type Session = ReturnType<Store['session']>;
const retained = (value: Backup) => { const { id: _id, createdAt: _at, ...rest } = value;return rest; };
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const within = (value: string, start: number, end: number) => assert(Number.isFinite(Date.parse(value)) && Date.parse(value) >= start && Date.parse(value) <= end);

// Supported isolated application lifecycle, not native/provider qualification.
// No production workspace or installed runtime is opened.
test('portable Library reads and original imports retain complete settled and held workspaces', { timeout: 60000 }, async () => {
 const parent = mkdtempSync(join(tmpdir(), 'nova-library-transfer-startup-')), directory = join(parent, 'original');
 let service: Awaited<ReturnType<typeof startServer>> | undefined, restoring: Store | undefined, passed = false;
 const nativeCalls: string[] = [], externalCalls: string[] = [], origins = new Set<string>(), originalFetch = globalThis.fetch;
 globalThis.fetch = ((input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!origins.has(url.origin)) { externalCalls.push(url.origin + url.pathname);return Promise.reject(Error('Only exact fixture HTTP origins are allowed')); }
  return originalFetch(input, options);
 }) as typeof fetch;
 const gateway: AssistantTransport = {
  status: () => ({ state: 'unconfigured', message: 'Synthetic Library transfer fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
  subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
  async request<T>(method: string): Promise<T> { nativeCalls.push(method);throw Error('Unexpected provider method: ' + method); },
 };
 const start = async (path: string) => { service = await startServer({ directory: path, port: 0, gateway });origins.add(service.origin);await delay(3200); };
 const close = async () => { const original = service!;await original.close();service = undefined;await assert.rejects(fetch(original.origin + '/api/health', { signal: AbortSignal.timeout(1000) })); };
 const api = async (path: string, session?: Session, body?: unknown, origin?: string) => {
  const response = await fetch(service!.origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
   headers: { ...(session ? { Cookie: 'e3_session=' + session.token } : {}), Origin: origin ?? service!.origin, 'X-Edition3-Client': '1', 'Content-Type': 'application/json' },
   body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, data: await response.json() as any };
 };
 const equalReads = (before: Backup, description: string) => assert.deepEqual(retained(capture(service!.store)), retained(before), description);
 const derive = (before: Backup, replacements: Array<{ id: string; value: unknown }>, input: HomeLibraryCommand, result: HomeLibraryReceipt, deviceId: string) => {
  const replaced = new Set(replacements.map(row => row.id));
  const services = [...before.services.filter(row => !replaced.has(row.id)),
   ...replacements.map(row => ({ ...row, revision: (before.services.find(old => old.id === row.id)?.revision ?? 0) + 1 }))].sort(byId);
  const receipts = [...before.receipts, { requestId: input.requestId, deviceId, digest: digest({ operation: 'home.library', ...input }), value: result }]
   .sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
  assert.deepEqual(retained(capture(service!.store)), { ...retained(before), services, receipts }, 'complete exact changed services and original receipt only');
 };
 try {
  await start(directory);
  const store = service!.store, epoch = store.epoch, owner = store.session(), other = store.session(), envelope = () => ({ epoch, requestId: randomUUID() });
  const library = new HomeLibrary(store);
  store.mutate(owner.deviceId, { ...envelope(), kind: 'task', entityId: 'task:original', expectedRevision: 0,
   payload: { title: 'Retained task', notes: 'Exact original history', status: 'done', planned: '', due: '' } });
  const file = store.upload(owner.deviceId, randomUUID(), epoch, 'retained.txt', Buffer.from('Exact original file\n').toString('base64'));
  store.mutate(owner.deviceId, { ...envelope(), kind: 'draft', entityId: spaceDraftId(owner.deviceId, 'chat'), expectedRevision: 0,
   payload: { space: 'chat', title: 'Unsent original', text: 'Original Assistant writing', projectId: null, attachments: [file] } });
  const content = store.mutate(owner.deviceId, { ...envelope(), kind: 'content', entityId: 'content:original', expectedRevision: 0,
   payload: { ...blankRecord('content', 'UTC'), title: 'Internal source', body: 'Never expose this as portable note text' } });
  assert.equal(content.id, 'content:original');
  const noteValue = { kind: 'note' as const, title: 'Exact note v1', body: 'Full Unicode Ω\noriginal writing', archived: false };
  const note = library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: 'note:original', expectedRevision: 0, value: noteValue }) as HomeItem;
  const linkValue = { kind: 'link' as const, title: 'Original link', body: 'Original annotation', url: 'https://example.test/original?q=1#part', archived: false };
  const link = library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: 'link:original', expectedRevision: 0, value: linkValue }) as HomeItem;
  const missing = library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: 'note:missing-history', expectedRevision: 0, value: { ...noteValue, title: 'Missing historical note' } }) as HomeItem;
  const refs = [{ kind: 'note' as const, id: note.id, revision: 1 }, { kind: 'link' as const, id: link.id, revision: 1 },
   { kind: 'content' as const, id: 'content:original', revision: 1 }, { kind: 'note' as const, id: missing.id, revision: 1 }];
  const source = library.command(owner.deviceId, { ...envelope(), type: 'collection-save', id: 'collection:source', expectedRevision: 0,
   value: { title: 'Portable source', subtitle: 'Original collection', icon: 'folder', pinned: true, archived: false, references: refs } }) as HomeCollection;
  const destination = library.command(owner.deviceId, { ...envelope(), type: 'collection-save', id: 'collection:destination', expectedRevision: 0,
   value: { title: 'Existing destination', subtitle: '', icon: 'folder', pinned: false, archived: false, references: [refs[1]] } }) as HomeCollection;
  library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: note.id, expectedRevision: 1, value: { ...noteValue, title: 'New v2', body: 'Do not substitute this text' } });
  library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: missing.id, expectedRevision: 1, value: { ...noteValue, title: 'New missing v2' } });
  // Explicit damaged-history fixture before the retained baseline; export must
  // describe absence, not invent a replacement or mutate the gap.
  store.internalDelete(`home:library:version:item-save:${missing.id}:1`);
  const baseline = capture(store), progress = store.profileProgress();
  const path = (value = epoch, positions?: string) => 'home/library/export?' + new URLSearchParams({ epoch: value, collection: source.id, revision: '1', ...(positions ? { positions } : {}) });
  const began = Date.now(), exported = await api(path(), owner), ended = Date.now();
  assert.equal(exported.status, 200);assert.match(exported.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="nova-library.json"');
  within(exported.data.exportedAt, began, ended);
  const document = parseLibraryPortable(new TextEncoder().encode(JSON.stringify(exported.data)));
  const { references: _refs, ...sourceIdentity } = source;
  assert.deepEqual(document, { format: 'nova-library', version: 1, exportedAt: document.exportedAt, source: { epoch, collection: sourceIdentity, memberCount: 4 },
   selection: 'all', entries: [{ position: 0, reference: refs[0], status: 'portable', item: note }, { position: 1, reference: refs[1], status: 'portable', item: link },
    { position: 2, reference: refs[2], status: 'reference-only', reason: 'workspace-reference' },
    { position: 3, reference: refs[3], status: 'unavailable', reason: 'saved-version-unavailable' }] });
  const selected = await api(path(epoch, '3,0'), other);
  assert.equal(selected.status, 200);assert.equal(selected.data.selection, 'selected');assert.deepEqual(selected.data.entries, [document.entries[0], document.entries[3]]);
  assert.equal((await api(path())).status, 401);
  assert.equal((await api(path(), owner, undefined, 'https://wrong.example.test')).status, 403);
  assert.equal((await api(path(randomUUID()), owner)).status, 409);
  assert.equal((await api(path().replace('revision=1', 'revision=2'), owner)).status, 409);
  assert.equal((await api(path() + '&revision=1', owner)).status, 400);
  assert.equal((await api(path(epoch, '4'), owner)).status, 400);
  assert.equal(phoneRouteAllowed('/api/home/library/export', 'GET'), true);
  assert.equal(phoneRouteAllowed('/api/home/library/export', 'POST'), false);
  store.setUpdateMaintenanceHeld(true);assert.equal((await api(path(), owner)).status, 200);
  assert.equal((await api('home/library', owner, { ...envelope(), type: 'item-save', id: 'note:maintenance-refusal', expectedRevision: 0, value: noteValue })).status, 409);
  store.setUpdateMaintenanceHeld(false);
  equalReads(baseline, 'export, exact selection and auth/query refusals have zero logical mutations');
  const imported: Extract<HomeLibraryCommand, { type: 'items-capture' }> = { ...envelope(), type: 'items-capture', destination: { id: destination.id, expectedRevision: 1 },
   rows: [{ rowId: 'row:note', id: 'note:imported', value: noteValue },
    { rowId: 'row:existing', id: 'link:skipped-existing', value: { ...linkValue, title: 'Imported annotation stays in review', body: 'Do not overwrite existing annotation' } },
    { rowId: 'row:new-link', id: 'link:imported', value: { ...linkValue, url: 'https://example.test/new', title: 'New imported link' } },
    { rowId: 'row:batch-duplicate', id: 'link:skipped-batch', value: { ...linkValue, url: 'https://example.test/new', body: 'Duplicate full writing stays in review' } }] };
  const importBefore = capture(store), importStart = Date.now(), response = await api('home/library', owner, imported), importEnd = Date.now();
  assert.equal(response.status, 200);const receipt = response.data as HomeLibraryReceipt;within(receipt.appliedAt, importStart, importEnd);
  const newRefs = [{ kind: 'note' as const, id: 'note:imported', revision: 1 }, { kind: 'link' as const, id: 'link:imported', revision: 1 }];
  const created = [imported.rows[0], imported.rows[2]].map(row => ({ ...row.value, id: row.id, revision: 1, updatedAt: receipt.appliedAt })) as HomeItem[];
  const changedCollection = { ...destination, revision: 2, updatedAt: receipt.appliedAt, references: [...destination.references, ...newRefs] };
  assert.deepEqual(receipt, { format: 1, operationId: imported.requestId, epoch, type: 'items-capture', appliedAt: receipt.appliedAt, changed: true,
   createdItems: created, collections: [changedCollection], outcomes: [
    { rowId: 'row:note', reference: newRefs[0], disposition: 'created-and-added' }, { rowId: 'row:existing', reference: refs[1], disposition: 'already-in-destination' },
    { rowId: 'row:new-link', reference: newRefs[1], disposition: 'created-and-added' }, { rowId: 'row:batch-duplicate', reference: newRefs[1], disposition: 'duplicate-in-batch' }],
   undo: { operationId: imported.requestId, expected: { collections: [{ id: destination.id, expectedRevision: 2 }], organizationRevision: null } } });
  assert(captureResultMatches(imported, receipt));
  derive(importBefore, [...created.flatMap(item => [{ id: `home:library:item:${item.id}`, value: item }, { id: `home:library:version:item-save:${item.id}:1`, value: item }]),
   { id: `home:library:collection:${destination.id}`, value: changedCollection }, { id: `home:library:version:collection-save:${destination.id}:2`, value: changedCollection },
   { id: `home:library:operation:${imported.requestId}`, value: { collections: [{ id: destination.id, revision: 2, before: { references: destination.references } }], organization: null, device: owner.deviceId, type: imported.type, epoch } }],
  imported, receipt, owner.deviceId);
  const importedState = capture(store);
  assert.deepEqual((await api('home/library', owner, imported)).data, receipt);
  assert.equal((await api('home/library', other, imported)).status, 409);
  assert.equal((await api('home/library', owner, { ...imported, rows: imported.rows.slice(1) })).status, 409);
  assert.equal((await api('home/library', owner, { ...imported, requestId: randomUUID() })).status, 409);
  assert.equal((await api('home/library', owner, { ...imported, requestId: randomUUID(), epoch: randomUUID() })).status, 409);
  assert.equal((await api('home/library', owner, { ...imported, requestId: randomUUID(), destination: { id: destination.id, expectedRevision: 2 },
   rows: Array.from({ length: 21 }, (_, index) => ({ rowId: `row:too-many:${index}`, id: `note:too-many:${index}`, value: noteValue })) })).status, 400);
  assert.equal((await api('home/library', owner, { ...imported, requestId: randomUUID(), destination: { id: destination.id, expectedRevision: 2 },
   rows: Array.from({ length: 6 }, (_, index) => ({ rowId: `row:too-large:${index}`, id: `note:too-large:${index}`, value: { ...noteValue, body: 'x'.repeat(100000) } })) })).status, 413);
  equalReads(importedState, 'replays and stale/wrong authority do not create new sources or receipts');
  await close();await start(directory);
  equalReads(importedState, 'complete settled existing-state restart equality');
  assert.deepEqual((await api('home/library', owner, imported)).data, receipt);
  const again = await api(path(), owner);assert.equal(again.status, 200);assert.deepEqual(again.data.entries, document.entries);
  assert.deepEqual(service!.store.download(file.id).bytes, Buffer.from('Exact original file\n'));
  const undo: Extract<HomeLibraryCommand, { type: 'library-undo' }> = { ...envelope(), type: 'library-undo', ...receipt.undo! };
  const undoBefore = capture(service!.store), undoStart = Date.now(), undone = await api('home/library', owner, undo), undoEnd = Date.now();
  assert.equal(undone.status, 200);const result = undone.data as HomeLibraryReceipt;within(result.appliedAt, undoStart, undoEnd);
  const undoneCollection = { ...changedCollection, revision: 3, updatedAt: result.appliedAt, references: destination.references };
  assert.deepEqual(result, { format: 1, operationId: undo.requestId, epoch, type: 'library-undo', appliedAt: result.appliedAt, changed: true, collections: [undoneCollection],
   createdItems: [], outcomes: [], undo: null, undoneOperationId: imported.requestId });
  derive(undoBefore, [{ id: `home:library:collection:${destination.id}`, value: undoneCollection }, { id: `home:library:version:collection-save:${destination.id}:3`, value: undoneCollection },
   { id: `home:library:undone:${imported.requestId}`, value: { operationId: undo.requestId, epoch, device: owner.deviceId, appliedAt: result.appliedAt } }], undo, result, owner.deviceId);
  assert.deepEqual(service!.store.internalRead('home:library:item:note:imported'), created[0]);
  const final = capture(service!.store);assert.deepEqual(service!.store.profileProgress(), progress);
  assert.deepEqual((await api('home/library', owner, undo)).data, result);equalReads(final, 'original Undo replay is read-only');
  await close();

  const restoreStart = Date.now(), heldPath = join(parent, 'held');restoring = Store.restoreBackup(heldPath, final);
  const restoreEnd = Date.now(), heldEpoch = restoring.epoch, heldOwner = restoring.session(), restored = capture(restoring);
  assert.notEqual(heldEpoch, epoch);assert(restoring.recoveryHeld);
  const recoveredAt = restoring.internalRead<{ recoveredAt: string }>('recovery:state')!.recoveredAt;within(recoveredAt, restoreStart, restoreEnd);
  const replaced = new Set(['http:session-cookie', 'phone:access', 'recovery:state', 'recovery:retained-archives']);
  const replacement = (id: string, value: unknown) => ({ id, revision: (final.services.find(row => row.id === id)?.revision ?? 0) + 1, value });
  const services = [...final.services.filter(row => !replaced.has(row.id)),
   replacement('recovery:state', { held: true, backupId: final.id, sourceEpoch: epoch, recoveredAt, native: 'not-configured' }),
   replacement('recovery:retained-archives', []), replacement('phone:access', { enabled: false })].sort(byId);
  assert.deepEqual(retained(restored), { ...retained(final), epoch: heldEpoch, services }, 'complete exact restore transform, including every item/version/inverse/receipt/file');
  restoring.close();restoring = undefined;await start(heldPath);
  const held = capture(service!.store), cookie = held.services.find(row => row.id === 'http:session-cookie')!;
  assert.equal(cookie.revision, 1);assert.match(String(cookie.value), /^e3_session_[a-f0-9]{32}$/);
  assert.deepEqual(retained(held), { ...retained(restored), services: [...restored.services, cookie].sort(byId) });
  assert.equal((await api(path(heldEpoch), owner)).status, 401);
  const heldExport = await api(path(heldEpoch), heldOwner);assert.equal(heldExport.status, 200);assert.deepEqual(heldExport.data.entries, document.entries);
  assert.equal((await api(path(), heldOwner)).status, 409);
  assert.equal((await api('home/library', heldOwner, { ...imported, requestId: randomUUID(), epoch: heldEpoch, destination: { id: destination.id, expectedRevision: 3 } })).status, 409);
  equalReads(held, 'held export stays read-only and held import cannot create an admission');
  assert.deepEqual(service!.store.profileProgress(), { ...progress, epoch: heldEpoch });assert.deepEqual(nativeCalls, []);assert.deepEqual(externalCalls, []);
  await close();passed = true;
 } finally {
  try { await service?.close();restoring?.close(); } finally { globalThis.fetch = originalFetch; }
  if (passed) { assert.equal(dirname(resolve(parent)), resolve(tmpdir()));assert(basename(parent).startsWith('nova-library-transfer-startup-'));rmSync(parent, { recursive: true }); }
  else process.stderr.write('Preserved failed Library transfer application fixture: ' + parent + '\n');
 }
});
