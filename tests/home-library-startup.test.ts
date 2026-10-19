import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { HomeCollection, HomeItem, HomeLibraryCommand, HomeLibraryState, LibraryReceipt } from '../packages/domain/home-library.js';
import { blankRecord } from '../packages/domain/workspace-records.js';

// Actual HTTP service and its background readers, over an isolated encrypted
// workspace. This checks application persistence, not a native/runtime upgrade.
test('two HTTP sessions retain Library operations, historical URLs and scoped Undo through actual restart', { timeout: 30000 }, async () => {
 const directory = mkdtempSync(join(tmpdir(), 'nova-library-startup-'));
 let seeded: Store | undefined = new Store(directory);
 let service: Awaited<ReturnType<typeof startServer>> | undefined;
 const providerCalls: string[] = [];
 const gateway: AssistantTransport = {
  status: () => ({ state: 'unconfigured', message: 'Isolated Library fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
  subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
  async request<T>(method: string): Promise<T> { providerCalls.push(method); throw Error('Unexpected provider request: ' + method); },
 };
 try {
  const store = seeded, epoch = store.epoch, first = store.session(), second = store.session();
  const a = { cookie: 'e3_session=' + first.token, device: first.deviceId }, b = { cookie: 'e3_session=' + second.token, device: second.deviceId };
  const envelope = () => ({ epoch, requestId: randomUUID() });
  const oldLink: HomeItem = { id: 'link:legacy', kind: 'link', title: 'Original link', url: 'https://example.com/old?q=one#kept', body: 'Original annotation', archived: false, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' };
  const newLink: HomeItem = { ...oldLink, title: 'Current link', url: 'https://example.com/new', body: 'New annotation', revision: 2 };
  store.internalWrite('home:library:version:item-save:' + oldLink.id + ':1', oldLink);
  store.internalWrite('home:library:version:item-save:' + oldLink.id + ':2', newLink);
  store.internalWrite('home:library:item:' + oldLink.id, newLink);
  const source: HomeCollection = { id: 'collection:legacy', revision: 1, updatedAt: oldLink.updatedAt, title: 'Original collection', subtitle: '', icon: 'book', pinned: false, archived: false, references: [{ kind: 'link', id: oldLink.id, revision: 1 }] };
  const destination: HomeCollection = { ...source, id: 'collection:second', title: 'Second collection', references: [] };
  store.internalWrite('home:library:collection:' + source.id, source);
  store.internalWrite('home:library:collection:' + destination.id, destination);
  const taskInput = { ...envelope(), kind: 'task' as const, entityId: 'task:retained', expectedRevision: 0, payload: { title: 'Saved task', notes: 'Preserve writing', status: 'open', planned: '', due: '' } };
  const task = store.mutate(a.device, taskInput), history = store.taskHistory({ taskId: task.id });
  const content = store.mutate(a.device, { ...envelope(), kind: 'content', entityId: 'content:retained', expectedRevision: 0, payload: { ...blankRecord('content', 'UTC'), title: 'Saved source', body: 'Complete source words' } });
  const bytes = Buffer.from('Retained file, never replaced by Library organization.\n');
  const file = store.upload(a.device, randomUUID(), epoch, 'retained.md', bytes.toString('base64'));
  const layout = store.snapshot(a.device).layout, versions = store.internalList('home:library:version:');
  store.close(); seeded = undefined;
  const api = async <T>(client: typeof a, path: string, body?: unknown) => {
   const response = await fetch(service!.origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
    headers: { Cookie: client.cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Origin: service!.origin }, body: body === undefined ? undefined : JSON.stringify(body) });
   return { status: response.status, data: await response.json() as T };
  };
  const read = async () => { const result = await api<HomeLibraryState>(b, 'home/library'); assert.equal(result.status, 200); return result.data; };
  const apply = async (input: HomeLibraryCommand) => { const result = await api<LibraryReceipt>(a, 'home/library', input); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
  service = await startServer({ directory, port: 0, gateway }); await delay(3200);
  const legacy = await read(); assert.equal(legacy.organization.revision, 0); assert.deepEqual(legacy.collections, [source, destination]);
  assert.equal(service.store.internalRead('home:library:organization'), undefined, 'startup/GET does not seed legacy order');
  assert.equal(legacy.resources.find(r => r.reference.id === oldLink.id && r.reference.revision === 1)?.url, oldLink.url);
  const capture = { ...envelope(), type: 'items-capture', destination: { id: source.id, expectedRevision: 1 }, rows: [{ rowId: 'note', id: 'note:captured', value: { kind: 'note', title: 'Captured writing', body: 'Keep all of this text', archived: false } }] } satisfies HomeLibraryCommand;
  const captured = await apply(capture); assert.equal(captured.createdItems.length, 1); assert.equal(captured.collections[0].revision, 2);
  const races = ['a', 'b'].map(suffix => ({ ...envelope(), type: 'items-capture' as const, destination: { id: source.id, expectedRevision: 2 }, rows: [{ rowId: suffix, id: 'note:race-' + suffix, value: { kind: 'note' as const, title: suffix, body: 'Race ' + suffix, archived: false } }] }));
  const raceResults = await Promise.all([api<LibraryReceipt>(a, 'home/library', races[0]), api<LibraryReceipt>(b, 'home/library', races[1])]);
  assert.deepEqual(raceResults.map(r => r.status).sort(), [200, 409]);
  const failedIndex = raceResults.findIndex(r => r.status === 409);
  assert.equal(service.store.internalRead('home:library:item:note:race-' + ['a', 'b'][failedIndex]), undefined, 'concurrent revision loser leaves no orphan item');
  const afterRace = await read(), held = afterRace.collections.find(c => c.id === source.id)!;
  const copy = { ...envelope(), type: 'references-transfer', mode: 'copy', source: { id: held.id, expectedRevision: held.revision }, destination: { id: destination.id, expectedRevision: 1 }, references: source.references, before: null } satisfies HomeLibraryCommand;
  const copied = await apply(copy); assert.equal(copied.collections.length, 1); assert.equal(copied.collections[0].references[0].revision, 1);
  const unrelated = await api(a, 'home/library', { ...envelope(), type: 'item-save', id: 'note:captured', expectedRevision: 1, value: { kind: 'note', title: 'Later writing', body: 'Later text survives Undo', archived: false } }); assert.equal(unrelated.status, 200);
  const retained = await read(), retainedVersions = service.store.internalList('home:library:version:');
  const oldOrigin = service.origin; await service.close(); service = undefined;
  await assert.rejects(fetch(oldOrigin + '/api/health', { signal: AbortSignal.timeout(1000) }));
  service = await startServer({ directory, port: 0, gateway }); await delay(3200);
  assert.deepEqual(await read(), retained, 'settled restart preserves complete Library state and order');
  assert.deepEqual(service.store.internalList('home:library:version:'), retainedVersions);
  assert.deepEqual(await apply(capture), captured, 'original device recovers historical capture response after restart');
  assert.equal((await api(b, 'home/library', capture)).status, 409, 'another session cannot adopt the original device request');
  assert.deepEqual(await apply(copy), copied);
  const undoRequest = { ...envelope(), type: 'library-undo', ...copied.undo! } satisfies HomeLibraryCommand;
  const undone = await apply(undoRequest); assert.equal(undone.collections[0].references.length, 0); assert.equal(undone.collections[0].revision, 3);
  assert.deepEqual(await apply(undoRequest), undone, 'lost Undo response reconciles, never repeats');
  assert.equal((await read()).items.find(item => item.id === 'note:captured')?.body, 'Later text survives Undo');
  assert.deepEqual(service.store.readEntity('task', task.id), task); assert.deepEqual(service.store.taskHistory({ taskId: task.id }), history);
  assert.deepEqual(service.store.readEntity('content', content.id), content); assert.deepEqual(service.store.snapshot(b.device).layout, layout);
  assert.deepEqual(service.store.download(file.id).bytes, bytes);
  assert.deepEqual(service.store.internalList('home:library:version:').filter((row: unknown) => (row as HomeItem).id === oldLink.id), versions);
  assert.deepEqual(providerCalls, [], 'Library persistence and background readers dispatch no provider work');
 } finally {
  await service?.close(); seeded?.close(); rmSync(directory, { recursive: true, force: true });
 }
});
