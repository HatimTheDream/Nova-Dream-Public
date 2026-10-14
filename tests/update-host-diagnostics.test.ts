import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UpdateHostClient, UpdateHostRejected } from '../apps/service/update-host-client.js';

async function fixture(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'nova-update-diagnostic-'));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\nova-update-diagnostic-' + randomUUID() : join(directory, 'controller.sock');
  const server = createServer(handle), sockets = new Set<Socket>();
  server.on('connection', stream => { sockets.add(stream); stream.once('close', () => sockets.delete(stream)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.removeListener('error', reject); resolve(); }); });
  t.after(async () => { for (const stream of sockets) stream.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  const diagnostics: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { diagnostics.push(args); });
  return { client: new UpdateHostClient(socket), diagnostics };
}
const reply = (status: number, value: unknown) => (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
const code = (action: string, reason: string) => ['[nova-update-host]', action, reason];

test('409 refusals preserve their error and disclose only fixed private labels', async t => {
  for (const detail of ['Fresh heartbeat required: secret-workspace', 'Busy operation: private-job', 'Malformed request: credential-marker']) await t.test(detail.split(':')[0], async t => {
    const f = await fixture(t, reply(409, { message: detail, operationId: randomUUID() }));
    await assert.rejects(f.client.call('heartbeat', { token: 'private-request' }), error => error instanceof UpdateHostRejected && error.message === detail);
    assert.deepEqual(f.diagnostics, [code('heartbeat', 'controller_rejected')]);
    assert.equal(JSON.stringify(f.diagnostics).includes(detail), false);
  });
});

test('500 failures preserve generic error semantics without logging response or credentials', async t => {
  const f = await fixture(t, reply(500, { message: 'private controller failure' }));
  await assert.rejects(f.client.call('install', { secret: 'credential' }), error => error instanceof Error && !(error instanceof UpdateHostRejected) && error.message === 'private controller failure');
  assert.deepEqual(f.diagnostics, [code('install', 'controller_failed')]);
});

test('successful requests preserve payload/result and produce no failure diagnostic', async t => {
  const payload = { epoch: randomUUID(), candidateId: 'a'.repeat(64) }, received: { url?: string; body?: unknown } = {};
  const f = await fixture(t, (request, response) => { const chunks: Buffer[] = []; request.on('data', part => chunks.push(part)); request.on('end', () => {
    received.url = request.url; received.body = JSON.parse(Buffer.concat(chunks).toString()); reply(200, { availability: 'current', holdFor: null })(request, response);
  }); });
  assert.deepEqual(await f.client.call('check', payload), { availability: 'current', holdFor: null });
  assert.deepEqual(received, { url: '/v1/check', body: payload }); assert.deepEqual(f.diagnostics, []);
});

test('malformed response and excessive response are distinct and log exactly once', async t => {
  await t.test('malformed JSON', async t => {
    const f = await fixture(t, (_request, response) => response.end('secret-not-json'));
    await assert.rejects(f.client.call('status'), SyntaxError);
    assert.deepEqual(f.diagnostics, [code('status', 'response_invalid')]);
  });
  await t.test('oversized body', async t => {
    const f = await fixture(t, (_request, response) => response.end('x'.repeat(65537)));
    await assert.rejects(f.client.call('status'), /Invalid update response/);
    assert.deepEqual(f.diagnostics, [code('status', 'response_too_large')]);
  });
});

test('original five-second timeout rejects once without retrying or changing its error', { timeout: 9000 }, async t => {
  let requests = 0; const f = await fixture(t, request => { requests++; request.resume(); });
  await assert.rejects(f.client.call('heartbeat'), { message: 'The update service did not respond.' });
  assert.equal(requests, 1); assert.deepEqual(f.diagnostics, [code('heartbeat', 'request_timeout')]);
});

test('lost socket response is transport unavailable and does not retry', async t => {
  let requests = 0; const f = await fixture(t, request => { requests++; request.socket.destroy(); });
  await assert.rejects(f.client.call('cancel', { jobId: randomUUID() }));
  assert.equal(requests, 1); assert.deepEqual(f.diagnostics, [code('cancel', 'transport_unavailable')]);
});

test('oversized request is refused before dispatch and runtime action labels cannot leak', async t => {
  let requests = 0; const f = await fixture(t, (request, response) => { requests++; reply(409, { message: 'No' })(request, response); });
  await assert.rejects(f.client.call('install', { secret: 'x'.repeat(65536) }), /Update request is too large/);
  assert.equal(requests, 0); assert.deepEqual(f.diagnostics, [code('install', 'request_too_large')]);
  await assert.rejects(f.client.call('private-action-marker' as 'status'));
  assert.equal(requests, 1); assert.deepEqual(f.diagnostics[1], code('unknown', 'controller_rejected'));
});

test('diagnostic writer failure cannot turn a rejection into success or another error', async t => {
  const f = await fixture(t, reply(409, { message: 'Original refusal' }));
  t.mock.method(console, 'warn', () => { throw Error('logger unavailable'); });
  await assert.rejects(f.client.call('install'), error => error instanceof UpdateHostRejected && error.message === 'Original refusal');
});
