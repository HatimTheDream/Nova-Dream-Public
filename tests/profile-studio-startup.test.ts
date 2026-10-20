import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { studioCurationKey } from '../apps/service/profile-studio.js';
import { canonical } from '../packages/domain/contracts.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { QuestDraft } from '../packages/domain/profile-progression.js';
import type { StudioCommand, StudioReceipt } from '../packages/domain/profile-studio.js';

const native = { status: 'not-configured' as const, notes: [] };
const capture = (store: Store) => store.captureBackup('profile-studio-qualification', native);
const retained = (snapshot: ReturnType<typeof capture>) => {
  const { id: _id, createdAt: _at, ...rest } = snapshot; return rest;
};
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const stamp = (value: unknown, start: number, end: number) => {
  assert.equal(typeof value, 'string');
  const time = Date.parse(value as string);
  assert.ok(Number.isFinite(time) && time >= start && time <= end, 'timestamp belongs to this actual phase');
};
type Session = ReturnType<Store['session']>;

// Actual synthetic HTTP/application/encrypted-store lifecycle. No installed
// runtime, native/provider response, phone connection or hosted update claim.
test('Studio metadata survives actual HTTP restart and held restore without changing original Tasks or XP', { timeout: 45000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'nova-profile-studio-startup-')), directory = join(parent, 'original');
  let service: Awaited<ReturnType<typeof startServer>> | undefined, restoring: Store | undefined, passed = false;
  const nativeCalls: string[] = [], externalCalls: string[] = [], origins = new Set<string>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin)) {
      externalCalls.push(url.origin + url.pathname);
      return Promise.reject(new Error('Synthetic fixture refuses external/Gallery requests'));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const gateway: AssistantTransport = {
    status: () => ({ state: 'unconfigured', message: 'Synthetic Studio fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
    async request<T>(method: string): Promise<T> { nativeCalls.push(method); throw Error('Unexpected native request: ' + method); },
  };
  const start = async (path: string) => {
    service = await startServer({ directory: path, port: 0, gateway });
    origins.add(service.origin); await delay(3200);
  };
  const close = async () => {
    const origin = service!.origin; await service!.close(); service = undefined;
    await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) }));
  };
  const api = async (session: Session | undefined, body?: unknown, origin?: string) => {
    const response = await fetch(service!.origin + '/api/profile/studio', {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
      headers: { ...(session ? { Cookie: 'e3_session=' + session.token } : {}), 'X-Edition3-Client': '1',
        'Content-Type': 'application/json', Origin: origin ?? service!.origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  const assertSave = (before: ReturnType<typeof capture>, after: ReturnType<typeof capture>, command: StudioCommand, deviceId: string, result: StudioReceipt) => {
    const prior = before.services.find(row => row.id === studioCurationKey)!;
    const curation = { format: 1, revision: command.expectedRevision + 1, questIds: command.questIds };
    assert.deepEqual(result, { requestId: command.requestId, epoch: command.epoch, curation });
    const services = [...before.services.filter(row => row.id !== studioCurationKey),
      { id: studioCurationKey, revision: prior.revision + 1, value: curation }].sort(byId);
    const receipts = [...before.receipts, { requestId: command.requestId, deviceId,
      digest: sha({ type: 'profile-studio', ...command }), value: result }]
      .sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
    assert.deepEqual(retained(after), { ...retained(before), services, receipts },
      'the complete save changes only exact Studio metadata and its genuine original command receipt');
  };
  try {
    // Establish ordinary application defaults once, then retain an existing
    // workspace. The subsequent startup comparisons cover every saved field.
    await start(directory);
    const store = service!.store, epoch = store.epoch, a = store.session(), b = store.session();
    assert.ok(a.token && b.token); assert.notEqual(a.deviceId, b.deviceId);
    const quest = (title: string, taskId: string | null = null) => store.saveQuest(a.deviceId, {
      requestId: randomUUID(), epoch, expectedRevision: 0, action: 'save',
      quest: { id: randomUUID(), title, description: 'Original quest writing', projectId: null, due: '',
        steps: [{ id: randomUUID(), taskId, title: 'Original Task' }] } satisfies QuestDraft,
    });
    const first = quest('First original quest'), second = quest('Second quest shares original Task', first.steps[0].taskId);
    const archived = quest('Archived original quest'), missing = randomUUID();
    store.saveQuest(a.deviceId, { requestId: randomUUID(), epoch, expectedRevision: 1, action: 'archive', id: archived.id, archived: true });
    const task = store.readEntity('task', first.steps[0].taskId)!;
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'task', entityId: task.id,
      expectedRevision: task.revision, payload: { ...task.value, status: 'done' } });
    const file = store.upload(a.deviceId, randomUUID(), epoch, 'kept-writing.txt', Buffer.from('Exact original writing\n').toString('base64'));
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'draft', entityId: 'draft:' + a.deviceId,
      expectedRevision: 0, payload: { title: 'Unsent independent writing', projectId: null, text: 'Keep every word.', attachments: [file] } });
    store.mutate(a.deviceId, { requestId: randomUUID(), epoch, kind: 'content', entityId: 'content:' + randomUUID(), expectedRevision: 0,
      payload: { ...blankRecord('content', 'UTC'), title: 'Independent content', body: 'Original complete content.' } });
    store.internalWrite(studioCurationKey, { format: 1, revision: 1, questIds: [archived.id, missing] });
    const progress = store.profileProgress(); assert.equal(progress.earnedXp, 10);
    const original = capture(store); await close(); await start(directory);
    assert.deepEqual(retained(capture(service!.store)), retained(original), 'actual settled existing-state startup retains the full workspace');

    const read = await api(b); assert.equal(read.status, 200);
    assert.deepEqual(read.data, { epoch, curation: { format: 1, revision: 1, questIds: [archived.id, missing] },
      availableQuestIds: [], unavailable: [{ id: archived.id, reason: 'archived' }, { id: missing, reason: 'missing' }] });
    assert.equal((await api(undefined)).status, 401); assert.equal((await api(undefined, {})).status, 401);
    assert.equal((await api(a, {}, 'http://example.invalid')).status, 403);
    assert.deepEqual(retained(capture(service!.store)), retained(original), 'GET and authentication refusal do not repair or overwrite unavailable references');

    const command: StudioCommand = { requestId: randomUUID(), epoch, expectedRevision: 1, questIds: [first.id, second.id] };
    service!.store.setUpdateMaintenanceHeld(true);
    assert.equal((await api(a, command)).status, 409); assert.equal((await api(b)).status, 200);
    service!.store.setUpdateMaintenanceHeld(false);
    for (const input of [
      { ...command, requestId: randomUUID(), epoch: randomUUID() },
      { ...command, requestId: randomUUID(), expectedRevision: 0 },
      { ...command, requestId: randomUUID(), questIds: [archived.id] },
      { ...command, requestId: randomUUID(), questIds: [missing] },
    ]) assert.equal((await api(a, input)).status, 409);
    for (const input of [
      { ...command, questIds: [first.id, first.id] },
      { ...command, questIds: [first.id, second.id, archived.id] },
      { ...command, completeTasks: true },
    ]) assert.equal((await api(a, input)).status, 400);
    assert.deepEqual(retained(capture(service!.store)), retained(original), 'all refused commands preserve complete original state and receipts');

    const saved = await api(a, command); assert.equal(saved.status, 200);
    const afterFirst = capture(service!.store); assertSave(original, afterFirst, command, a.deviceId, saved.data);
    assert.deepEqual((await api(a, command)).data, saved.data);
    assert.equal((await api(b, command)).status, 409);
    assert.equal((await api(a, { ...command, questIds: [] })).status, 409);
    assert.equal((await api(b, { ...command, requestId: randomUUID(), questIds: [] })).status, 409);
    assert.deepEqual(retained(capture(service!.store)), retained(afterFirst), 'replay and stale second-device writing cannot create a second change');
    const next: StudioCommand = { requestId: randomUUID(), epoch, expectedRevision: 2, questIds: [second.id] };
    const savedNext = await api(b, next); assert.equal(savedNext.status, 200);
    const selected = capture(service!.store); assertSave(afterFirst, selected, next, b.deviceId, savedNext.data);
    assert.deepEqual(service!.store.profileProgress(), progress, 'shared Task completion and its one XP credit remain unchanged');
    await close(); await start(directory);
    assert.deepEqual(retained(capture(service!.store)), retained(selected), 'second actual settled startup preserves selection and original command authority');
    assert.deepEqual((await api(a, command)).data, saved.data, 'historical original response survives a later selection and restart');
    assert.deepEqual((await api(b, next)).data, savedNext.data);
    assert.deepEqual((await api(a)).data, { epoch, curation: savedNext.data.curation, availableQuestIds: [second.id], unavailable: [] });
    assert.deepEqual(retained(capture(service!.store)), retained(selected), 'reopened reads and original receipt observations are read-only');
    assert.deepEqual(service!.store.download(file.id).bytes, Buffer.from('Exact original writing\n'));
    const corrupt = structuredClone(selected); corrupt.files[0].base64 = Buffer.from('wrong').toString('base64');
    assert.throws(() => Store.verifyBackup(corrupt), { code: 'backup_file' });
    await close();

    const restoreStart = Date.now(), heldPath = join(parent, 'held');
    restoring = Store.restoreBackup(heldPath, selected);
    const restoreEnd = Date.now(), heldEpoch = restoring.epoch, heldSession = restoring.session(), restored = capture(restoring);
    assert.notEqual(heldEpoch, epoch); assert.equal(restoring.recoveryHeld, true);
    const recoveredAt = restoring.internalRead<any>('recovery:state').recoveredAt; stamp(recoveredAt, restoreStart, restoreEnd);
    const replaced = new Set(['http:session-cookie', 'phone:access', 'recovery:state', 'recovery:retained-archives']);
    const restoredRow = (id: string, value: unknown) => ({ id, revision: (selected.services.find(row => row.id === id)?.revision ?? 0) + 1, value });
    const services = [...selected.services.filter(row => !replaced.has(row.id)),
      restoredRow('recovery:state', { held: true, backupId: selected.id, sourceEpoch: epoch, recoveredAt, native: 'not-configured' }),
      restoredRow('recovery:retained-archives', []), restoredRow('phone:access', { enabled: false })].sort(byId);
    assert.equal(restored.cursor, selected.cursor);
    assert.deepEqual(retained(restored), { ...retained(selected), epoch: heldEpoch, services },
      'full original-to-held restore allows only the exact fresh epoch and derived recovery/phone/cookie transform');
    restoring.close(); restoring = undefined; await start(heldPath);
    const held = capture(service!.store), cookie = held.services.find(row => row.id === 'http:session-cookie')!;
    assert.ok(cookie); assert.equal(cookie.revision, 1); assert.match(String(cookie.value), /^e3_session_[a-f0-9]{32}$/);
    assert.deepEqual(retained(held), { ...retained(restored), services: [...restored.services, cookie].sort(byId) },
      'held application startup adds only its exact new cookie record');
    assert.equal((await api(a)).status, 401, 'original pre-restore session cannot access the recovered workspace');
    assert.deepEqual((await api(heldSession)).data, { epoch: heldEpoch, curation: savedNext.data.curation, availableQuestIds: [second.id], unavailable: [] });
    assert.equal((await api(heldSession, { ...next, requestId: randomUUID(), epoch: heldEpoch, expectedRevision: 3, questIds: [] })).status, 409);
    assert.deepEqual(retained(capture(service!.store)), retained(held), 'held reads and refused writing preserve all original authority and saved work');
    assert.deepEqual(service!.store.profileProgress(), { ...progress, epoch: heldEpoch });
    assert.deepEqual(nativeCalls, [], 'zero native or provider requests');
    assert.deepEqual(externalCalls, [], 'zero external/Gallery requests; fixture fence permits only its exact local service origins');
    await close(); passed = true;
  } finally {
    try { await service?.close(); restoring?.close(); } finally { globalThis.fetch = realFetch; }
    if (passed) {
      assert.equal(dirname(resolve(parent)), resolve(tmpdir())); assert.ok(basename(parent).startsWith('nova-profile-studio-startup-'));
      rmSync(parent, { recursive: true, force: true });
    } else process.stderr.write('Preserved isolated Studio startup fixture: ' + parent + '\n');
  }
});
