import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { deriveHomeWidgetPreservation, homeWidgetPreservationKey } from '../apps/service/home-widget-preservation.js';
import { HomeLibrary } from '../apps/service/home-library.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { Entity, Layout } from '../packages/domain/contracts.js';
import type { HomeItem, HomeLibraryState } from '../packages/domain/home-library.js';
import type { HomeWidget } from '../packages/domain/home-widgets.js';
const native = { status: 'not-configured' as const, notes: [] };
const stable = (store: Store) => {
 const { id: _id, createdAt: _created, ...value } = store.captureBackup('fixture', native); return value;
};
function fixtureTransport(calls: string[]): AssistantTransport {
 return { status: () => ({ state: 'unconfigured', message: 'Isolated Home persistence fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
  subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
  async request<T>(method: string): Promise<T> { calls.push(method); throw Error('Unexpected provider request: ' + method); } };
}
// Complete real Store/HTTP application lifecycle. No native/provider runtime is
// configured; this cannot certify a native upgrade or replace its release gate.
test('settled active startup derives only exact Home records; two sessions, restart and replay retain the entire workspace', { timeout: 45000 }, async () => {
 const root = mkdtempSync(join(tmpdir(), 'nova-home-preservation-startup-')), directory = join(root, 'workspace');
 let seed: Store | undefined = new Store(directory), service: Awaited<ReturnType<typeof startServer>> | undefined;
 let passed = false;
 const calls: string[] = [], gateway = fixtureTransport(calls);
 const close = async () => {
  const origin = service!.origin; await service!.close(); service = undefined;
  await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) }));
 };
 try {
  const store = seed, epoch = store.epoch, first = store.session(), second = store.session();
  const a = { cookie: 'e3_session=' + first.token, device: first.deviceId }, b = { cookie: 'e3_session=' + second.token, device: second.deviceId };
  const envelope = () => ({ epoch, requestId: randomUUID() });
  const note: HomeWidget = { id: 'widget:' + randomUUID(), type: 'note', hidden: true, title: 'Hidden original', size: 'wide', settings: { text: 'Exact hidden words\n雪' } };
  const links: HomeWidget = { id: 'widget:' + randomUUID(), type: 'links', hidden: false, title: 'Original links', size: 'wide', settings: { links: ['First', 'Second'].map(label => ({ id: randomUUID(), label, url: 'https://example.test/same?q=1#original' })) } };
  const oldLayout = store.readEntity('layout', 'layout')!;
  const source = store.mutate(a.device, { ...envelope(), kind: 'layout', entityId: 'layout', expectedRevision: oldLayout.revision, payload: { ...oldLayout.value, widgets: [note, links] } }) as Entity<Layout>;
  const reference = { kind: 'widget' as const, id: note.id, revision: source.revision };
  const library = new HomeLibrary(store), originalCaptureInput = { ...envelope(), references: [reference] }, originalCapture = library.capture(a.device, originalCaptureInput);
  library.command(a.device, { ...envelope(), type: 'collection-save', id: 'collection:original', expectedRevision: 0, value: { title: 'Original collection', subtitle: 'Keep exact source', icon: 'book', pinned: false, archived: false, references: [reference] } });
  store.mutate(a.device, { ...envelope(), kind: 'task', entityId: 'task:retained', expectedRevision: 0, payload: { title: 'Unrelated Task', notes: 'All writing', status: 'open', planned: '', due: '' } });
  const file = store.upload(a.device, randomUUID(), epoch, 'kept.txt', Buffer.from('Complete retained file').toString('base64'));
  store.mutate(a.device, { ...envelope(), kind: 'content', entityId: 'content:retained', expectedRevision: 0, payload: { ...blankRecord('content', 'UTC'), title: 'Original Content', body: 'Original content text', assets: [file] } });
  store.close(); seed = undefined;
  const holdFor = randomUUID();
  const updateHostClient = { async call<T>(): Promise<T> { return { availability: 'current', installation: { supported: true }, holdFor } as T; } };
  service = await startServer({ directory, port: 0, gateway, updateHostClient }); await delay(3200);
  assert.equal(service.store.updateMaintenanceHeld, true); assert.equal(service.store.internalRead(homeWidgetPreservationKey), undefined);
  const before = stable(service.store); await close();
  const expected = deriveHomeWidgetPreservation(source, epoch);
  service = await startServer({ directory, port: 0, gateway }); await delay(3200);
  const after = stable(service.store);
  const expectedServices = [...before.services, { id: homeWidgetPreservationKey, revision: 1, value: expected.manifest }, ...expected.items.flatMap(item => [
   { id: 'home:library:item:' + item.id, revision: 1, value: item },
   { id: `home:library:version:item-save:${item.id}:1`, revision: 1, value: item },
  ])].sort((left, right) => left.id.localeCompare(right.id, 'en', { sensitivity: 'variant' }));
  // SQLite orders identifiers bytewise; compare complete keyed maps instead of locale order.
  const map = (rows: typeof after.services) => Object.fromEntries(rows.map(row => [row.id, row]));
  assert.deepEqual({ ...after, services: map(after.services) }, { ...before, services: map(expectedServices) });
  const api = async (client: typeof a, path: string, body?: unknown) => {
   const response = await fetch(service!.origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
    headers: { Cookie: client.cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Origin: service!.origin }, body: body === undefined ? undefined : JSON.stringify(body) });
   return { status: response.status, data: await response.json() };
  };
  const one = await api(a, 'home/library'), two = await api(b, 'home/library');
  assert.equal(one.status, 200); assert.deepEqual(two, one);
  const state = one.data as HomeLibraryState; assert.equal(state.homePreservation!.status, 'ready');
  assert.equal(state.resources.find(row => row.reference.kind === 'widget')?.text, note.settings!.text);
  assert.deepEqual(stable(service.store), after, 'GET requests do not add or rewrite preservation records');
  const item = expected.items[0], edit = { ...envelope(), type: 'item-save', id: item.id, expectedRevision: 1, value: { kind: 'note', title: 'Later editable writing', body: 'Keep my later edit', archived: true } };
  const edited = await api(a, 'home/library', edit); assert.equal(edited.status, 200); assert.equal((edited.data as HomeItem).revision, 2);
  const retained = stable(service.store); await close();
  service = await startServer({ directory, port: 0, gateway }); await delay(3200);
  assert.deepEqual(stable(service.store), retained, 'complete settled restart equality includes every original and migration row');
  assert.deepEqual(await api(a, 'home/library', edit), edited);
  assert.equal((await api(b, 'home/library', edit)).status, 409);
  assert.deepEqual((await api(a, 'home/context', originalCaptureInput)).data, originalCapture);
  assert.deepEqual(service.store.download(file.id).bytes, Buffer.from('Complete retained file'));
  assert.deepEqual(stable(service.store), retained);
  assert.deepEqual(calls, []);
  passed = true;
 } finally {
  if (service) await close(); seed?.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'nova-home-preservation-startup-'));
  if (passed) rmSync(root, { recursive: true, force: true }); else console.error('Preserved failed startup fixture:', root);
 }
});

test('unverifiable Home provenance leaves actual service usable and all retained records intact', { timeout: 15000 }, async () => {
 const root = mkdtempSync(join(tmpdir(), 'nova-home-preservation-error-')), directory = join(root, 'workspace');
 let seed: Store | undefined = new Store(directory), service: Awaited<ReturnType<typeof startServer>> | undefined;
 let passed = false;
 const calls: string[] = [], gateway = fixtureTransport(calls);
 try {
  const session = seed.session(), cookie = 'e3_session=' + session.token;
  seed.internalWrite(homeWidgetPreservationKey, { format: 999, originalWords: 'Unrecognized retained value' });
  const before = stable(seed); seed.close(); seed = undefined;
  service = await startServer({ directory, port: 0, gateway }); await delay(3200);
  const after = stable(service.store);
  for (const key of ['entities', 'history', 'receipts', 'files', 'references', 'epoch', 'cursor'] as const) assert.deepEqual(after[key], before[key]);
  const records = new Map(after.services.map(row => [row.id, row]));
  for (const original of before.services) assert.deepEqual(records.get(original.id), original);
  assert.equal(after.services.some(row => row.id.startsWith('home:library:item:') || row.id.startsWith('home:library:version:')), false);
  const response = await fetch(service.origin + '/api/home/library', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); assert.equal(((await response.json()) as HomeLibraryState).homePreservation!.status, 'needs-review');
  assert.deepEqual(calls, []);
  passed = true;
 } finally {
  if (service) { const origin = service.origin; await service.close(); await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) })); }
  seed?.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'nova-home-preservation-error-'));
  if (passed) rmSync(root, { recursive: true, force: true }); else console.error('Preserved failed startup fixture:', root);
 }
});
