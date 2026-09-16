import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../apps/service/http.js';
import { Store } from '../apps/service/store.js';
import type { AssistantTransport } from '../apps/service/gateway.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function socketTo(origin: string) {
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) }); socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }); return socket;
}
async function fixture(gateway?: AssistantTransport) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-shutdown-'));
  const service = await startServer({ directory, port: 0, gateway });
  const session = await fetch(service.origin + '/api/session', { method: 'POST', headers: { 'X-Edition3-Client': '1' } });
  const cookie = session.headers.get('set-cookie')!.split(';')[0], device = (await session.json()).deviceId;
  return { directory, service, cookie, device };
}
function header(origin: string, cookie: string, length: number) { return `POST /api/commands HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nCookie: ${cookie}\r\nX-Edition3-Client: 1\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`; }

test('shutdown closes established preconnects, partial headers and incomplete bodies without a browser action', { timeout: 10000 }, async () => {
  for (const mode of ['preconnect', 'partialHeaders', 'partialBody']) {
    const f = await fixture(); let socket: Socket | undefined;
    try {
      socket = await socketTo(f.service.origin);
      if (mode === 'partialHeaders') socket.write('GET /api/accounts HTTP/1.1\r\nHost:');
      if (mode === 'partialBody') socket.write(header(f.service.origin, f.cookie, 1000) + '{');
      await delay(30); const began = Date.now();
      const first = f.service.close(), second = f.service.close(); assert.equal(first, second, 'one shutdown owns the store');
      await Promise.all([first, second]); assert.ok(Date.now() - began < 2500, `${mode} must drain within the bounded socket grace`);
    } finally { socket?.destroy(); await f.service.close(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test('a body completed after shutdown starts cannot admit a new mutation', { timeout: 5000 }, async () => {
  const f = await fixture(); let socket: Socket | undefined;
  try {
    const cmd = { requestId: randomUUID(), epoch: f.service.store.epoch, kind: 'task', entityId: `task:${randomUUID()}`, expectedRevision: 0, payload: { title: 'Late shutdown proposal', notes: '', status: 'open', planned: '', due: '' } };
    const body = JSON.stringify(cmd); socket = await socketTo(f.service.origin); let response = ''; socket.on('data', part => { response += part.toString(); });
    socket.write(header(f.service.origin, f.cookie, Buffer.byteLength(body)) + body.slice(0, 1)); await delay(30);
    const closing = f.service.close(); socket.write(body.slice(1)); await closing;
    assert.match(response, /503 Service Unavailable/); assert.match(response, /service_closing/);
    const reopened = new Store(f.directory); try { assert.equal(reopened.readEntity('task', cmd.entityId), undefined); } finally { reopened.close(); }
  } finally { socket?.destroy(); await f.service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('draining a dropped response preserves the original receipt and one saved effect through restart', { timeout: 5000 }, async () => {
  const f = await fixture(); let socket: Socket | undefined;
  try {
    const cmd = { requestId: randomUUID(), epoch: f.service.store.epoch, kind: 'task' as const, entityId: `task:${randomUUID()}`, expectedRevision: 0, payload: { title: 'Admitted before shutdown', notes: '', status: 'open' as const, planned: '', due: '' } };
    const body = JSON.stringify(cmd); socket = await socketTo(f.service.origin); socket.pause(); socket.write(header(f.service.origin, f.cookie, Buffer.byteLength(body)) + body);
    for (let i = 0; i < 100 && !f.service.store.readEntity('task', cmd.entityId); i++) await delay(5);
    const before = f.service.store.readEntity('task', cmd.entityId); assert.ok(before);
    await f.service.close(); const reopened = new Store(f.directory);
    try { reopened.mutate(f.device, cmd); assert.deepEqual(reopened.readEntity('task', cmd.entityId), before); assert.equal(reopened.snapshot(f.device).tasks.length, 1); } finally { reopened.close(); }
  } finally { socket?.destroy(); await f.service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('socket drain does not close the database while a started handler is still settling', { timeout: 5000 }, async () => {
  let started!: () => void, release!: () => void, checkStore!: () => void, sawOpenStore = false;
  const entered = new Promise<void>(resolve => { started = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const gateway: AssistantTransport = { status: () => ({ state: 'unconfigured', message: 'Fixture', methods: [], grantedScopes: [], modelAuthReady: false }), request: async () => { throw new Error('Unused fixture request'); }, subscribe: () => () => {}, attachmentPolicy: () => ({}), models: async () => { started(); await pending; checkStore(); return []; } };
  const f = await fixture(gateway); let request: Promise<unknown> | undefined;
  try {
    const epoch = f.service.store.epoch; checkStore = () => { assert.equal(f.service.store.epoch, epoch, 'store remains available until the handler settles'); sawOpenStore = true; };
    request = fetch(f.service.origin + '/api/assistant/models', { headers: { Cookie: f.cookie } }).then(r => r.text()).catch(() => undefined);
    await entered; let closed = false; const closing = f.service.close().then(() => { closed = true; });
    await delay(1150); assert.equal(closed, false); release(); await closing; await request; assert.equal(sawOpenStore, true, 'the handler must actually verify the open store');
  } finally { release(); await request; await f.service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
