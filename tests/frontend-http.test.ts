import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AssistantConnection } from '../packages/domain/assistant.js';
import { emptyDraft } from '../packages/domain/contracts.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import { startServer } from '../apps/service/http.js';
import { startWorkspaceHost } from '../apps/service/workspace-host.js';
import { Store } from '../apps/service/store.js';
import { FrontendLease, type FrontendLeaseRecord } from '../apps/service/frontend-lease.js';
import { UpdateSupervisor } from '../apps/service/update-supervisor.js';
import { WorkspaceRecovery } from '../apps/service/workspace-recovery.js';

// NTFS serving uses the production loader's existing Windows semantics. POSIX
// positive tests run as root in CI so no fake reader or privilege flag hides
// protected-ancestor, owner, independent-file or selector checks.
const protectedFixture = { skip: process.platform !== 'win32' && process.getuid?.() !== 0
  ? 'Actual frontend serving requires protected root-owned ancestors; canonical CI runs this file as root.' : false };
const candidateId = 'a'.repeat(64), serviceInputsSha256 = 'b'.repeat(64);
const digest = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');

class DisconnectedTransport implements AssistantTransport {
  calls: string[] = [];
  status(): AssistantConnection { return { state: 'unconfigured', message: 'Offline synthetic HTTP fixture.', methods: [], grantedScopes: [], modelAuthReady: false }; }
  attachmentPolicy() { return {}; }
  models() { return Promise.resolve([]); }
  subscribe() { return () => {}; }
  async request<T>(method: string): Promise<T> { this.calls.push(method); throw Error('No provider request belongs in this fixture.'); }
}

function write(path: string, raw: Buffer | string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, raw, { mode: 0o644 });
}

async function get(origin: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; text: string }>((accept, reject) => {
    // This fixture restarts the selected workspace on the same listening port.
    // Every check must reach the new listener rather than reuse an old socket.
    const request = httpRequest(origin + path, { headers: { Connection: 'close', ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', bytes => chunks.push(bytes));
      response.on('error', reject);
      response.on('end', () => accept({ status: response.statusCode!, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.setTimeout(5000, () => request.destroy(Error('Synthetic HTTP check timed out: ' + path)));
    request.on('error', reject); request.end();
  });
}

async function fixture(t: TestContext) {
  const parent = process.platform === 'win32' ? tmpdir() : process.env.QA_PROTECTED_PARENT ?? '/opt';
  const root = mkdtempSync(join(parent, 'nova-frontend-http-'));
  if (process.platform !== 'win32') chmodSync(root, 0o755);
  const directory = join(root, 'workspace'), bundled = join(root, 'bundled'), frontend = join(root, 'frontend');
  for (const path of [directory, bundled, frontend]) mkdirSync(path, { mode: 0o755 });
  const template = (marker: string) => `<html><head><link rel="stylesheet" href="./assets/style.css"><link rel="icon" href="./icons/app.png"></head><body data-ui="${marker}"><a href="#kept">Keep fragment</a><script type="module" src="./assets/ui.js"></script></body></html>`;
  write(join(bundled, 'index.html'), template('bundled'));
  write(join(bundled, 'assets/ui.js'), 'export const bundled=true;');
  write(join(bundled, 'assets/style.css'), 'body{color:black}');
  write(join(bundled, 'icons/app.png'), 'synthetic-icon');
  const keys = generateKeyPairSync('ed25519'), publicKeyFile = join(root, 'release-public.pem');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  write(publicKeyFile, publicKey);
  const options = { directory: frontend, publicKeyFile, publicKeySha256: digest(publicKey), candidateId,
    serviceInputsSha256, apiVersion: 1 as const, schemaVersion: 55, version: '2.3.0', buildVersion: '1.0.287' };
  const gateway = new DisconnectedTransport();
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ directory, port: 0, clientDirectory: bundled, frontendDelivery: options,
      candidateId, version: options.version, buildVersion: options.buildVersion, schemaVersion: 55, gateway });
  } catch (error) {
    rmSync(root, { recursive: true, force: true }); throw error;
  }
  const additionalClose: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of additionalClose) await close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const install = (marker: string, sequence: number) => {
    const files = new Map<string, string>([
      ['.vite/manifest.json', '{}'], ['index.html', template(marker)], ['assets/ui.js', `export const selected=${JSON.stringify(marker)};`],
      ['assets/lazy.js', `export const lazy=${JSON.stringify(marker)};`], ['assets/style.css', `body{--selected:${marker}}`],
      ['icons/app.png', 'synthetic-icon'], ['icons/provenance.json', '{"internalFixture":true}'],
    ]);
    const inventory = [...files].map(([path, raw]) => ({ path, bytes: Buffer.byteLength(raw), sha256: digest(raw) })).sort((a, b) => a.path < b.path ? -1 : 1);
    const frontendId = digest(JSON.stringify(inventory));
    const createdAt = new Date(Date.now() - 1000).toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString();
    const manifest = { format: 1, kind: 'frontend', channel: 'frontend-stable', sequence, createdAt, expiresAt,
      frontendId, frontendVersion: `2.3.${sequence}`, frontendBuildVersion: `1.0.${287 + sequence}`, sourceRevision: 'c'.repeat(40),
      base: { candidateId, serviceInputsSha256, apiVersion: 1, schemaVersion: 55 },
      artifact: { url: 'https://example.invalid/frontend.tgz', bytes: 512, sha256: 'd'.repeat(64) }, files: inventory };
    const raw = Buffer.from(JSON.stringify(manifest) + '\n'), signature = sign(null, raw, keys.privateKey);
    const manifestSha256 = digest(raw), release = join(frontend, 'releases', frontendId);
    for (const [path, bytes] of files) write(join(release, path), bytes);
    write(join(release, '.frontend-manifest.json'), raw); write(join(release, '.frontend-manifest.sig'), signature);
    const manifestPath = join(frontend, 'manifests', manifestSha256 + '.json'), signaturePath = join(frontend, 'manifests', manifestSha256 + '.sig');
    write(manifestPath, raw); write(signaturePath, signature);
    const selector = { format: 1, frontendId, manifestSha256, manifestPath, signaturePath, operationId: randomUUID() };
    const selectorBytes = Buffer.from(JSON.stringify(selector) + '\n');
    const select = () => {
      const temporary = join(frontend, '.select-' + randomUUID());
      write(temporary, selectorBytes); renameSync(temporary, join(frontend, 'selector.json'));
    };
    return { frontendId, manifest, raw, selectorBytes, release, signaturePath, select };
  };
  const device = server.store.session().deviceId, requestId = randomUUID(), draftId = `draft:${device}`;
  const command = { requestId, epoch: server.store.epoch, kind: 'draft' as const, entityId: draftId, expectedRevision: 0,
    payload: { ...emptyDraft, title: 'Synthetic retained draft', text: 'Unsent writing — café', attachments: [] } };
  const draft = server.store.mutate(device, command);
  const savedRequest = { id: randomUUID(), requestId: randomUUID(), state: 'unknown', input: 'An uncertain original request must remain saved.', text: 'Original partial answer', createdAt: new Date().toISOString() };
  server.store.internalWrite('frontend-http:retained-request', savedRequest);
  const preserved = () => {
    assert.equal(server.store.epoch, command.epoch);
    assert.deepEqual(server.store.readEntity('draft', draftId), draft);
    assert.deepEqual(server.store.internalRead('frontend-http:retained-request'), savedRequest);
    assert.deepEqual(server.store.mutate(device, command), draft, 'same saved request receipt returns the same result');
    assert.equal(gateway.calls.length, 0, 'no provider effect was dispatched');
  };
  return { root, server, frontend, bundled, install, preserved, options, gateway, onClose: (close: () => Promise<void>) => additionalClose.push(close) };
}

test('selected recovered workspace serves signed frontend and refuses workspace switching during the root lease', protectedFixture, async t => {
  const f = await fixture(t), ui = f.install('recovered', 1); ui.select();
  const snapshot = f.server.store.captureBackup('2.3.0', { status: 'not-configured', notes: [] });
  const sourceDirectory = f.server.store.directory; await f.server.close();
  const recoveryId = randomUUID(), selectedDirectory = join(sourceDirectory, 'recovered-workspaces', recoveryId);
  const copy = Store.restoreBackup(selectedDirectory, snapshot); copy.activateRecoveredLocal();
  const recovery = new WorkspaceRecovery(copy); recovery.resume('fixture-owner', { requestId: randomUUID(), epoch: copy.epoch, fingerprint: recovery.review().fingerprint, confirmNewConnections: true }); copy.close();
  write(join(selectedDirectory, 'recovery-complete.json'), JSON.stringify({ jobId: recoveryId, sourceHash: 'c'.repeat(64) }));
  write(join(sourceDirectory, 'workspace-selection.json'), JSON.stringify({ format: 1, recoveryId }));
  let saved: FrontendLeaseRecord | undefined;
  const records = new Map<string, FrontendLeaseRecord>();
  let supervisor!: UpdateSupervisor;
  const lease = new FrontendLease({ read: () => saved, find: id => records.get(id), save: value => { saved = value; records.set(value.operationId, value); } },
    () => ({ candidateId, serviceInputsSha256, apiVersion: 1, schemaVersion: 55 }), () => supervisor.assertFrontendAdmission());
  supervisor = new UpdateSupervisor({ status: () => ({ availability: 'current' as const }), check: async () => ({ availability: 'current' as const }), verifiedRelease: () => undefined },
    { current: () => undefined, find: () => undefined, save: () => { throw Error('No full installation belongs in this fixture.'); } },
    { prepare: async () => {}, preflight: async () => {}, run: async () => 'unchanged' as const, reconcile: async () => undefined }, () => candidateId, Date.now, undefined, lease);
  let failTransport = false;
  const updateHostClient = { async call<T>(action: string, value?: unknown): Promise<T> {
    if (failTransport) throw Error('Synthetic controller unavailable.');
    return (action === 'heartbeat' ? supervisor.beat(value as import('../apps/service/update-host-client.js').UpdateHeartbeat) : supervisor.view()) as T;
  } };
  let host = await startWorkspaceHost({ directory: sourceDirectory, port: 0, clientDirectory: f.bundled, frontendDelivery: f.options,
    candidateId, version: '2.3.0', buildVersion: '1.0.287', schemaVersion: 55, gateway: f.gateway, updateHostClient });
  f.onClose(async () => { await host.close(); supervisor.stop(); });
  await host.current.refreshWorkspaceUpdates();
  const epoch = host.current.store.epoch, before = JSON.parse((await get(host.origin, '/api/health')).text);
  const savedDraft = snapshot.entities.find(item => item.kind === 'draft')!;
  assert.deepEqual(host.current.store.readEntity('draft', savedDraft.id)?.value, savedDraft.value);
  assert.equal(host.current.store.directory, selectedDirectory); assert.equal(before.frontend.id, ui.frontendId);
  assert.equal(before.serviceInputsSha256, serviceInputsSha256); assert.equal(before.candidateId, candidateId);
  assert.match((await get(host.origin, '/')).text, /data-ui="recovered"/);
  assert.equal((await get(host.origin, `/__frontend/${ui.frontendId}/assets/lazy.js`)).status, 200);
  const input = { operationId: randomUUID(), baseCandidateId: candidateId, serviceInputsSha256, workspaceEpoch: epoch };
  lease.begin(input);
  const selectorBytes = readFileSync(join(sourceDirectory, 'workspace-selection.json'));
  await assert.rejects(host.current.prepareWorkspaceSwitch(), /Finish the current interface/);
  // Test the owning host reservation, rather than only the app-side helper.
  const session = host.current.store.session(), command = { requestId: randomUUID(), epoch };
  const response = await new Promise<{ status: number; code: string }>((accept, reject) => {
    const request = httpRequest(host.origin + '/api/storage/backups/return', { method: 'POST', headers: { Cookie: `${host.current.store.internalRead<string>('http:session-cookie')}=${session.token}`,
      'X-Edition3-Client': '1', 'X-Edition3-Candidate': candidateId, 'Content-Type': 'application/json', Connection: 'close' } }, result => { const parts: Buffer[] = []; result.on('data', part => parts.push(part)); result.on('end', () => accept({ status: result.statusCode!, code: JSON.parse(Buffer.concat(parts).toString()).code })); });
    request.on('error', reject); request.end(JSON.stringify(command));
  });
  assert.equal(response.status, 409); assert.equal(response.code, 'recovery_update_busy'); await host.waitForSwitch();
  assert.equal(host.current.store.epoch, epoch); assert.deepEqual(readFileSync(join(sourceDirectory, 'workspace-selection.json')), selectorBytes);
  assert.equal(JSON.parse((await get(host.origin, '/api/health')).text).processIdentity, before.processIdentity);
  // Clear the structural refusal observation only after the host reservation.
  await host.current.refreshWorkspaceUpdates(); lease.end({ operationId: input.operationId, leaseId: input.operationId });
  failTransport = true; await assert.rejects(host.current.prepareWorkspaceSwitch(), /reconnect/); failTransport = false;
  await host.current.refreshWorkspaceUpdates();
  const origin = host.origin; await host.close();
  host = await startWorkspaceHost({ directory: sourceDirectory, port: Number(new URL(origin).port), clientDirectory: f.bundled, frontendDelivery: f.options,
    candidateId, version: '2.3.0', buildVersion: '1.0.287', schemaVersion: 55, gateway: f.gateway, updateHostClient });
  assert.equal(host.current.store.directory, selectedDirectory); assert.equal(host.current.store.epoch, epoch);
  assert.deepEqual(host.current.store.readEntity('draft', savedDraft.id)?.value, savedDraft.value);
  assert.equal(JSON.parse((await get(host.origin, '/api/health')).text).frontend.id, ui.frontendId);
  let sessionEpoch: string | undefined, sessionToken: string | undefined;
  const postReturn = (input: unknown) => new Promise<number>((accept, reject) => {
    if (sessionEpoch !== host.current.store.epoch) { sessionEpoch = host.current.store.epoch; sessionToken = host.current.store.session().token; }
    const request = httpRequest(host.origin + '/api/storage/backups/return', { method: 'POST', headers: { Cookie: `${host.current.store.internalRead<string>('http:session-cookie')}=${sessionToken}`,
      'X-Edition3-Client': '1', 'X-Edition3-Candidate': candidateId, 'Content-Type': 'application/json', Connection: 'close' } }, response => { const parts: Buffer[] = []; response.on('data', part => parts.push(part)); response.on('end', () => { if (response.statusCode === 409 && (input as { epoch: string }).epoch === host.current.store.epoch) reject(Error(Buffer.concat(parts).toString())); else accept(response.statusCode!); }); });
    request.on('error', reject); request.end(JSON.stringify(input));
  });
  const recoveredProcess = JSON.parse((await get(host.origin, '/api/health')).text).processIdentity;
  assert.equal(await postReturn({ requestId: randomUUID(), epoch: randomUUID() }), 409); await host.waitForSwitch();
  assert.equal(host.current.store.directory, selectedDirectory);
  assert.equal(JSON.parse((await get(host.origin, '/api/health')).text).processIdentity, recoveredProcess);
  assert.equal(await postReturn({ requestId: randomUUID(), epoch }), 202); await host.waitForSwitch();
  await host.current.refreshWorkspaceUpdates();
  assert.equal(host.current.store.directory, sourceDirectory); assert.notEqual(host.current.store.epoch, epoch);
  assert.equal(JSON.parse((await get(host.origin, '/api/health')).text).frontend.id, ui.frontendId);
  assert.throws(() => lease.begin({ ...input, operationId: randomUUID() }), /fresh matching/);
  const returnedProcess = JSON.parse((await get(host.origin, '/api/health')).text).processIdentity;
  // A no-op return still admits its request but does not restart the service.
  const noOp = { requestId: randomUUID(), epoch: host.current.store.epoch };
  assert.equal(await postReturn(noOp), 202); await host.waitForSwitch();
  assert.equal(await postReturn(noOp), 202); await host.waitForSwitch();
  assert.equal(JSON.parse((await get(host.origin, '/api/health')).text).processIdentity, returnedProcess);
  assert.equal(f.gateway.calls.length, 0);
});

test('actual HTTP switches signed documents and preserves old lazy assets, saved data and running service across rollback', protectedFixture, async t => {
  const f = await fixture(t), origin = f.server.origin;
  const health = JSON.parse((await get(origin, '/api/health')).text), epoch = JSON.parse((await get(origin, '/api/access/context')).text).workspaceEpoch;
  const bundled = await get(origin, '/'); assert.equal(bundled.status, 200); assert.match(bundled.text, /data-ui="bundled"/);
  const old = f.install('old', 1); old.select();
  const first = await get(origin, '/'); assert.equal(first.status, 200);
  assert.ok(first.text.includes(`name="e3-assets" content="/__frontend/${old.frontendId}/"`));
  assert.ok(first.text.includes(`name="e3-candidate" content="${candidateId}"`));
  assert.ok(first.text.includes(`name="e3-frontend" content="${old.frontendId}"`));
  assert.ok(first.text.includes(`src="/__frontend/${old.frontendId}/assets/ui.js"`));
  assert.ok(first.text.includes(`href="/__frontend/${old.frontendId}/assets/style.css"`));
  assert.ok(first.text.includes(`href="/__frontend/${old.frontendId}/icons/app.png"`));
  assert.ok(first.text.includes('href="#kept"')); assert.equal(/<base\b/i.test(first.text), false);
  assert.match(String(first.headers['content-security-policy']), /base-uri 'none'/);
  assert.equal(first.headers['cache-control'], 'no-cache');
  const current = f.install('new', 2); current.select();
  const second = await get(origin, '/assistant'); assert.equal(second.status, 200); assert.match(second.text, /data-ui="new"/);
  const staleLazy = await get(origin, `/__frontend/${old.frontendId}/assets/lazy.js`);
  assert.equal(staleLazy.status, 200); assert.match(staleLazy.text, /"old"/); assert.match(String(staleLazy.headers['cache-control']), /immutable/);
  assert.match((await get(origin, `/__frontend/${current.frontendId}/assets/lazy.js`)).text, /"new"/);
  let latest = JSON.parse((await get(origin, '/api/health')).text);
  assert.equal(latest.candidateId, health.candidateId); assert.equal(latest.version, health.version); assert.equal(latest.buildVersion, health.buildVersion);
  assert.equal(latest.processIdentity, health.processIdentity); assert.equal(latest.frontend.id, current.frontendId);
  assert.equal(JSON.parse((await get(origin, '/api/access/context')).text).workspaceEpoch, epoch); f.preserved();
  old.select();
  const restored = await get(origin, '/'); assert.equal(restored.status, 200); assert.match(restored.text, /data-ui="old"/);
  assert.match((await get(origin, `/__frontend/${current.frontendId}/assets/lazy.js`)).text, /"new"/);
  latest = JSON.parse((await get(origin, '/api/health')).text);
  assert.equal(latest.processIdentity, health.processIdentity); assert.equal(latest.frontend.id, old.frontendId);
  assert.deepEqual(readFileSync(join(f.frontend, 'selector.json')), old.selectorBytes);
  assert.ok(existsSync(current.release)); f.preserved();
});

test('actual HTTP fences raw namespace documents, encoded paths, internal metadata, origin and unknown releases', protectedFixture, async t => {
  const f = await fixture(t), origin = f.server.origin, ui = f.install('guarded', 1); ui.select();
  for (const suffix of ['index.html', '%69ndex.html', 'other.html', '.frontend-manifest.json', '.vite/manifest.json', 'icons/provenance.json', '%2e%2e%2frelease-public.pem', 'assets/missing.js']) {
    const response = await get(origin, `/__frontend/${ui.frontendId}/${suffix}`);
    assert.equal(response.status, 404, suffix); assert.equal(response.text.includes('<head>'), false, suffix);
  }
  assert.equal((await get(origin, `/__frontend/${'f'.repeat(64)}/assets/ui.js`)).status, 404);
  assert.equal((await get(origin, `/__bundled/${'f'.repeat(64)}/assets/ui.js`)).status, 404);
  const foreignHeaders: Array<Record<string, string>> = [{ Host: 'foreign.example' }, { Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
  for (const headers of foreignHeaders) {
    assert.equal((await get(origin, '/', headers)).status, 403);
    assert.equal((await get(origin, `/__frontend/${ui.frontendId}/assets/ui.js`, headers)).status, 403);
  }
  f.preserved();
});

test('actual HTTP reports invalid selection and safely serves bundled document without changing backend or saved data', protectedFixture, async t => {
  const f = await fixture(t), origin = f.server.origin, ui = f.install('invalidated', 1); ui.select();
  const before = JSON.parse((await get(origin, '/api/health')).text);
  writeFileSync(ui.signaturePath, Buffer.alloc(64), { mode: 0o644 });
  const health = JSON.parse((await get(origin, '/api/health')).text);
  assert.equal(health.status, 'ready'); assert.equal(health.processIdentity, before.processIdentity);
  assert.equal(health.candidateId, candidateId); assert.equal(health.frontend.source, 'bundled'); assert.equal(health.frontend.blocked, true);
  const fallback = await get(origin, '/'); assert.equal(fallback.status, 200); assert.match(fallback.text, /data-ui="bundled"/);
  assert.ok(fallback.text.includes(`name="e3-assets" content="/__bundled/${candidateId}/"`)); f.preserved();
});
