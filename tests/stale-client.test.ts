import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/service/http';
import { phoneRouteAllowed } from '../apps/service/phone-policy';

const identity = { version: '0.70.1', buildVersion: '1.0.124', candidateId: 'a'.repeat(64) };
test('an exact document candidate gates snapshots and writes before admission, keeping the original retry identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-stale-client-'));
  const service = await startServer({ directory, port: 0, ...identity });
  try {
    const session = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const { deviceId } = await session.json();
    const headers = { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', Cookie: cookie };
    const command = { requestId: randomUUID(), epoch: service.store.epoch, kind: 'task', entityId: `task:${randomUUID()}`, expectedRevision: 0, payload: { title: 'Kept across the update', notes: 'Exact original proposal', status: 'open', planned: '', due: '' } };
    for (const supplied of [undefined, 'b'.repeat(64), identity.version, identity.buildVersion]) {
      const staleHeaders = { ...headers, ...(supplied ? { 'X-Edition3-Candidate': supplied } : {}) };
      for (const [path, data] of [['snapshot', undefined], ['commands', command], ['storage/backups/upload', 'not-read']] as const) {
        const response = await fetch(service.origin + '/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: staleHeaders, body: data === undefined ? undefined : JSON.stringify(data) });
        assert.equal(response.status, 409); assert.equal((await response.json()).code, 'client_update');
      }
    }
    assert.equal(service.store.snapshot(deviceId).tasks.length, 0);
    const matching = { ...headers, 'X-Edition3-Candidate': identity.candidateId };
    const oldShell = await fetch(service.origin + '/api/commands', { method: 'POST', headers: { ...matching, 'X-Edition3-Desktop': 'b'.repeat(64) }, body: JSON.stringify(command) });
    assert.equal((await oldShell.json()).code, 'client_update');
    const shell = await fetch(service.origin + '/api/snapshot', { headers: { ...matching, 'X-Edition3-Desktop': identity.candidateId } });
    assert.equal(shell.status, 200);
    const send = () => fetch(service.origin + '/api/commands', { method: 'POST', headers: matching, body: JSON.stringify(command) });
    const first = await send(); assert.equal(first.status, 200); const record = await first.json();
    assert.deepEqual(await (await send()).json(), record);
    const snapshot = await fetch(service.origin + '/api/snapshot', { headers: matching });
    assert.equal(snapshot.status, 200); assert.equal((await snapshot.json()).tasks.length, 1);
    const unauthenticated = await fetch(service.origin + '/api/commands', { method: 'POST', headers: { 'X-Edition3-Client': '1', 'X-Edition3-Candidate': identity.candidateId }, body: JSON.stringify(command) });
    assert.equal(unauthenticated.status, 401);
    const native = await fetch(service.origin + '/workspace', { method: 'POST', body: '{}' });
    assert.equal((await native.json()).code, 'workspace_tool_auth');
    for (const path of ['/workspace/research-progress/authorize', '/workspace/research-progress']) {
      assert.equal(phoneRouteAllowed(path, 'POST'), false);
      const cookieOnly = await fetch(service.origin + path, { method: 'POST', headers: matching, body: '{}' });
      assert.equal(cookieOnly.status, 403); assert.equal((await cookieOnly.json()).code, 'workspace_tool_auth');
      const crossOrigin = await fetch(service.origin + path, { method: 'POST', headers: { ...matching, Origin: 'https://unrelated.example', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' });
      assert.equal(crossOrigin.status, 403); assert.equal((await crossOrigin.json()).code, 'origin_rejected');
      const wrongToken = await fetch(service.origin + path, { method: 'POST', headers: { ...matching, Authorization: 'Bearer ' + 'a'.repeat(64) }, body: '{}' });
      assert.equal(wrongToken.status, 403); assert.equal((await wrongToken.json()).code, 'workspace_tool_auth');
    }
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a stale window can end its dictation but cannot bypass ownership or start another operation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-stale-stop-'));
  const service = await startServer({ directory, port: 0, ...identity });
  try {
    const session = service.store.session(), other = service.store.session();
    const id = randomUUID(), epoch = service.store.epoch;
    service.store.internalWrite(`dictation:${id}`, { id, requestId: randomUUID(), epoch, deviceId: session.deviceId, draftId: `draft:${session.deviceId}`, generation: randomUUID(), state: 'ended', text: 'Retained spoken words', final: true, sequence: 0, updatedAt: Date.now() });
    // Bootstrap through HTTP to discover the workspace-specific cookie name.
    const bootstrap = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } });
    const name = bootstrap.headers.get('set-cookie')!.split('=')[0];
    const headers = { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', 'X-Edition3-Candidate': 'b'.repeat(64), Cookie: `${name}=${session.token}` };
    const action = { requestId: randomUUID(), epoch, attemptId: id };
    const own = await fetch(service.origin + '/api/assistant/dictation/end', { method: 'POST', headers, body: JSON.stringify(action) });
    assert.equal(own.status, 200); assert.equal((await own.json()).text, 'Retained spoken words');
    const foreign = await fetch(service.origin + '/api/assistant/dictation/end', { method: 'POST', headers: { ...headers, Cookie: `${name}=${other.token}` }, body: JSON.stringify(action) });
    assert.equal(foreign.status, 403); assert.equal((await foreign.json()).code, 'dictation_owner');
    for (const path of ['assistant/voice/start', 'assignments/start', 'assistant/approval/resolve', 'assistant/voice/finals']) {
      const response = await fetch(service.origin + '/api/' + path, { method: 'POST', headers, body: '{}' });
      assert.equal((await response.json()).code, 'client_update');
    }
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('only the serving index template receives a validated candidate identity; development remains available', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-stale-html-'));
  const client = join(directory, 'client'); mkdirSync(client);
  const html = '<!doctype html><html><head><title>Nova</title></head><body>Workspace</body></html>';
  writeFileSync(join(client, 'index.html'), html); writeFileSync(join(client, 'example.html'), html);
  try {
    const invalid = join(directory, 'invalid');
    await assert.rejects(startServer({ directory: invalid, port: 0, candidateId: '"><script>' }));
    assert.equal(existsSync(invalid), false);
    const service = await startServer({ directory: join(directory, 'data'), clientDirectory: client, port: 0, ...identity });
    try {
      for (const path of ['/', '/tasks', '/index.html']) assert.ok((await (await fetch(service.origin + path)).text()).includes(`<meta name="e3-candidate" content="${identity.candidateId}">`));
      assert.equal(await (await fetch(service.origin + '/example.html')).text(), html);
    } finally { await service.close(); }
    const dev = await startServer({ directory: join(directory, 'dev'), clientDirectory: client, port: 0 });
    try { assert.equal(await (await fetch(dev.origin)).text(), html); } finally { await dev.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
