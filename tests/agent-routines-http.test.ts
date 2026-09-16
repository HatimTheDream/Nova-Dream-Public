import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/service/http.js';
import { blankRecord } from '../packages/domain/workspace-records.js';

test('routine API uses workspace session/origin/revision authority and retains schedules across a real service reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e3-routine-http-'));
  let server = await startServer({ directory, port: 0 });
  try {
    const session = await fetch(server.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1' }, body: '{}' });
    const cookie = session.headers.get('set-cookie')!.split(';')[0], device = (await session.json()).deviceId;
    const create = (kind: any, payload: any): any => server.store.mutate(device, { requestId: randomUUID(), epoch: server.store.epoch, kind, entityId: `${kind}:${randomUUID()}`, expectedRevision: 0, payload });
    const agent = create('agent', { ...blankRecord('agent', 'UTC'), name: 'Scheduled agent', position: 'Editor' });
    const plan = create('assignment', { ...blankRecord('assignment', 'UTC'), title: 'Saved plan', agentId: agent.id, agentRevision: 1 });
    const input = { id: randomUUID(), requestId: randomUUID(), epoch: server.store.epoch, expectedRevision: 0, value: { name: 'Kept routine', assignmentId: plan.id, assignmentRevision: 1, projectRevision: null, timezone: 'UTC', schedule: { kind: 'every', minutes: 60, anchor: new Date(Date.now() + 3600000).toISOString() }, enabled: true, archived: false, missed: 'skip' } };
    const send = (body: unknown, extra: Record<string, string> = {}) => fetch(server.origin + '/api/agent-routines/save', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1', ...extra }, body: JSON.stringify(body) });
    assert.equal((await send(input, { cookie: '' })).status, 401);
    assert.equal((await send(input, { origin: 'https://foreign.example' })).status, 403);
    assert.equal((await send(input, { 'X-Edition3-Client': '' })).status, 403);
    assert.equal((await send({ ...input, epoch: randomUUID() })).status, 409);
    const result = await send(input); assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); const saved = await result.json();
    assert.equal((await send({ ...input, requestId: randomUUID() })).status, 409);
    assert.deepEqual(await (await send(input)).json(), saved);
    assert.equal((await fetch(server.origin + '/api/agent-routines/state')).status, 401);
    assert.equal((await fetch(server.origin + '/api/agents/hub')).status, 401);
    const hub = await fetch(server.origin + '/api/agents/hub', { headers: { cookie } });
    assert.equal(hub.status, 200); assert.equal(hub.headers.get('cache-control'), 'no-store');
    assert.equal((await hub.json()).agents[0].routines[0].id, input.id);
    assert.equal((await fetch(server.origin + '/api/agents/hub?archived=invalid', { headers: { cookie } })).status, 400);
    assert.equal((await fetch(server.origin + '/api/agent-routines/state?before=invalid', { headers: { cookie } })).status, 400);
    await server.close(); server = await startServer({ directory, port: 0 });
    const restored = await fetch(server.origin + '/api/agent-routines/state', { headers: { cookie } }), state = await restored.json();
    assert.equal(restored.status, 200); assert.deepEqual(state.routines[0], saved); assert.equal(state.history.length, 0);
    const paused = await send({ ...input, expectedRevision: 1, requestId: randomUUID(), value: { ...input.value, enabled: false } });
    assert.equal(paused.status, 200); assert.equal((await paused.json()).nextAt, null);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
