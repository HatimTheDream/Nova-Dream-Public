import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { UpdateAdmissionError } from '../apps/service/update-supervisor.js';
import { updateHeartbeatSchema } from '../apps/service/update-host-client.js';
import { updateHostConfigSchema, updateHostRequestHandler } from '../apps/service/update-host.js';

test('local controller accepts bounded validated actions and preserves uncertain admission errors', async () => {
  let checkCalls = 0, beats = 0;
  let requestError: Error | undefined;
  const view = { availability: 'unavailable' as const, installation: { supported: true }, holdFor: null };
  const controller = { view: () => view, check: async () => { checkCalls++; return view; }, request: async (_value: unknown) => { if (requestError) throw requestError; return view; }, cancel: (_value: unknown) => view, beat: (value: unknown) => { updateHeartbeatSchema.parse(value); beats++; return view; } };
  const server = createServer(updateHostRequestHandler(controller));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const call = (action: string, body: unknown, options: { origin?: string; declared?: number } = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port: address.port, agent: false, method: 'POST', path: '/v1/' + action, headers: { 'Content-Type': 'application/json', 'Content-Length': options.declared ?? bytes.length, ...(options.origin ? { Origin: options.origin } : {}) } }, response => {
      const chunks: Buffer[] = []; response.on('data', value => chunks.push(value)); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }); req.on('error', reject); req.end(bytes);
  });
  try {
    assert.deepEqual(await call('status', {}), { status: 200, body: view });
    assert.equal((await call('check', {})).status, 200); assert.equal(checkCalls, 1);
    assert.equal((await call('check', { url: 'https://arbitrary.example.test' })).status, 409); assert.equal(checkCalls, 1);
    assert.equal((await call('status', {}, { origin: 'https://example.test' })).status, 400);
    assert.equal((await call('status', {}, { declared: 65537 })).status, 413);
    assert.equal((await call('heartbeat', { candidateId: 'a'.repeat(64), epoch: 'e2864df8-f7d3-40f9-b377-c4a3620de271', heldFor: null, nativeSuspended:false, blockers: [] })).status, 200); assert.equal(beats, 1);
    assert.equal((await call('heartbeat', { candidateId: 'latest' })).status, 409); assert.equal(beats, 1);
    requestError = new UpdateAdmissionError('A verified update is required.'); assert.equal((await call('install', {})).status, 409);
    requestError = Error('/private/credential path is not public');
    const unknown = await call('install', {}); assert.equal(unknown.status, 500); assert(!JSON.stringify(unknown).includes('credential'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('root configuration cannot accept arbitrary endpoint or command fields', () => {
  const root = process.platform === 'win32' ? 'C:\\nova' : '/opt/nova';
  const config = { format: 1, stateDirectory: root + (process.platform === 'win32' ? '\\state' : '/state'), workspaceDirectory: root + (process.platform === 'win32' ? '\\workspace' : '/workspace'), releaseDirectory: root, runtimeDirectory: root, appCurrent: root, agentDirectory: root, feed: { url: 'https://updates.example.test/stable.json', publicKeyFile: root + (process.platform === 'win32' ? '\\public.pem' : '/public.pem'), channel: 'stable', artifactOrigins: ['https://updates.example.test'] } };
  assert(updateHostConfigSchema.safeParse(config).success);
  assert(!updateHostConfigSchema.safeParse({ ...config, socket: '/tmp/arbitrary.sock' }).success);
  assert(!updateHostConfigSchema.safeParse({ ...config, command: 'shell' }).success);
  assert(!updateHostConfigSchema.safeParse({ ...config, stateDirectory: './state' }).success);
});
