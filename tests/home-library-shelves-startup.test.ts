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
import { shelvesKey, shelvesOperationKey, shelvesUndoneKey } from '../apps/service/home-library-shelves.js';
import { emptyHomeShelves } from '../packages/domain/home-library-view.js';
import { canonical } from '../packages/domain/contracts.js';
import { spaceDraftId } from '../packages/domain/assistant-space.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { HomeItem, HomeCollection, HomeLibraryState, HomeShelves, HomeShelvesCommand, HomeShelvesReceipt } from '../packages/domain/home-library.js';

const capture = (store: Store) => store.captureBackup('library-spaces-qualification', { status: 'not-configured', notes: [] });
type Backup = ReturnType<typeof capture>;
type Session = ReturnType<Store['session']>;
const retained = (value: Backup) => { const { id: _id, createdAt: _at, ...rest } = value;return rest; };
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const within = (value: string, start: number, end: number) => assert(Number.isFinite(Date.parse(value)) && Date.parse(value) >= start && Date.parse(value) <= end);

// Complete maintained application/HTTP/Store lifecycle over disposable synthetic
// encrypted state. No installed/native/provider runtime is configured or qualified.
test('Spaces and exact Up Next retain the complete workspace through actual settled restart and held restore', { timeout: 60000 }, async () => {
 const parent = mkdtempSync(join(tmpdir(), 'nova-library-spaces-startup-')), directory = join(parent, 'original');
 let service: Awaited<ReturnType<typeof startServer>> | undefined, restoring: Store | undefined, passed = false;
 const nativeCalls: string[] = [], externalCalls: string[] = [], origins = new Set<string>(), originalFetch = globalThis.fetch;
 globalThis.fetch = ((input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!origins.has(url.origin)) { externalCalls.push(url.origin + url.pathname);return Promise.reject(Error('Only fixture HTTP origins are allowed')); }
  return originalFetch(input, options);
 }) as typeof fetch;
 const gateway: AssistantTransport = {
  status: () => ({ state: 'unconfigured', message: 'Synthetic Library fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
  subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
  async request<T>(method: string): Promise<T> { nativeCalls.push(method);throw Error('Unexpected provider method: ' + method); },
 };
 const start = async (path: string) => { service = await startServer({ directory: path, port: 0, gateway });origins.add(service.origin);await delay(3200); };
 const close = async () => { const original = service!;await original.close();service = undefined;await assert.rejects(fetch(original.origin + '/api/health', { signal: AbortSignal.timeout(1000) })); };
 const api = async (session?: Session, body?: unknown, origin?: string, path = 'home/library') => {
  const response = await fetch(service!.origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
   headers: { ...(session ? { Cookie: 'e3_session=' + session.token } : {}), Origin: origin ?? service!.origin, 'X-Edition3-Client': '1', 'Content-Type': 'application/json' },
   body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
 };
 const current = async (owner: Session) => { const read = await api(owner);assert.equal(read.status, 200);return read.data as HomeLibraryState; };
 const apply = async (owner: Session, input: HomeShelvesCommand, expected: HomeShelves) => {
  const before = capture(service!.store), began = Date.now(), response = await api(owner, input), ended = Date.now();
  assert.equal(response.status, 200, JSON.stringify(response.data));const result = response.data as HomeShelvesReceipt;
  const old = (before.services.find(row => row.id === shelvesKey)?.value ?? emptyHomeShelves()) as HomeShelves;
  within(result.appliedAt, began, ended);assert.deepEqual(result.shelves, expected);
  const undoing = input.type === 'shelves-undo';
  assert.deepEqual(result, { format: 2, kind: 'shelves', operationId: input.requestId, epoch: input.epoch, type: input.type, appliedAt: result.appliedAt,
   changed: true, shelves: expected, undo: undoing ? null : { operationId: input.requestId, expectedRevision: expected.revision },
   ...(undoing ? { undoneOperationId: input.operationId } : {}) });
  const prior = before.services.find(row => row.id === shelvesKey);
  const added = undoing ? { id: shelvesUndoneKey + input.operationId, revision: 1, value: { operationId: input.requestId, epoch: input.epoch, device: owner.deviceId, appliedAt: result.appliedAt } } :
   { id: shelvesOperationKey + input.requestId, revision: 1, value: { format: 1, operationId: input.requestId, epoch: input.epoch, device: owner.deviceId, afterRevision: expected.revision, before: old } };
  const services = [...before.services.filter(row => row.id !== shelvesKey), { id: shelvesKey, revision: (prior?.revision ?? 0) + 1, value: expected }, added].sort(byId);
  const receipts = [...before.receipts, { requestId: input.requestId, deviceId: owner.deviceId, digest: digest({ operation: 'home.library', ...input }), value: result }]
   .sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
  assert.deepEqual(retained(capture(service!.store)), { ...retained(before), services, receipts }, 'complete exact shelves/inverse/receipt derivation only');
  return result;
 };
 try {
  await start(directory);
  const store = service!.store, epoch = store.epoch, owner = store.session(), other = store.session(), envelope = () => ({ epoch, requestId: randomUUID() });
  const library = new HomeLibrary(store);
  store.mutate(owner.deviceId, { ...envelope(), kind: 'task', entityId: 'task:original', expectedRevision: 0,
   payload: { title: 'Retained Task', notes: 'Every original word', status: 'done', planned: '', due: '' } });
  const file = store.upload(owner.deviceId, randomUUID(), epoch, 'retained.txt', Buffer.from('Exact preserved file\n').toString('base64'));
  store.mutate(owner.deviceId, { ...envelope(), kind: 'draft', entityId: spaceDraftId(owner.deviceId, 'chat'), expectedRevision: 0,
   payload: { space: 'chat', title: 'Unsent original', text: 'Original Assistant writing', projectId: null, attachments: [file] } });
  store.mutate(owner.deviceId, { ...envelope(), kind: 'content', entityId: 'content:original', expectedRevision: 0,
   payload: { ...blankRecord('content', 'UTC'), title: 'Original Content', body: 'Original source body' } });
  const linkValue = { kind: 'link' as const, title: 'Exact saved link', body: 'Original annotation', url: 'https://example.test/original?q=1#part', archived: false };
  const link = library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: 'link:original', expectedRevision: 0, value: linkValue }) as HomeItem;
  const note = library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: 'note:original', expectedRevision: 0, value: { kind: 'note', title: 'Original Note', body: 'Complete note text', archived: false } }) as HomeItem;
  const collection = library.command(owner.deviceId, { ...envelope(), type: 'collection-save', id: 'collection:original', expectedRevision: 0,
   value: { title: 'Original collection', subtitle: '', icon: 'folder', pinned: true, archived: false, references: [{ kind: 'note', id: note.id, revision: 1 }] } }) as HomeCollection;
  const initial = capture(store), progress = store.profileProgress();
  assert.deepEqual((await current(owner)).shelves, { status: 'ready', value: emptyHomeShelves() });
  assert.equal((await api()).status, 401);assert.equal((await api(owner, undefined, 'https://wrong.example.test')).status, 403);
  assert.deepEqual(retained(capture(store)), retained(initial), 'pure initial projection and authentication refusals');
  const first: HomeShelvesCommand = { ...envelope(), type: 'space-save', id: 'space:kept', name: '  Reading  ', expectedRevision: 0 };
  let expected: HomeShelves = { ...emptyHomeShelves(), revision: 1, spaces: [{ id: 'space:kept', name: '  Reading  ', archived: false }] };
  const firstResult = await apply(owner, first, expected);
  expected = { ...expected, revision: 2, assignments: [{ collectionId: collection.id, spaceId: 'space:kept' }] };
  await apply(owner, { ...envelope(), type: 'collection-assign', expectedRevision: 1, collection: { id: collection.id, expectedRevision: 1 }, spaceId: 'space:kept' }, expected);
  const ref = { kind: 'link' as const, id: link.id, revision: 1 };
  expected = { ...expected, revision: 3, upNext: [ref] };
  await apply(owner, { ...envelope(), type: 'up-next-add', expectedRevision: 2, reference: ref }, expected);
  expected = { ...expected, revision: 4, spaces: [{ ...expected.spaces[0], archived: true }] };
  const archived = await apply(owner, { ...envelope(), type: 'space-archive', expectedRevision: 3, id: 'space:kept', archived: true }, expected);
  // Explicit source edit occurs before the retained baseline; the shelf must retain revision one.
  library.command(owner.deviceId, { ...envelope(), type: 'item-save', id: link.id, expectedRevision: 1, value: { ...linkValue, title: 'New link', url: 'https://example.test/new' } });
  const selected = capture(store), selectedLibrary = await current(other);
  assert.equal(selectedLibrary.resources.find(row => row.reference.id === link.id && row.reference.revision === 1)?.url, linkValue.url);
  assert.deepEqual((await api(owner, first)).data, firstResult);assert.equal((await api(other, first)).status, 409);
  assert.equal((await api(owner, { ...first, name: 'Different original payload' })).status, 409);
  assert.equal((await api(owner, { ...first, ...envelope(), epoch: randomUUID() })).status, 409);
  assert.equal((await api(owner, { ...first, ...envelope(), expectedRevision: 0 })).status, 409);
  assert.equal((await api(owner, { ...envelope(), type: 'library-undo', operationId: archived.operationId, expected: { collections: [], organizationRevision: null } })).status, 409);
  store.setUpdateMaintenanceHeld(true);assert.equal((await api(owner, { ...first, ...envelope(), expectedRevision: 4 })).status, 409);
  assert.equal((await api(owner)).status, 200);store.setUpdateMaintenanceHeld(false);
  assert.deepEqual(retained(capture(store)), retained(selected), 'no receipt or state drift from all replays/refusals');
  await close();await start(directory);
  assert.deepEqual(retained(capture(service!.store)), retained(selected), 'complete settled restart equality');
  assert.deepEqual(await current(other), selectedLibrary);assert.deepEqual((await api(owner, first)).data, firstResult);
  assert.deepEqual(service!.store.download(file.id).bytes, Buffer.from('Exact preserved file\n'));
  const undoInput: HomeShelvesCommand = { ...envelope(), type: 'shelves-undo', ...archived.undo! };
  expected = { ...expected, revision: 5, spaces: [{ ...expected.spaces[0], archived: false }] };
  const undone = await apply(owner, undoInput, expected), afterUndo = capture(service!.store);
  assert.deepEqual((await api(owner, undoInput)).data, undone);assert.deepEqual(retained(capture(service!.store)), retained(afterUndo));
  service!.store.internalWrite(shelvesKey, { format: 99, originalWriting: 'Never discard unsupported metadata' });
  const malformed = capture(service!.store);await close();await start(directory);
  assert.deepEqual(retained(capture(service!.store)), retained(malformed), 'malformed shelf does not rewrite or abort startup');
  assert.equal((await current(owner)).shelves?.status, 'needs-review');assert.equal((await api(owner, undefined, undefined, 'snapshot')).status, 200);
  assert.equal((await api(owner, { ...first, ...envelope(), expectedRevision: 5 })).status, 409);
  assert.deepEqual(retained(capture(service!.store)), retained(malformed));await close();

  const began = Date.now(), heldPath = join(parent, 'held');restoring = Store.restoreBackup(heldPath, selected);
  const ended = Date.now(), heldEpoch = restoring.epoch, heldOwner = restoring.session(), restored = capture(restoring);
  assert.notEqual(heldEpoch, epoch);assert(restoring.recoveryHeld);
  const recoveredAt = restoring.internalRead<{ recoveredAt: string }>('recovery:state')!.recoveredAt;within(recoveredAt, began, ended);
  const replaced = new Set(['http:session-cookie', 'phone:access', 'recovery:state', 'recovery:retained-archives']);
  const replacement = (id: string, value: unknown) => ({ id, revision: (selected.services.find(row => row.id === id)?.revision ?? 0) + 1, value });
  const services = [...selected.services.filter(row => !replaced.has(row.id)),
   replacement('recovery:state', { held: true, backupId: selected.id, sourceEpoch: epoch, recoveredAt, native: 'not-configured' }),
   replacement('recovery:retained-archives', []), replacement('phone:access', { enabled: false })].sort(byId);
  assert.deepEqual(retained(restored), { ...retained(selected), epoch: heldEpoch, services }, 'complete exact original-to-held derivation');
  restoring.close();restoring = undefined;await start(heldPath);
  const held = capture(service!.store), cookie = held.services.find(row => row.id === 'http:session-cookie')!;
  assert.equal(cookie.revision, 1);assert.match(String(cookie.value), /^e3_session_[a-f0-9]{32}$/);
  assert.deepEqual(retained(held), { ...retained(restored), services: [...restored.services, cookie].sort(byId) });
  assert.equal((await api(owner)).status, 401);assert.deepEqual((await current(heldOwner)).shelves, selectedLibrary.shelves);
  assert.equal((await api(heldOwner, { ...first, requestId: randomUUID(), epoch: heldEpoch, expectedRevision: 4 })).status, 409);
  assert.deepEqual(retained(capture(service!.store)), retained(held));
  const activationStart = Date.now();service!.store.activateRecoveredLocal();const activationEnd = Date.now();
  const recovery = service!.store.internalRead<any>('recovery:state'), priorRecovery = held.services.find(row => row.id === 'recovery:state')!;
  within(recovery.activatedAt, activationStart, activationEnd);
  assert.deepEqual(recovery, { ...(priorRecovery.value as object), held: false, effectsPaused: true, activatedAt: recovery.activatedAt });
  const activated = capture(service!.store);
  assert.deepEqual(retained(activated), { ...retained(held), services: [...held.services.filter(row => row.id !== 'recovery:state'), { ...priorRecovery, revision: priorRecovery.revision + 1, value: recovery }].sort(byId) });
  assert.equal((await api(heldOwner, first)).status, 409);assert.equal((await api(heldOwner, { requestId: randomUUID(), epoch: heldEpoch, type: 'shelves-undo', ...archived.undo! })).status, 409);
  assert.deepEqual(retained(capture(service!.store)), retained(activated), 'old operation authority does not acquire the new recovery epoch');
  await apply(heldOwner, { requestId: randomUUID(), epoch: heldEpoch, type: 'space-archive', id: 'space:kept', archived: false, expectedRevision: 4 }, expected);
  assert.deepEqual(service!.store.profileProgress(), { ...progress, epoch: heldEpoch });assert(service!.store.recoveryEffectsPaused);
  assert.deepEqual(nativeCalls, []);assert.deepEqual(externalCalls, []);await close();passed = true;
 } finally {
  try { await service?.close();restoring?.close(); } finally { globalThis.fetch = originalFetch; }
  if (passed) { assert.equal(dirname(resolve(parent)), resolve(tmpdir()));assert(basename(parent).startsWith('nova-library-spaces-startup-'));rmSync(parent, { recursive: true }); }
  else process.stderr.write('Preserved failed Library Spaces application fixture: ' + parent + '\n');
 }
});
