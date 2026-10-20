import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { Entity, Task } from '../packages/domain/contracts.js';
import type { AssistantTransport } from '../apps/service/gateway.js';

const capture = (store: Store) => store.captureBackup('profile-week-qualification', { status: 'not-configured', notes: [] });
const retained = (snapshot: ReturnType<typeof capture>) => { const { id: _id, createdAt: _at, ...rest } = snapshot; return rest; };
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
type Session = ReturnType<Store['session']>;

// Supported synthetic service lifecycle; not installed/native qualification.
test('week reads preserve complete existing state through settled restart and held restore', { timeout: 45000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'nova-profile-week-startup-')), directory = join(parent, 'original');
  let service: Awaited<ReturnType<typeof startServer>> | undefined, restoring: Store | undefined, passed = false;
  const nativeCalls: string[] = [], externalCalls: string[] = [], origins = new Set<string>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin)) { externalCalls.push(url.origin + url.pathname); return Promise.reject(Error('Only exact local fixture origins are allowed')); }
    return realFetch(input, init);
  }) as typeof fetch;
  const gateway: AssistantTransport = {
    status: () => ({ state: 'unconfigured', message: 'Synthetic week fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
    async request<T>(method: string): Promise<T> { nativeCalls.push(method); throw Error('Unexpected native request: ' + method); },
  };
  const start = async (path: string) => { service = await startServer({ directory: path, port: 0, gateway }); origins.add(service.origin); await delay(3200); };
  const close = async () => { const origin = service!.origin; await service!.close(); service = undefined; await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) })); };
  const api = async (path: string, session?: Session, body?: unknown, origin?: string) => {
    const response = await fetch(service!.origin + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
      headers: { ...(session ? { Cookie: 'e3_session=' + session.token } : {}), 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Origin: origin ?? service!.origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  try {
    await start(directory);
    const store = service!.store, epoch = store.epoch, owner = store.session(), other = store.session();
    let task = store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'task', entityId: 'task:' + randomUUID(), expectedRevision: 0,
      payload: { title: 'Original credited Task', notes: 'Keep original writing', status: 'open', planned: '', due: '' } }) as Entity<Task>;
    for (const status of ['done', 'open', 'done'] as const) task = store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'task', entityId: task.id,
      expectedRevision: task.revision, payload: { ...task.value, status } }) as Entity<Task>;
    const file = store.upload(owner.deviceId, randomUUID(), epoch, 'kept.txt', Buffer.from('Full original file\n').toString('base64'));
    store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'draft', entityId: 'draft:' + owner.deviceId, expectedRevision: 0,
      payload: { title: 'Unsent writing', projectId: null, text: 'Keep every original word.', attachments: [file] } });
    store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'content', entityId: 'content:' + randomUUID(), expectedRevision: 0,
      payload: { ...blankRecord('content', 'UTC'), title: 'Kept content', body: 'Full saved body' } });
    const progress = store.profileProgress(), original = capture(store); assert.equal(progress.earnedXp, 10);
    await close(); await start(directory);
    assert.deepEqual(retained(capture(service!.store)), retained(original), 'complete settled original-state equality');
    const week = await api('profile/week', owner); assert.equal(week.status, 200);
    const params = new URLSearchParams(week.data.identity), day = week.data.days.find((row: any) => row.activityCount === 3).day;
    const activity = await api('profile/week/activity?' + params + '&day=' + day, other); assert.equal(activity.status, 200);
    assert.equal(activity.data.total, 3); assert.deepEqual(activity.data.entries.map((row: any) => row.transition), ['completed-again', 'reopened', 'completed']);
    const history = await api('profile/week/history', owner); assert.equal(history.status, 200); assert.equal(history.data.page.total, 3);
    for (const path of ['profile/week', 'profile/week/activity?' + params + '&day=' + day, 'profile/week/history']) {
      assert.equal((await api(path)).status, 401); assert.equal((await api(path, owner, undefined, 'http://example.invalid')).status, 403);
    }
    for (const suffix of ['start=2026-10-20&timezone=UTC', 'start=2026-10-19&timezone=Invalid', 'start=2026-10-19&start=2026-10-26&timezone=UTC', 'owner=other']) assert.equal((await api('profile/week?' + suffix, owner)).status, 400);
    assert.equal((await api('profile/week/activity?' + params + '&day=' + day + '&before=missing', owner)).status, 409);
    assert.equal((await api('profile/week/history?before=missing', owner)).status, 409);
    assert.equal((await api('profile/week', owner, {})).status, 404);
    service!.store.setUpdateMaintenanceHeld(true); assert.equal((await api('profile/week', owner)).status, 200); service!.store.setUpdateMaintenanceHeld(false);
    assert.deepEqual(retained(capture(service!.store)), retained(original), 'reads/refusals preserve entities, history, receipts, metadata, services and file/reference inventory');
    assert.deepEqual(service!.store.download(file.id).bytes, Buffer.from('Full original file\n')); await close();
    const restoreStart = Date.now(), heldPath = join(parent, 'held'); restoring = Store.restoreBackup(heldPath, original);
    const restoreEnd = Date.now(), heldEpoch = restoring.epoch, heldSession = restoring.session(), restored = capture(restoring);
    assert.notEqual(heldEpoch, epoch); assert.equal(restoring.recoveryHeld, true);
    const recoveredAt = restoring.internalRead<any>('recovery:state').recoveredAt;
    assert.equal(typeof recoveredAt, 'string'); assert(Date.parse(recoveredAt) >= restoreStart && Date.parse(recoveredAt) <= restoreEnd);
    const replaced = new Set(['http:session-cookie', 'phone:access', 'recovery:state', 'recovery:retained-archives']);
    const restoredRow = (id: string, value: unknown) => ({ id, revision: (original.services.find(row => row.id === id)?.revision ?? 0) + 1, value });
    const services = [...original.services.filter(row => !replaced.has(row.id)),
      restoredRow('recovery:state', { held: true, backupId: original.id, sourceEpoch: epoch, recoveredAt, native: 'not-configured' }),
      restoredRow('recovery:retained-archives', []), restoredRow('phone:access', { enabled: false })].sort(byId);
    assert.deepEqual(retained(restored), { ...retained(original), epoch: heldEpoch, services }, 'exact original-to-held recovery derivation');
    restoring.close(); restoring = undefined; await start(heldPath);
    const held = capture(service!.store), cookie = held.services.find(row => row.id === 'http:session-cookie')!;
    assert.equal(cookie.revision, 1); assert.match(String(cookie.value), /^e3_session_[a-f0-9]{32}$/);
    assert.deepEqual(retained(held), { ...retained(restored), services: [...restored.services, cookie].sort(byId) }, 'settled held startup adds only its new cookie record');
    assert.equal((await api('profile/week/history', owner)).status, 401);
    assert.deepEqual((await api('profile/week/history', heldSession)).data, { ...history.data, epoch: heldEpoch });
    assert.equal((await api('profile/week', heldSession, {})).status, 409);
    assert.deepEqual(service!.store.profileProgress(), { ...progress, epoch: heldEpoch });
    assert.deepEqual(retained(capture(service!.store)), retained(held), 'held reads and forbidden writes change no saved state');
    assert.deepEqual(nativeCalls, []); assert.deepEqual(externalCalls, []); await close(); passed = true;
  } finally {
    try { await service?.close(); restoring?.close(); } finally { globalThis.fetch = realFetch; }
    if (passed) {
      assert.equal(dirname(resolve(parent)), resolve(tmpdir())); assert(basename(parent).startsWith('nova-profile-week-startup-'));
      rmSync(parent, { recursive: true, force: true });
    } else process.stderr.write('Preserved isolated week startup fixture: ' + parent + '\n');
  }
});
