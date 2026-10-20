import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../apps/service/store.js';
import { startServer } from '../apps/service/http.js';
import { weekNoteKey } from '../apps/service/profile-week-note.js';
import { canonical, type Entity, type Task } from '../packages/domain/contracts.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { WeekNoteCommand, WeekNoteReceipt } from '../packages/domain/profile-week-note.js';

const capture = (store: Store) => store.captureBackup('profile-week-note-qualification', { status: 'not-configured', notes: [] });
type Snapshot = ReturnType<typeof capture>;
type Session = ReturnType<Store['session']>;
const retained = (snapshot: Snapshot) => { const { id: _id, createdAt: _at, ...value } = snapshot; return value; };
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const stamp = (value: string, start: number, end: number) => {
  assert(Number.isFinite(Date.parse(value)) && Date.parse(value) >= start && Date.parse(value) <= end);
};
const week = { start: '2026-10-19', timezone: 'America/Los_Angeles' };
const oldZone = { ...week, timezone: 'UTC' };
const previous = { ...week, start: '2026-10-12' };

// Supported synthetic application/HTTP/Store lifecycle only. This does not run
// an installed runtime, real phone network, model, provider, or delivery tool.
test('weekly notes retain exact workspace authority through authenticated startup, restart and held restore', { timeout: 60000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'nova-profile-week-note-startup-')), directory = join(parent, 'original');
  let service: Awaited<ReturnType<typeof startServer>> | undefined, restoring: Store | undefined, passed = false;
  const nativeCalls: string[] = [], externalCalls: string[] = [], origins = new Set<string>();
  const realFetch = globalThis.fetch, phoneOrigin = 'https://week-note.example.ts.net:8443';
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!origins.has(url.origin)) { externalCalls.push(url.origin + url.pathname); return Promise.reject(Error('Only exact fixture origins are allowed')); }
    return realFetch(input, init);
  }) as typeof fetch;
  const gateway: AssistantTransport = {
    status: () => ({ state: 'unconfigured', message: 'Synthetic note fixture', methods: [], grantedScopes: [], modelAuthReady: false }),
    subscribe: () => () => {}, models: async () => [], attachmentPolicy: () => ({}),
    async request<T>(method: string): Promise<T> { nativeCalls.push(method); throw Error('Unexpected native request: ' + method); },
  };
  const start = async (path: string) => {
    service = await startServer({ directory: path, port: 0, gateway, phonePort: 0,
      phoneTransport: { reconcile: async () => ({ state: 'ready', origin: phoneOrigin, message: 'Synthetic local proxy' }), disable: async () => {} } });
    origins.add(service.origin); if (service.phoneHost.localOrigin) origins.add(service.phoneHost.localOrigin);
    await delay(3200);
  };
  const close = async () => {
    const own = service!, listeners = [own.origin, own.phoneHost.localOrigin].filter(Boolean);
    await own.close(); service = undefined;
    for (const origin of listeners) {
      origins.add(origin);
      await assert.rejects(fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) }));
    }
  };
  const api = async (path: string, session?: Session, body?: unknown, origin?: string) => {
    const response = await fetch(service!.origin + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
      headers: { ...(session ? { Cookie: 'e3_session=' + session.token } : {}), 'X-Edition3-Client': '1',
        'Content-Type': 'application/json', Origin: origin ?? service!.origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as any };
  };
  const phone = (path: string, cookie = '', body?: unknown, identity = true) => {
    const target = service!.phoneHost.localOrigin;
    assert.equal(new URL(target).hostname, '127.0.0.1');
    return new Promise<{ status: number; data: any; cookie?: string }>((accept, reject) => {
      const request = httpRequest(target + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Host: new URL(phoneOrigin).host, Origin: phoneOrigin, 'Content-Type': 'application/json',
          'X-Edition3-Client': '1', ...(identity ? { 'Tailscale-User-Login': 'fixture-owner@example.test' } : {}),
          ...(cookie ? { Cookie: cookie } : {}) } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try { accept({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()), cookie: response.headers['set-cookie']?.[0] }); }
          catch (error) { reject(error); }
        });
      });
      request.setTimeout(5000, () => request.destroy(Error('Bounded local phone request timed out')));
      request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const command = (identity = week, expectedRevision = 0, text = 'Exact weekly writing.\nSecond line.'): WeekNoteCommand =>
    ({ requestId: randomUUID(), epoch: service!.store.epoch, identity, expectedRevision, action: 'save', text });
  const assertEffect = (before: Snapshot, after: Snapshot, input: WeekNoteCommand, deviceId: string,
    result: WeekNoteReceipt, start: number, end: number) => {
    const key = weekNoteKey(input.identity), prior = before.services.find(row => row.id === key);
    stamp(result.note.updatedAt, start, end);
    const note = { format: 1, identity: input.identity, revision: input.expectedRevision + 1,
      text: input.action === 'save' ? input.text : (prior!.value as { text: string }).text,
      trashed: input.action === 'trash', updatedAt: result.note.updatedAt };
    assert.deepEqual(result, { requestId: input.requestId, epoch: input.epoch, action: input.action, note });
    const services = [...before.services.filter(row => row.id !== key),
      { id: key, revision: (prior?.revision ?? 0) + 1, value: note }].sort(byId);
    const receipts = [...before.receipts, { requestId: input.requestId, deviceId,
      digest: sha({ type: 'profile-week-note', ...input }), value: result }]
      .sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
    assert.deepEqual(retained(after), { ...retained(before), services, receipts },
      'only the exact note metadata row and original request receipt may change');
  };
  const save = async (input: WeekNoteCommand, owner: Session, remote?: { cookie: string; id: string }) => {
    const before = capture(service!.store), began = Date.now();
    const response = remote ? await phone('profile/week/note', remote.cookie, input) : await api('profile/week/note', owner, input);
    const ended = Date.now(); assert.equal(response.status, 200);
    assertEffect(before, capture(service!.store), input, remote?.id ?? owner.deviceId, response.data, began, ended);
    return response.data as WeekNoteReceipt;
  };
  try {
    await start(directory);
    const store = service!.store, epoch = store.epoch, owner = store.session(), other = store.session();
    assert(owner.token && other.token);
    let task = store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'task', entityId: 'task:' + randomUUID(), expectedRevision: 0,
      payload: { title: 'Original credited Task', notes: 'Keep original Task writing', status: 'open', planned: '', due: '' } }) as Entity<Task>;
    for (const status of ['done', 'open', 'done'] as const) task = store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'task',
      entityId: task.id, expectedRevision: task.revision, payload: { ...task.value, status } }) as Entity<Task>;
    const file = store.upload(owner.deviceId, randomUUID(), epoch, 'kept.txt', Buffer.from('Exact original file\n').toString('base64'));
    store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'draft', entityId: 'draft:' + owner.deviceId, expectedRevision: 0,
      payload: { title: 'Unsent independent writing', projectId: null, text: 'Keep every original word.', attachments: [file] } });
    store.mutate(owner.deviceId, { requestId: randomUUID(), epoch, kind: 'content', entityId: 'content:' + randomUUID(), expectedRevision: 0,
      payload: { ...blankRecord('content', 'UTC'), title: 'Original Content', body: 'Exact original body.' } });
    const authCommand = () => ({ requestId: randomUUID(), epoch });
    assert.equal((await api('phone/enable', owner, authCommand())).status, 200);
    const challenge = await api('phone/pairing', owner, authCommand()); assert.equal(challenge.status, 200);
    const pair = await phone('pair', '', { requestId: randomUUID(), code: challenge.data.code, name: 'Note fixture phone' });
    assert.equal(pair.status, 200); assert(pair.cookie);
    const remote = { cookie: pair.cookie.split(';')[0], id: pair.data.deviceId as string };
    const progress = store.profileProgress(), beforeNotes = capture(store); assert.equal(progress.earnedXp, 10);
    const params = new URLSearchParams(week).toString(), notePath = 'profile/week/note?' + params;
    assert.equal((await api(notePath, owner)).data.note, null);
    for (const path of [notePath, 'profile/week/notes']) {
      assert.equal((await api(path)).status, 401);
      assert.equal((await api(path, owner, undefined, 'http://example.invalid')).status, 403);
      assert.equal((await phone(path)).status, 401);
      assert.equal((await phone(path, remote.cookie, undefined, false)).status, 403);
    }
    assert.equal((await api('profile/week/note', undefined, command())).status, 401);
    for (const query of ['start=2026-10-20&timezone=UTC', 'start=2026-10-19&timezone=Invalid',
      'start=2026-10-19&start=2026-10-26&timezone=UTC', params + '&owner=other']) {
      assert.equal((await api('profile/week/note?' + query, owner)).status, 400);
    }
    assert.deepEqual(retained(capture(store)), retained(beforeNotes), 'reads and auth refusals are pure after pairing');

    const originalCommand = command(), first = await save(originalCommand, owner);
    const editedCommand = command(week, 1, 'Writing edited on the approved phone.\nExact retained body.');
    const edited = await save(editedCommand, owner, remote);
    await save(command(previous, 0, 'Earlier week stays discoverable.'), other);
    await save(command(oldZone, 0, 'Old Home Timezone writing stays separate.'), owner);
    const trash: WeekNoteCommand = { requestId: randomUUID(), epoch, identity: oldZone, expectedRevision: 1, action: 'trash' };
    const trashed = await save(trash, owner), selected = capture(store);
    assert.deepEqual((await api('profile/week/note', owner, originalCommand)).data, first);
    assert.deepEqual((await phone('profile/week/note', remote.cookie, editedCommand)).data, edited);
    assert.equal((await api('profile/week/note', other, originalCommand)).status, 409);
    assert.equal((await api('profile/week/note', owner, { ...originalCommand, text: 'Changed original payload' })).status, 409);
    assert.equal((await api('profile/week/note', other, command())).status, 409);
    assert.equal((await api('profile/week/note', owner, { ...command(), epoch: randomUUID() })).status, 409);
    assert.equal((await api('profile/week/note', owner, command(oldZone, 2, 'No silent restore'))).status, 409);
    service!.store.setUpdateMaintenanceHeld(true);
    assert.equal((await api('profile/week/note', owner, command(week, 2))).status, 409);
    assert.equal((await api(notePath, owner)).status, 200); service!.store.setUpdateMaintenanceHeld(false);
    assert.deepEqual(retained(capture(store)), retained(selected), 'all original replays and refused writes retain every field');
    assert.deepEqual(store.profileProgress(), progress);
    assert(!JSON.stringify(store.snapshot(owner.deviceId)).includes(edited.note.text));
    await close(); await start(directory);
    assert.deepEqual(retained(capture(service!.store)), retained(selected), 'complete settled existing-state equality');
    assert.deepEqual((await api(notePath, other)).data, { epoch, identity: week, note: edited.note });
    assert.deepEqual((await phone(notePath, remote.cookie)).data, { epoch, identity: week, note: edited.note });
    assert.deepEqual((await api('profile/week/note', owner, originalCommand)).data, first);
    const list = await api('profile/week/notes', owner);
    assert.equal(list.status, 200); assert.equal(list.data.total, 3); assert.equal(list.data.next, null);
    assert(list.data.rows.some((row: any) => canonical(row.identity) === canonical(oldZone) && row.trashed));
    assert(!JSON.stringify(list.data).includes(trashed.note.text));
    assert.deepEqual(retained(capture(service!.store)), retained(selected), 'reopened reads/replay remain pure');
    assert.deepEqual(service!.store.download(file.id).bytes, Buffer.from('Exact original file\n'));

    const malformedIdentity = { ...week, start: '2026-10-05' };
    service!.store.internalWrite(weekNoteKey(malformedIdentity), { format: 9, originalWriting: 'Keep unsupported original.' });
    const malformed = capture(service!.store); await close(); await start(directory);
    assert.deepEqual(retained(capture(service!.store)), retained(malformed), 'unsupported note metadata does not abort or rewrite startup');
    assert.equal((await api('snapshot', owner)).status, 200); assert.equal((await api(notePath, owner)).status, 200);
    assert.equal((await api('profile/week/note?' + new URLSearchParams(malformedIdentity), owner)).status, 409);
    assert.equal((await api('profile/week/notes', owner)).status, 409);
    assert.equal((await api('profile/week/note', owner, command(malformedIdentity))).status, 409);
    assert.deepEqual(retained(capture(service!.store)), retained(malformed));
    await close();

    const restoreStart = Date.now(), heldPath = join(parent, 'held');
    restoring = Store.restoreBackup(heldPath, selected);
    const restoreEnd = Date.now(), heldEpoch = restoring.epoch, heldOwner = restoring.session(), restored = capture(restoring);
    assert.notEqual(heldEpoch, epoch); assert(restoring.recoveryHeld);
    const recoveredAt = restoring.internalRead<{ recoveredAt: string }>('recovery:state')!.recoveredAt;
    stamp(recoveredAt, restoreStart, restoreEnd);
    const replaced = new Set(['http:session-cookie', 'phone:access', 'recovery:state', 'recovery:retained-archives']);
    const restoredRow = (id: string, value: unknown) => ({ id, revision: (selected.services.find(row => row.id === id)?.revision ?? 0) + 1, value });
    const services = [...selected.services.filter(row => !replaced.has(row.id)),
      restoredRow('recovery:state', { held: true, backupId: selected.id, sourceEpoch: epoch, recoveredAt, native: 'not-configured' }),
      restoredRow('recovery:retained-archives', []), restoredRow('phone:access', { enabled: false })].sort(byId);
    assert.deepEqual(retained(restored), { ...retained(selected), epoch: heldEpoch, services }, 'exact complete original-to-held derivation');
    restoring.close(); restoring = undefined; await start(heldPath);
    const held = capture(service!.store), cookie = held.services.find(row => row.id === 'http:session-cookie')!;
    assert.equal(cookie.revision, 1); assert.match(String(cookie.value), /^e3_session_[a-f0-9]{32}$/);
    assert.deepEqual(retained(held), { ...retained(restored), services: [...restored.services, cookie].sort(byId) });
    assert.equal((await api(notePath, owner)).status, 401);
    assert.deepEqual((await api(notePath, heldOwner)).data, { epoch: heldEpoch, identity: week, note: edited.note });
    assert.equal((await api('profile/week/notes', heldOwner)).data.total, 3);
    assert.equal((await api('profile/week/note', heldOwner, command(week, 2))).status, 409);
    assert.deepEqual(retained(capture(service!.store)), retained(held));
    assert.deepEqual(service!.store.profileProgress(), { ...progress, epoch: heldEpoch });
    const activationStart = Date.now(); service!.store.activateRecoveredLocal(); const activationEnd = Date.now();
    const recovery = service!.store.internalRead<any>('recovery:state'); stamp(recovery.activatedAt, activationStart, activationEnd);
    const priorRecovery = held.services.find(row => row.id === 'recovery:state')!;
    assert.deepEqual(recovery, { ...(priorRecovery.value as object), held: false, effectsPaused: true, activatedAt: recovery.activatedAt });
    const activated = capture(service!.store);
    assert.deepEqual(retained(activated), { ...retained(held), services: [...held.services.filter(row => row.id !== 'recovery:state'),
      { ...priorRecovery, revision: priorRecovery.revision + 1, value: recovery }].sort(byId) });
    assert.equal((await api('profile/week/note', heldOwner, originalCommand)).status, 409, 'old epoch receipts never gain restored authority');
    assert.deepEqual(retained(capture(service!.store)), retained(activated));
    await save({ requestId: randomUUID(), epoch: heldEpoch, identity: oldZone, expectedRevision: 2, action: 'restore' }, heldOwner);
    await save(command(week, 2, 'Explicit writing after local recovery activation.'), heldOwner);
    assert(service!.store.recoveryEffectsPaused); assert.deepEqual(service!.store.profileProgress(), { ...progress, epoch: heldEpoch });
    assert.deepEqual(nativeCalls, []); assert.deepEqual(externalCalls, []);
    await close(); passed = true;
  } finally {
    try { await service?.close(); restoring?.close(); } finally { globalThis.fetch = realFetch; }
    if (passed) {
      assert.equal(dirname(resolve(parent)), resolve(tmpdir())); assert(basename(parent).startsWith('nova-profile-week-note-startup-'));
      rmSync(parent, { recursive: true, force: true });
    } else process.stderr.write('Preserved isolated weekly-note startup fixture: ' + parent + '\n');
  }
});
