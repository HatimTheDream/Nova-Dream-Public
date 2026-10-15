import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/service/http.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { phoneRouteAllowed } from '../apps/service/phone-policy.js';

test('Home and activity routes retain session, origin, epoch, revision and maintenance authority through real service restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-approved-ui-http-'));
  let server = await startServer({ directory, port: 0 });
  try {
    const call = (path: string, value?: unknown, extra: Record<string, string> = {}) => fetch(server.origin + '/api/' + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1', ...extra },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    let cookie = '';
    const session = await call('session', {}), sessionData = await session.json();
    cookie = session.headers.get('set-cookie')!.split(';')[0];
    const envelope = () => ({ requestId: randomUUID(), epoch: server.store.epoch });
    const note = { ...envelope(), type: 'item-save', id: 'note:' + randomUUID(), expectedRevision: 0, value: { kind: 'note', title: 'Kept reference', body: 'Reference text, retained exactly.', archived: false } };
    for (const path of ['home/library', 'home/feed', 'agents/activity']) {
      assert.equal((await call(path, undefined, { cookie: '' })).status, 401);
      assert.equal((await call(path, undefined, { origin: 'https://foreign.example' })).status, 403);
    }
    assert.equal((await call('home/library', note, { 'X-Edition3-Client': '' })).status, 403);
    assert.equal((await call('home/library', { ...note, epoch: randomUUID() })).status, 409);
    const savedNote = await (await call('home/library', note)).json();
    assert.deepEqual(await (await call('home/library', note)).json(), savedNote);
    assert.equal((await call('home/library', { ...note, ...envelope() })).status, 409);
    const captureRequest = { ...envelope(), references: [{ kind: 'note', id: savedNote.id, revision: savedNote.revision }] };
    const capture = await (await call('home/context', captureRequest)).json();
    assert.equal(capture.sources[0].text, note.value.body);
    const destinationRequest = { epoch: server.store.epoch, reference: captureRequest.references[0] };
    const destination = await call('home/feed/open', destinationRequest);
    assert.equal(destination.status, 200);
    assert.match((await destination.json()).text, /Reference text, retained exactly/);
    assert.equal((await call('home/feed/open', destinationRequest, { cookie: '' })).status, 401);
    assert.equal((await call('home/feed/open', { ...destinationRequest, epoch: randomUUID() })).status, 409);
    assert.equal((await call('home/feed/open', { ...destinationRequest, reference: { ...destinationRequest.reference, id: '../private' } })).status, 400);
    const agent = server.store.mutate(sessionData.deviceId, { ...envelope(), kind: 'agent', entityId: 'agent:' + randomUUID(), expectedRevision: 0, payload: { ...blankRecord('agent', 'UTC'), name: 'Owner Agent', position: 'Planning Partner' } });
    const sleep = { ...envelope(), type: 'sleep', agentId: agent.id, expectedRevision: 0 };
    assert.equal((await call('agents/activity', { ...sleep, autonomy: { authorized: true } })).status, 400);
    const sleeping = await (await call('agents/activity', sleep)).json();
    assert.equal(sleeping.preference.value.sleep, 'asleep');
    assert.deepEqual(await (await call('agents/activity', sleep)).json(), sleeping);
    assert.equal((await call('agents/activity', { ...sleep, ...envelope() })).status, 409);
    server.store.setUpdateMaintenanceHeld(true);
    assert.equal((await call('home/library', { ...note, ...envelope(), expectedRevision: 1 })).status, 409);
    assert.equal((await call('agents/activity', { ...envelope(), type: 'wake', agentId: agent.id, expectedRevision: 1 })).status, 409);
    server.store.setUpdateMaintenanceHeld(false);
    assert.equal((await call('agents/meetings?meetingId=invalid')).status, 400);
    assert.equal((await call('agents/meetings?meetingId=' + randomUUID() + '&meetingId=' + randomUUID())).status, 400);
    await server.close(); server = await startServer({ directory, port: 0 });
    assert.equal((await (await call('home/library')).json()).items[0].body, note.value.body);
    assert.deepEqual(await (await call('home/context', captureRequest)).json(), capture);
    assert.equal((await (await call('agents/activity')).json()).preferences[0].value.sleep, 'asleep');
    assert.equal((await (await call('assignments/state')).json()).attempts.length, 0);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('phone policy exposes approved workspace UI routes while setup authority remains desktop-only', () => {
  for (const [method, path] of [['GET', 'home/library'], ['POST', 'home/library'], ['POST', 'home/context'], ['GET', 'home/feed'], ['POST', 'home/feed/open'], ['GET', 'agents/activity'], ['POST', 'agents/activity']]) assert.equal(phoneRouteAllowed('/api/' + path, method), true);
  assert.equal(phoneRouteAllowed('/api/agents/activity', 'DELETE'), false);
  assert.equal(phoneRouteAllowed('/api/assistant/runtime/start', 'POST'), false);
});
