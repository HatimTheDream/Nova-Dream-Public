import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { startServer } from '../apps/service/http.js';
import { PhoneHost } from '../apps/service/phone-host.js';
import { PhoneAccess } from '../apps/service/phone-access.js';
import { Store } from '../apps/service/store.js';
import { routeOwnership, TailscalePhoneTransport } from '../apps/service/phone-transport.js';
import { blankRecord } from '../packages/domain/workspace-records.js';
import { hubLayoutKey, type HubLayout } from '../packages/domain/hub-layout.js';
import { Providers, accountCapabilities } from '../apps/service/providers.js';
import type { ConnectedAccount } from '../packages/domain/accounts.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import jsQR from 'jsqr';

const origin = 'https://phone.example.ts.net:8443';
function call(target: string, path: string, value?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; data: any; cookie?: string }>((accept, reject) => {
    const req = httpRequest(target + '/api/' + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Edition3-Client': '1', ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => accept({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()), cookie: response.headers['set-cookie']?.[0] }));
    }); req.on('error', reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
const remote = { Host: new URL(origin).host, Origin: origin, 'Tailscale-User-Login': 'owner@example.test' };

async function pairedWorkflow(t: test.TestContext, providers?: Providers) {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-phone-workflow-'));
  const service = await startServer({ directory, port: 0, phonePort: 0, providers, phoneTransport: { reconcile: async () => ({ state: 'ready', origin, message: 'Fixture private route' }), disable: async () => {} } });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = await call(service.origin, 'session', {}), ownerHeaders = { Cookie: owner.cookie!.split(';')[0] };
  const command = () => ({ requestId: randomUUID(), epoch: service.store.epoch });
  await call(service.origin, 'phone/enable', command(), ownerHeaders);
  const challenge = await call(service.origin, 'phone/pairing', command(), ownerHeaders);
  const paired = await call(service.phoneHost.localOrigin, 'pair', { requestId: randomUUID(), code: challenge.data.code, name: 'Workflow phone' }, remote);
  assert.equal(paired.status, 200);
  const headers = { ...remote, Cookie: paired.cookie!.split(';')[0] };
  return { service, command, ownerHeaders, ownerId: owner.data.deviceId, phoneId: paired.data.deviceId, headers, phone: (path: string, value?: unknown) => call(service.phoneHost.localOrigin, path, value, headers) };
}

test('paired phone can read agent approvals and gather/end the canonical boardroom without dispatching work', async t => {
  const f = await pairedWorkflow(t);
  const agents = ['Researcher', 'Maker'].map(name => f.service.store.mutate(f.ownerId, { ...f.command(), kind: 'agent', entityId: 'agent:' + randomUUID(), expectedRevision: 0, payload: { ...blankRecord('agent', 'UTC'), name, position: name } }));
  const room = f.service.store.internalRead<HubLayout>(hubLayoutKey)!.rooms.find(r => r.template === 'boardroom')!;
  const initial = await f.phone('agents/meetings');
  assert.equal(initial.status, 200); assert.deepEqual(initial.data, f.service.hubMeetings.state());
  const approvals = await f.phone('assignments/approvals');
  assert.equal(approvals.status, 200); assert.deepEqual(approvals.data, (await call(f.service.origin, 'assignments/approvals', undefined, f.ownerHeaders)).data);
  const gather = { ...f.command(), type: 'gather', roomId: room.id, title: 'Phone planning', agenda: 'Review the supplied options.', agentIds: agents.map(a => a.id) };
  const meeting = await f.phone('agents/meetings', gather);
  assert.equal(meeting.status, 200); assert.equal(meeting.data.state, 'gathered');
  assert.deepEqual((await f.phone('agents/meetings', gather)).data, meeting.data);
  assert.equal(f.service.hubMeetings.state().current?.id, meeting.data.id);
  const end = { ...f.command(), type: 'end', meetingId: meeting.data.id, expectedRevision: meeting.data.revision };
  assert.equal((await f.phone('agents/meetings', { ...end, expectedRevision: end.expectedRevision + 1 })).data.code, 'meeting_changed');
  assert.equal((await f.phone('agents/meetings', end)).data.state, 'ended');
  assert.equal(f.service.hubMeetings.state().current, null);
  assert.equal(f.service.hubMeetings.state().history.length, 1);
  assert.equal(f.service.assignments.state().attempts.length, 0);
  assert.equal((await f.phone('agents/meetings', { ...gather, ...f.command(), epoch: randomUUID() })).data.code, 'epoch_changed');
  for (const path of ['phone/pairing', 'accounts/configure', 'agent-skills/operation', 'assistant/runtime/start']) assert.equal((await f.phone(path, {})).data.code, 'desktop_required', path);
  await call(f.service.origin, 'phone/revoke', { ...f.command(), deviceId: f.phoneId }, f.ownerHeaders);
  assert.equal((await f.phone('agents/meetings')).status, 401);
  assert.equal((await f.phone('assignments/approvals')).status, 401);
});

test('paired phone mail opening marks only displayed messages read once and retains provider permission checks', async t => {
  const messages = ['shown', 'newer'].map(id => ({ id, threadId: 'thread', labelIds: ['INBOX', 'UNREAD'], internalDate: String(Date.now()), payload: { headers: [{ name: 'Subject', value: 'Phone fixture' }] } }));
  const writes: string[] = [];
  const providers = new Providers((async (raw, init = {}) => {
    const path = new URL(String(raw)).pathname;
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if ((init.method ?? 'GET') === 'GET' && path.endsWith('/threads/thread')) return json({ id: 'thread', messages });
    const match = /\/messages\/([^/]+)(\/modify)?$/.exec(path);
    if (!match) throw new Error('Unexpected fixture provider path');
    const message = messages.find(m => m.id === match[1]); assert(message);
    if ((init.method ?? 'GET') === 'GET') return json(message);
    assert.equal(init.method, 'POST'); assert.equal(match[2], '/modify');
    assert.deepEqual(JSON.parse(String(init.body)), { addLabelIds: [], removeLabelIds: ['UNREAD'] });
    writes.push(message.id); message.labelIds = message.labelIds.filter(label => label !== 'UNREAD');
    return json(message);
  }) as typeof fetch);
  const f = await pairedWorkflow(t, providers), scopes = ['https://www.googleapis.com/auth/gmail.modify'];
  const account: ConnectedAccount = { id: 'google:' + randomUUID().replaceAll('-', ''), generation: randomUUID(), provider: 'google', subject: 'fixture', email: 'phone@example.test', label: 'Phone fixture', revision: 1, state: 'connected', scopes, capabilities: accountCapabilities('google', scopes), connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  f.service.store.internalWrite('accounts:item:' + account.id, account);
  f.service.store.internalWrite('accounts:credential:' + account.id, { generation: account.generation, configuration: { provider: 'google', clientId: 'fixture.apps.googleusercontent.com' }, tokens: { accessToken: 'fixture-only', expiresAt: Date.now() + 3600000, scopes } });
  const displayed = { ...f.command(), target: { provider: 'gmail', accountId: account.id, generation: account.generation, threadId: 'thread' }, messageIds: ['shown'] };
  const result = await f.phone('mail/triage/displayed', displayed);
  assert.equal(result.status, 200); assert.equal(result.data.plan.status, 'completed');
  assert.equal((await f.phone('mail/triage/displayed', displayed)).status, 200);
  assert.deepEqual(writes, ['shown']); assert(messages[1].labelIds.includes('UNREAD'));
  const wrongGeneration = await f.phone('mail/triage/displayed', { ...displayed, ...f.command(), target: { ...displayed.target, generation: randomUUID() } });
  assert.equal(wrongGeneration.status, 409);
  f.service.store.internalWrite('accounts:item:' + account.id, { ...account, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
  const denied = await f.phone('mail/triage/displayed', { ...displayed, ...f.command(), messageIds: ['newer'] });
  assert.equal(denied.status, 403); assert.notEqual(denied.data.code, 'desktop_required');
  assert.deepEqual(writes, ['shown']);
});

test('phone listener cannot bootstrap desktop access; paired writes share canonical records and revocation survives restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-phone-http-'));
  const transport = { reconcile: async () => ({ state: 'ready' as const, origin, message: 'Fixture private route' }), disable: async () => {} };
  let service = await startServer({ directory, port: 0, phonePort: 0, phoneTransport: transport });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = await call(service.origin, 'session', {}), cookie = owner.cookie!.split(';')[0];
  const cmd = () => ({ requestId: randomUUID(), epoch: service.store.epoch });
  assert.equal((await call(service.origin, 'phone/enable', cmd(), { Cookie: cookie })).status, 200);
  const local = service.phoneHost.localOrigin;
  assert.notEqual(local, service.origin);
  assert.equal((await call(local, 'session', {}, { ...remote, Cookie: cookie })).status, 401);
  assert.equal((await call(local, 'session', {}, { Host: new URL(service.origin).host })).status, 403);
  assert.equal((await call(local, 'session', {}, { ...remote, Host: new URL(service.origin).host, 'X-Forwarded-Host': new URL(origin).host })).status, 403);
  assert.equal((await call(local, 'session', {}, { ...remote, 'Tailscale-User-Login': '' })).status, 403);
  assert.equal((await call(local, 'access/context', undefined, remote)).data.requiresPairing, true);
  const challenge = await call(service.origin, 'phone/pairing', cmd(), { Cookie: cookie });
  const pairRequest = { requestId: randomUUID(), code: challenge.data.code, name: 'Fixture phone' };
  const paired = await call(local, 'pair', pairRequest, remote);
  assert.equal(paired.status, 200); assert.match(paired.cookie!, /^__Host-.*; Secure; HttpOnly; SameSite=Strict; Path=\//);
  assert.doesNotMatch(JSON.stringify(paired.data), /token|cookie|code/);
  const phoneCookie = paired.cookie!.split(';')[0], headers = { ...remote, Cookie: phoneCookie };
  assert.equal((await call(local, 'session', {}, headers)).data.deviceId, paired.data.deviceId);
  assert.equal((await call(service.origin, 'snapshot', undefined, { Cookie: phoneCookie })).status, 401);
  for (const path of ['storage/protect', 'phone/enable', 'phone/disable', 'phone/pairing', 'phone/revoke', 'accounts/configure', 'accounts/start', 'assistant/runtime/start', 'assistant/sign-in/start', 'assistant/connection', 'agent-skills/operation', 'future/host/control']) {
    const result = await call(local, path, {}, headers); assert.equal(result.status, 403, path); assert.equal(result.data.code, 'desktop_required', path);
  }
  for (const path of ['storage/state', 'phone/state', 'assistant/sign-in', 'assistant/account', 'assistant/runtime', 'accounts/configuration-receipts/' + randomUUID()]) assert.equal((await call(local, path, undefined, headers)).status, 403, path);
  const taskId = 'task:' + randomUUID();
  const task = { ...cmd(), kind: 'task', entityId: taskId, expectedRevision: 0, payload: { title: 'Shared phone task', notes: '', status: 'open', planned: '', due: '' } };
  const written = await call(local, 'commands', task, headers); assert.equal(written.status, 200, JSON.stringify(written.data));
  assert.equal((await call(service.origin, 'snapshot', undefined, { Cookie: cookie })).data.tasks.find((item: any) => item.id === taskId).value.title, 'Shared phone task');
  const oldPort = local; await service.close();
  await assert.rejects(call(oldPort, 'snapshot', undefined, headers));
  service = await startServer({ directory, port: 0, phonePort: 0, phoneTransport: transport }); await service.phoneHost.reconcile();
  const retry = await call(service.phoneHost.localOrigin, 'pair', pairRequest, remote); assert.equal(retry.cookie, paired.cookie);
  const revoke = { ...cmd(), deviceId: paired.data.deviceId };
  assert.equal((await call(service.origin, 'phone/revoke', revoke, { Cookie: cookie })).status, 200);
  assert.equal((await call(service.phoneHost.localOrigin, 'snapshot', undefined, headers)).data.code, 'phone_pair_required');
  assert.equal((await call(service.phoneHost.localOrigin, 'pair', pairRequest, remote)).status, 401);
  const receipt = await call(service.origin, 'phone/disable', cmd(), { Cookie: cookie }); assert.equal(receipt.data.enabled, false);
  await assert.rejects(call(service.phoneHost.localOrigin, 'snapshot', undefined, headers));
});

test('revocation during a slow request body rejects the command before mutation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-phone-slow-'));
  const service = await startServer({ directory, port: 0, phonePort: 0, phoneTransport: { reconcile: async () => ({ state: 'ready', origin, message: 'fixture' }), disable: async () => {} } });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const cmd = () => ({ requestId: randomUUID(), epoch: service.store.epoch });
  service.phoneAccess.setEnabled('owner', cmd(), true); await service.phoneHost.reconcile();
  const challenge = service.phoneAccess.startPairing('owner', cmd());
  const paired = await call(service.phoneHost.localOrigin, 'pair', { requestId: randomUUID(), code: challenge.code, name: 'Phone' }, remote);
  const entityId = 'task:' + randomUUID();
  const bytes = JSON.stringify({ ...cmd(), kind: 'task', entityId, expectedRevision: 0, payload: { title: 'Must not appear', notes: '', status: 'open', planned: '', due: '' } });
  let req: ReturnType<typeof httpRequest>;
  const done = new Promise<number | undefined>((accept, reject) => {
    req = httpRequest(service.phoneHost.localOrigin + '/api/commands', { method: 'POST', headers: { ...remote, Cookie: paired.cookie!.split(';')[0], 'Content-Type': 'application/json', 'X-Edition3-Client': '1', 'Content-Length': Buffer.byteLength(bytes) } }, res => { res.resume(); res.on('end', () => accept(res.statusCode)); }); req.on('error', reject); req.write(bytes.slice(0, -1));
  });
  await new Promise(accept => setTimeout(accept, 40));
  service.phoneAccess.revoke('owner', { ...cmd(), deviceId: paired.data.deviceId }); req!.end(bytes.slice(-1));
  assert.equal(await done, 401); assert.equal(service.store.readEntity('task', entityId), undefined);
});

test('Serve adapter uses parsed ownership and preserves foreign, foreground and public routes', async () => {
  const target = 'http://127.0.0.1:4385', host = 'phone.example.ts.net', key = host + ':8443';
  const own = { TCP: { '8443': { HTTPS: true } }, Web: { [key]: { Handlers: { '/': { Proxy: target } } } } };
  assert.equal(routeOwnership({}, host, target), 'empty'); assert.equal(routeOwnership(own, host, target), 'owned');
  assert.equal(routeOwnership({ ...own, AllowFunnel: { [key]: true } }, host, target), 'conflict');
  assert.equal(routeOwnership({ Foreground: { other: own } }, host, target), 'conflict');
  assert.equal(routeOwnership({ ...own, Web: { [key]: { Handlers: { '/other': { Proxy: target } } } } }, host, target), 'conflict');
  let config: object = {}, failAfterWrite = true; const calls: string[][] = [];
  const transport = new TailscalePhoneTransport(async args => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: host + '.' } });
    if (args[1] === 'status') return JSON.stringify(config);
    if (args.at(-1) === 'off') { config = {}; return ''; }
    config = own; if (failAfterWrite) { failAfterWrite = false; throw new Error('lost response'); } return '';
  });
  assert.equal((await transport.reconcile(target, true)).state, 'ready');
  assert.deepEqual(calls.find(args => args.includes('--bg')), ['serve', '--yes', '--bg', '--https=8443', target]);
  calls.length = 0; await transport.reconcile(target, true); assert.equal(calls.some(args => args.includes('--bg')), false);
  config = { ...own, AllowFunnel: { [key]: true } }; calls.length = 0;
  assert.equal((await transport.reconcile(target, true)).state, 'error'); await transport.disable(target);
  assert.equal(calls.some(args => args.includes('--bg') || args.includes('off')), false);
  config = own; await transport.disable(target); assert.deepEqual(calls.at(-1), ['serve', '--https=8443', 'off']);
});

test('closing during private-route setup never leaves a listener or admits phones', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-phone-close-')), store = new Store(directory), access = new PhoneAccess(store);
  access.setEnabled('owner', { requestId: randomUUID(), epoch: store.epoch }, true);
  let finish!: () => void;
  const reached = new Promise<void>(accept => { finish = accept; });
  let release!: () => void;
  const host = new PhoneHost(access, (_req, res) => res.end('fixture'), 0, { reconcile: async () => { finish(); await new Promise<void>(accept => { release = accept; }); return { state: 'ready', origin, message: 'fixture' }; }, disable: async () => {} });
  try {
    const setting = host.reconcile(); await reached; const closing = host.close(); release(); await Promise.all([setting, closing]);
    assert.equal(host.origin, undefined); await assert.rejects(call(host.localOrigin, 'snapshot'));
  } finally { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('phone QR opens the verified address without pairing credentials and disappears when disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-phone-qr-')), store = new Store(directory), access = new PhoneAccess(store);
  const command = () => ({ requestId: randomUUID(), epoch: store.epoch });
  access.setEnabled('owner', command(), true);
  const host = new PhoneHost(access, (_req, res) => res.end('fixture'), 0, { reconcile: async () => ({ state: 'ready', origin, message: 'fixture' }), disable: async () => {} });
  try {
    await host.reconcile();
    const qr = host.state().route.qrCodeDataUrl;
    assert.ok(qr); assert.ok(qr.startsWith('data:image/png;base64,'));
    const image = await loadImage(qr), canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height);
    assert.equal(jsQR(new Uint8ClampedArray(pixels.data), image.width, image.height)?.data, origin);
    access.setEnabled('owner', command(), false); await host.reconcile();
    assert.equal(host.state().route.qrCodeDataUrl, undefined); assert.equal(host.origin, undefined);
  } finally { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Tailscale reconnect resumes only a stopped saved network on explicit request', async () => {
  const target = 'http://127.0.0.1:4385', hostname = 'phone.example.ts.net';
  const own = { TCP: { '8443': { HTTPS: true } }, Web: { [hostname + ':8443']: { Handlers: { '/': { Proxy: target } } } } };
  let state = 'Stopped'; const calls: string[][] = [];
  const transport = new TailscalePhoneTransport(async args => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ BackendState: state, Self: { DNSName: hostname + '.' } });
    if (args[0] === 'up') { assert.deepEqual(args, ['up']); state = 'Running'; throw new Error('connection completed but response was lost'); }
    assert.deepEqual(args, ['serve', 'status', '--json']); return JSON.stringify(own);
  });
  assert.equal((await transport.reconcile(target, false)).state, 'unavailable');
  assert.equal(calls.some(args => args[0] === 'up'), false);
  calls.length = 0; assert.equal((await transport.reconcile(target, true)).state, 'ready');
  assert.equal(calls.filter(args => args[0] === 'up').length, 1);
  calls.length = 0; assert.equal((await transport.reconcile(target, true)).state, 'ready');
  assert.equal(calls.some(args => args[0] === 'up'), false);
  state = 'NeedsLogin'; calls.length = 0;
  assert.equal((await transport.reconcile(target, true)).state, 'unavailable');
  assert.equal(calls.some(args => args[0] === 'up'), false);
});
