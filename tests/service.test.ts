import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../apps/service/http.js';
import { Store } from '../apps/service/store.js';
import { emptyDraft, type Command, type Snapshot, type Task } from '../packages/domain/contracts.js';

const directory = mkdtempSync(join(tmpdir(), 'edition3-api-'));
let service: Awaited<ReturnType<typeof startServer>>;
type Client = { cookie: string; device: string };
let a: Client, b: Client;
async function client(): Promise<Client> {
  const response = await fetch(`${service.origin}/api/session`, { method: 'POST', headers: { 'X-Edition3-Client': '1' } });
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], device: (await response.json()).deviceId };
}
async function api<T = any>(client: Client, path: string, body?: unknown) {
  const response = await fetch(`${service.origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: client.cookie, 'X-Edition3-Client': '1', 'Content-Type': 'application/json', Origin: service.origin }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as T };
}
const task: Task = { title: 'Private fixture title 73fdd8', notes: 'Retain the exact proposal', status: 'open', planned: '2026-09-07', due: '2026-09-09' };
function command(kind: Command['kind'], entityId: string, payload: unknown, revision = 0): Command { return { requestId: randomUUID(), epoch: service.store.epoch, kind, entityId, payload, expectedRevision: revision }; }
before(async () => { service = await startServer({ directory, port: 0 }); a = await client(); b = await client(); });
after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });

test('service requires authentication, rejects foreign origins, cross-site and invalid hosts', async () => {
  assert.equal((await fetch(`${service.origin}/api/snapshot`)).status, 401);
  assert.equal((await fetch(`${service.origin}/api/session`, { method: 'POST', headers: { 'X-Edition3-Client': '1', Origin: 'https://hostile.example' } })).status, 403);
  assert.equal((await fetch(`${service.origin}/api/session`, { method: 'POST' })).status, 403);
  const forgedHostStatus = await new Promise<number | undefined>((accept, reject) => { const request = httpRequest(`${service.origin}/api/snapshot`, { headers: { Cookie: a.cookie, Host: 'hostile.example' } }, response => { response.resume(); accept(response.statusCode); }); request.on('error', reject); request.end(); });
  assert.equal(forgedHostStatus, 403);
});

test('saved image preview returns bounded raster bytes while active formats remain attachment-only', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = service.store.upload(a.device, randomUUID(), service.store.epoch, 'output.png', png.toString('base64'));
  const preview = await fetch(`${service.origin}/api/attachments/${image.id}?preview=1`, { headers: { Cookie: a.cookie } });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.match(preview.headers.get('content-disposition')!, /^inline;/); assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  const svg = service.store.upload(a.device, randomUUID(), service.store.epoch, 'output.svg', Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64'));
  const download = await fetch(`${service.origin}/api/attachments/${svg.id}?preview=1`, { headers: { Cookie: a.cookie } });
  assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.match(download.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(download.headers.get('content-security-policy'), "sandbox; default-src 'none'"); await download.arrayBuffer();
  assert.equal((await fetch(`${service.origin}/api/attachments/${image.id}?preview=1`)).status, 401);
});

test('workspaces sharing a browser host keep distinct sessions and retain legacy device identity', async () => {
  const directories = [mkdtempSync(join(tmpdir(), 'edition3-cookie-a-')), mkdtempSync(join(tmpdir(), 'edition3-cookie-b-'))];
  const services: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    for (const directory of directories) services.push(await startServer({ directory, port: 0 }));
    const original = services[0].store.session();
    const legacy = `e3_session=${original.token}`;
    const bootstrap = async (index: number, cookie: string) => {
      const response = await fetch(`${services[index].origin}/api/session`, { method: 'POST', headers: { Cookie: cookie, 'X-Edition3-Client': '1' } });
      assert.equal(response.status, 200);
      return { cookie: response.headers.get('set-cookie')?.split(';')[0], deviceId: (await response.json()).deviceId };
    };
    const first = await bootstrap(0, legacy);
    assert.equal(first.deviceId, original.deviceId, 'legacy adoption must retain the same draft owner');
    assert.ok(first.cookie?.startsWith('e3_session_'));
    const second = await bootstrap(1, `${legacy}; ${first.cookie}`);
    assert.notEqual(second.deviceId, first.deviceId);
    assert.notEqual(second.cookie?.split('=')[0], first.cookie?.split('=')[0]);
    const cookieJar = `${legacy}; ${first.cookie}; ${second.cookie}`;
    for (let index = 0; index < services.length; index++) {
      const expected = index === 0 ? first : second;
      assert.equal((await bootstrap(index, cookieJar)).deviceId, expected.deviceId);
      const response = await fetch(`${services[index].origin}/api/snapshot`, { headers: { Cookie: cookieJar } });
      assert.equal(response.status, 200);
    }
    await services[0].close();
    services[0] = await startServer({ directory: directories[0], port: 0 });
    const resumed = await bootstrap(0, cookieJar);
    assert.equal(resumed.deviceId, first.deviceId);
    assert.equal(resumed.cookie, undefined, 'restarts keep the already adopted cookie');
    const invalidScoped = `${first.cookie!.split('=')[0]}=invalid; ${legacy}`;
    assert.equal((await fetch(`${services[0].origin}/api/snapshot`, { headers: { Cookie: invalidScoped } })).status, 401, 'an invalid scoped cookie cannot fall back to legacy identity');
  } finally {
    for (const instance of services) await instance.close();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
});

test('a dropped HTTP response reconciles the original result and one effect across two clients', async () => {
  const cmd = command('task', `task:${randomUUID()}`, task);
  let committedResolve!: () => void;
  const committed = new Promise<void>(resolve => { committedResolve = resolve; });
  const proxy = createServer(async (incoming, outgoing) => {
    const parts: Buffer[] = []; for await (const part of incoming) parts.push(part);
    const result = await fetch(`${service.origin}/api/commands`, { method: 'POST', headers: { Cookie: a.cookie, 'Content-Type': 'application/json', 'X-Edition3-Client': '1', Origin: service.origin }, body: Buffer.concat(parts) });
    assert.equal(result.status, 200); await result.arrayBuffer(); committedResolve(); outgoing.destroy();
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const port = (proxy.address() as { port: number }).port;
    await assert.rejects(fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify(cmd) })); await committed;
    const fromB = await api<Snapshot>(b, 'snapshot'); assert.equal(fromB.data.tasks.filter(t => t.id === cmd.entityId).length, 1);
    const retry = await api(a, 'commands', cmd); assert.equal(retry.status, 200); assert.equal(retry.data.revision, 1);
    assert.deepEqual(retry.data, fromB.data.tasks.find(t => t.id === cmd.entityId));
    assert.equal((await api<Snapshot>(b, 'snapshot')).data.tasks.find(t => t.id === cmd.entityId)?.revision, 1);
    assert.equal((await api(b, 'commands', cmd)).status, 409, 'another device cannot reuse the caller’s request receipt');
    assert.equal((await api(a, 'commands', { ...cmd, payload: { ...task, title: 'Changed under same ID' } })).status, 409);
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test('layout conflict preserves the authoritative layout and the rejected proposal', async () => {
  const initial = (await api<Snapshot>(a, 'snapshot')).data;
  const first = command('layout', 'layout', { ...initial.layout.value, theme: 'dark' }, initial.layout.revision);
  const second = command('layout', 'layout', { ...initial.layout.value, nav: [...initial.layout.value.nav].reverse() }, initial.layout.revision);
  assert.equal((await api(a, 'commands', first)).status, 200);
  const conflict = await api(b, 'commands', second);
  assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'revision_conflict'); assert.equal(conflict.data.current.value.theme, 'dark');
  assert.notDeepEqual(second.payload, conflict.data.current.value);
});

test('navigation is a complete unique permutation; Settings cannot enter it; invalid dates rejected', async () => {
  const snapshot = (await api<Snapshot>(a, 'snapshot')).data;
  assert.equal((await api(a, 'commands', command('layout', 'layout', { ...snapshot.layout.value, nav: ['settings', ...snapshot.layout.value.nav.slice(1)] }, snapshot.layout.revision))).status, 400);
  assert.equal((await api(a, 'commands', command('layout', 'layout', { ...snapshot.layout.value, nav: Array(9).fill('home') }, snapshot.layout.revision))).status, 400);
  assert.equal((await api(a, 'commands', command('task', `task:${randomUUID()}`, { ...task, planned: '2026-02-31' }))).status, 400);
});

test('encrypted attachment bytes and draft link survive restart and continue on another device', async () => {
  const source = Buffer.from('These are real retained attachment bytes.\n');
  const upload = { requestId: randomUUID(), epoch: service.store.epoch, name: 'private-notes.txt', base64: source.toString('base64') };
  const first = await api(a, 'attachments', upload); assert.equal(first.status, 200);
  assert.deepEqual((await api(a, 'attachments', upload)).data, first.data);
  const draftValue = { ...emptyDraft, text: 'Keep this draft with its actual file.', attachments: [first.data] };
  const saved = await api(a, 'commands', command('draft', `draft:${a.device}`, draftValue)); assert.equal(saved.status, 200);
  const fromB = (await api<Snapshot>(b, 'snapshot')).data.drafts.find(item => item.id === `draft:${a.device}`)!;
  assert.deepEqual(fromB.value, draftValue);
  assert.equal((await api(b, 'commands', command('draft', fromB.id, { ...draftValue, text: 'Clobber A' }, 1))).status, 403);
  assert.equal((await api(b, 'commands', command('draft', `draft:${b.device}`, draftValue))).status, 200);
  const oldEpoch = service.store.epoch;
  await service.close(); service = await startServer({ directory, port: 0 });
  assert.equal(service.store.epoch, oldEpoch);
  assert.deepEqual((await api<Snapshot>(b, 'snapshot')).data.drafts.find(item => item.id === `draft:${b.device}`)?.value, draftValue);
  const download = await fetch(`${service.origin}/api/attachments/${first.data.id}`, { headers: { Cookie: b.cookie } });
  assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), source);
  assert.equal(readFileSync(join(directory, 'blobs', first.data.id)).includes(source), false);
  for (const name of readdirSync(directory).filter(name => name.startsWith('workspace.sqlite'))) assert.equal(readFileSync(join(directory, name)).includes(Buffer.from(task.title)), false, `${name} must not expose the task title`);
});

test('attachment metadata tampering and missing Project are rejected before draft write', async () => {
  const draft = (await api<Snapshot>(a, 'snapshot')).data.drafts.find(item => item.id === `draft:${a.device}`)!;
  const tampered = { ...draft.value, attachments: draft.value.attachments.map(item => ({ ...item, name: 'forged-name.txt' })) };
  assert.equal((await api(a, 'commands', command('draft', draft.id, tampered, draft.revision))).status, 409);
  assert.equal((await api(a, 'commands', command('draft', draft.id, { ...draft.value, projectId: 'project:missing' }, draft.revision))).status, 409);
  assert.deepEqual((await api<Snapshot>(a, 'snapshot')).data.drafts.find(item => item.id === draft.id)?.value, draft.value);
});

test('old epochs cannot mutate or replay a receipt; Assistant submission fails closed', async () => {
  const cmd = command('task', `task:${randomUUID()}`, task);
  assert.equal((await api(a, 'commands', { ...cmd, epoch: randomUUID() })).status, 409);
  assert.equal((await api(a, 'commands', cmd)).status, 200);
  const recoveryFixture = new DatabaseSync(join(directory, 'workspace.sqlite'));
  recoveryFixture.prepare("UPDATE meta SET value=? WHERE key='epoch'").run(randomUUID()); recoveryFixture.close();
  assert.equal((await api(a, 'commands', cmd)).status, 409, 'a previously committed receipt cannot cross the recovery epoch');
  assert.equal((await api(a, 'assistant/submit', { text: 'Do something', draftId: `draft:${a.device}` })).status, 503);
  assert.equal((await api<Snapshot>(a, 'snapshot')).data.capabilities.assistant, false);
});

test('missing encryption key cannot overwrite an existing workspace', () => {
  const path = mkdtempSync(join(tmpdir(), 'edition3-missing-key-'));
  try {
    const existing = new Store(path); existing.close(); unlinkSync(join(path, 'preview.key'));
    const before = readFileSync(join(path, 'workspace.sqlite'));
    assert.throws(() => new Store(path), /key is missing/);
    assert.deepEqual(readFileSync(join(path, 'workspace.sqlite')), before);
  } finally { rmSync(path, { recursive: true, force: true }); }
});
