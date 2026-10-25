import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit post-build local integration, not a hosted/native-runtime qualification.
// Run: node --test --test-concurrency=1 tests/local-retained-startup.integration.mjs
// All data is synthetic. Failed and successful fixtures remain owned QA evidence.
const root = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sorted = rows => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const native = { status: 'not-configured', notes: ['Synthetic local qualification; no native account or provider.'] };
function portable(snapshot) {
  // These two fields identify each capture, not retained workspace state.
  const { id, createdAt, ...state } = snapshot;
  assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(new Date(createdAt).toISOString(), createdAt);
  return state;
}
function exactly(actual, expected, label) { assert.deepEqual(portable(actual), portable(expected), label); }
function timestamp(value, first, last) {
  assert.equal(new Date(value).toISOString(), value);
  assert(Date.parse(value) >= first && Date.parse(value) <= last, 'Observed transition time is inside its actual request interval');
}

test('Compiled local workspace retains all portable state through real backup, restoration, restart and return', { timeout: 180000 }, async t => {
  assert.equal(process.env.E3_SERVER_KEY_FILE, undefined, 'Run without an external server-key path; never read user key material');
  const candidate = readJson(join(root, 'dist/candidate.json'));
  const release = readJson(join(root, 'release.json'));
  assert.equal(candidate.version, '2.28.8'); assert.equal(candidate.buildVersion, '1.0.381'); assert.equal(candidate.schemaVersion, 60);
  for (const key of ['version', 'buildVersion', 'schemaVersion']) assert.equal(release[key], candidate[key]);
  const modules = ['apps/service/workspace-host.js', 'apps/service/http.js', 'apps/service/store.js', 'apps/service/workspace-backups.js', 'apps/service/backup-crypto.js', 'packages/domain/contracts.js'];
  const bindings = Object.fromEntries(modules.map(name => [name, digest(readFileSync(join(root, 'dist/service', name)))]));
  const compiled = name => new URL('../dist/service/' + name, import.meta.url).href;
  const [{ startWorkspaceHost }, { startServer }, { Store }, { decryptBackup }, { canonical }] = await Promise.all([
    import(compiled(modules[0])), import(compiled(modules[1])), import(compiled(modules[2])), import(compiled(modules[4])), import(compiled(modules[5])),
  ]);
  const operation = randomUUID(), evidence = join(root, '.tmp-qa/local-retained-startup', operation);
  mkdirSync(evidence, { recursive: true });
  // Keep actual SQLite families below the native Windows WAL pathname limit;
  // the source checkout and evidence folder may be much deeper than app data.
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nova-retained-'));
  const directory = join(workspaceRoot, 'original');
  assert(join(directory, 'recovered-workspaces', '.staging-' + operation, 'workspace.sqlite-wal').length < 240,
    'The synthetic recovery family needs a short ordinary temporary root');
  const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const originalFetch = globalThis.fetch, origins = new Set(), externalRequests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !origins.has(url.origin)) {
      externalRequests.push(url.origin); throw new Error('External request refused by synthetic local integration');
    }
    return originalFetch(input, init);
  };
  let host, preview, pendingStart, passed = false, primaryFailure;
  const stages = [], owners = [], shutdown = [];
  const options = { directory, port: 0, version: candidate.version, buildVersion: candidate.buildVersion, schemaVersion: candidate.schemaVersion };
  const capture = store => store.captureBackup(candidate.version, native);
  const noEffects = service => {
    assert.equal(service.store.internalRead('runtime:configuration'), undefined);
    assert.equal(service.store.internalRead('gateway:configuration'), undefined);
    assert.equal(service.gateway.status().state, 'unconfigured');
    assert.equal(service.runtime?.status().state, 'stopped');
    assert.equal(service.phoneAccess.enabled, false);
    assert.deepEqual(service.store.updateEffectsInFlight(), {});
    assert.deepEqual(externalRequests, []);
  };
  const startHost = async () => {
    pendingStart = startWorkspaceHost(options);
    try { host = await pendingStart; owners.push(host.current); origins.add(host.origin); noEffects(host.current); }
    finally { pendingStart = undefined; }
  };
  const closeHost = async () => {
    const current = host.current; await host.close(); assert.equal(current.drainStatus().closed, true);
    shutdown.push({ origin: current.origin, closed: true }); host = undefined;
  };
  const request = async (service, path, { cookie, body, raw, expected = 200, headers = {}, method } = {}) => {
    const response = await fetch(service.origin + '/api/' + path, {
      method: method ?? (body !== undefined || raw !== undefined ? 'POST' : 'GET'),
      headers: { Connection: 'close', 'X-Edition3-Client': '1', ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, expected, path + ': ' + (response.status === expected ? '' : await response.text()));
    return response;
  };
  const login = async service => {
    const response = await request(service, 'session', { method: 'POST' });
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
    const { deviceId } = await response.json(); assert.match(deviceId, /^[a-f0-9-]{36}$/);
    return { cookie, deviceId, token: cookie.slice(cookie.indexOf('=') + 1) };
  };
  const settledJob = async (service, cookie, id) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const { jobs } = await (await request(service, 'storage/backups', { cookie })).json();
      const job = jobs.find(value => value.id === id); assert(job, 'The original accepted job remains observable');
      if (job.state !== 'working') { assert.equal(job.state, 'ready', JSON.stringify(job)); return job; }
      await pause(40);
    }
    throw new Error('Original backup job did not settle within45s; do not resubmit it');
  };
  const assertFence = async (service, session) => {
    assert.throws(() => service.store.authenticate(session.token), /Reconnect/);
    await request(service, 'snapshot', { cookie: session.cookie, expected: 401 });
  };
  try {
    await startHost();
    const owner = await login(host.current), store = host.current.store;
    // Maintained Store commands create real entity history, request receipts and blob references.
    const command = payload => ({ requestId: randomUUID(), epoch: store.epoch, kind: 'task', entityId: 'task:retained-local-proof', expectedRevision: payload.status === 'done' ? 1 : 0, payload });
    const taskValue = { title: 'Synthetic retained task', notes: 'Exact writing — العربية 🌱\nsecond line', status: 'open', planned: '', due: '' };
    const first = command(taskValue); store.mutate(owner.deviceId, first);
    store.mutate(owner.deviceId, command({ ...taskValue, status: 'done' }));
    const file = store.upload(owner.deviceId, randomUUID(), store.epoch, 'retained-proof.txt', Buffer.from('Synthetic file\nالعربية 🌱\u0000end').toString('base64'));
    store.mutate(owner.deviceId, { requestId: randomUUID(), epoch: store.epoch, kind: 'project', entityId: 'project:retained-local-proof', expectedRevision: 0,
      payload: { name: 'Synthetic Retained Work', purpose: 'Keep the exact project/file relationship', attachments: [file] } });
    store.internalWrite('qa:retained:opaque', { futureField: ['must survive', { n: 42, text: '未知字段' }], synthetic: true });
    store.internalWrite('phone:access', { enabled: false });
    noEffects(host.current);
    const baseline = capture(store), originalEpoch = store.epoch;
    assert(baseline.entities.length >= 3 && baseline.history.length >= 4 && baseline.receipts.length >= 4);
    assert.equal(baseline.files.length, 1); assert.equal(baseline.references.length, 1);
    save('original-retained-baseline.json', baseline);
    const originalKey = readFileSync(join(directory, 'preview.key'));
    const originalBlob = readFileSync(join(directory, 'blobs', file.id));
    await closeHost();
    await startHost();
    assert.equal(host.current.store.authenticate(owner.token), owner.deviceId);
    exactly(capture(host.current.store), baseline, 'All portable families survive the actual retained first start');
    await request(host.current, 'snapshot', { cookie: owner.cookie });
    exactly(capture(host.current.store), baseline, 'Snapshot read preserves retained state');
    stages.push('retained-first-start');

    const passphrase = 'Synthetic standalone backup passphrase 2026';
    const create = { requestId: randomUUID(), epoch: originalEpoch, passphrase }, exportBegan = Date.now();
    await request(host.current, 'storage/backups/create', { cookie: owner.cookie, body: create, expected: 202 });
    const created = await settledJob(host.current, owner.cookie, create.requestId);
    const archive = Buffer.from(await (await request(host.current, 'storage/backups/' + created.id + '/download', { cookie: owner.cookie })).arrayBuffer());
    assert.equal(digest(archive), created.sha256); assert.equal(archive.length, created.bytes);
    assert(!archive.includes(originalKey)); assert(!archive.includes(Buffer.from(taskValue.notes)));
    const archived = await decryptBackup(archive, passphrase);
    assert.deepEqual(archived.native, { status: 'not-configured', notes: ['No managed Assistant workspace is configured.'] });
    assert.equal(archived.schema, 60); assert.equal(archived.epoch, originalEpoch);
    const beforeExport = portable(baseline), exported = portable(archived);
    // Export itself adds exactly its admitted request receipt; native notes describe its capture route.
    const exportReceipt = archived.receipts.find(row => row.requestId === create.requestId);
    assert(exportReceipt); assert.equal(exportReceipt.deviceId, owner.deviceId);
    assert.equal(exportReceipt.digest, digest(canonical({ ...create, passphrase: digest(passphrase), type: 'backup.export' })));
    timestamp(exportReceipt.value.createdAt, exportBegan, Date.now());
    assert.deepEqual(exportReceipt.value, { id: create.requestId, deviceId: owner.deviceId, epoch: originalEpoch,
      kind: 'export', state: 'working', createdAt: exportReceipt.value.createdAt });
    assert.deepEqual({ ...exported, receipts: exported.receipts.filter(row => row.requestId !== create.requestId), native: beforeExport.native }, beforeExport);
    save('decrypted-actual-export.json', archived);
    const upload = await (await request(host.current, 'storage/backups/upload', { cookie: owner.cookie, raw: archive,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Edition3-Epoch': originalEpoch } })).json();
    const inspect = { requestId: randomUUID(), epoch: originalEpoch, passphrase, uploadId: upload.uploadId };
    await request(host.current, 'storage/backups/inspect', { cookie: owner.cookie, body: inspect, expected: 202 });
    const reviewed = await settledJob(host.current, owner.cookie, inspect.requestId);
    assert.deepEqual(reviewed.summary, created.summary);
    const restore = { ...inspect, requestId: randomUUID(), reviewId: inspect.requestId }, restoreBegan = Date.now();
    await request(host.current, 'storage/backups/restore', { cookie: owner.cookie, body: restore, expected: 202 });
    const restoredJob = await settledJob(host.current, owner.cookie, restore.requestId), restoreEnded = Date.now();
    assert.deepEqual(restoredJob.summary, created.summary);
    const recoveredDirectory = join(directory, 'recovered-workspaces', restore.requestId);
    const marker = readJson(join(recoveredDirectory, 'recovery-complete.json'));
    assert.equal(marker.jobId, restore.requestId); assert.equal(marker.sourceHash, digest(archive)); assert.deepEqual(marker.summary, created.summary);
    assert(!existsSync(join(directory, 'recovered-workspaces', '.staging-' + restore.requestId)));
    let recovered;
    try {
      recovered = new Store(recoveredDirectory);
      assert.notEqual(recovered.epoch, originalEpoch); assert.equal(recovered.recoveryHeld, true);
      assert.throws(() => recovered.authenticate(owner.token), /Reconnect/);
      const actual = recovered.captureBackup(candidate.version, archived.native), state = actual.services.find(row => row.id === 'recovery:state');
      assert(state); assert.equal(state.revision, 1); timestamp(state.value.recoveredAt, restoreBegan, restoreEnded);
      assert.deepEqual(state.value, { held: true, backupId: archived.id, sourceEpoch: originalEpoch, recoveredAt: state.value.recoveredAt, native: 'not-configured' });
      const oldPhone = archived.services.find(row => row.id === 'phone:access'); assert(oldPhone);
      const expected = { ...archived, epoch: recovered.epoch, services: sorted([
        ...archived.services.filter(row => !['http:session-cookie', 'phone:access'].includes(row.id)),
        state, { id: 'phone:access', revision: oldPhone.revision + 1, value: { enabled: false } },
        { id: 'recovery:retained-archives', revision: 1, value: [] },
      ]) };
      exactly(actual, expected, 'All restored portable rows match the archive with explicit recovery transforms only');
      assert.notDeepEqual(readFileSync(join(recoveredDirectory, 'preview.key')), originalKey);
      assert.notDeepEqual(readFileSync(join(recoveredDirectory, 'blobs', file.id)), originalBlob);
      assert.deepEqual(recovered.download(file.id), host.current.store.download(file.id));
      save('restored-before-service.json', actual);
    } finally { recovered?.close(); recovered = undefined; }
    stages.push('actual-export-upload-inspect-restore');

    pendingStart = startServer({ ...options, directory: recoveredDirectory, recoveryPreview: true });
    preview = await pendingStart; pendingStart = undefined; owners.push(preview); origins.add(preview.origin); noEffects(preview);
    await assertFence(preview, owner);
    const previewSession = await login(preview), previewSnapshot = preview.store.captureBackup(candidate.version, archived.native);
    const expectedPreview = readJson(join(evidence, 'restored-before-service.json'));
    const newCookie = previewSnapshot.services.find(row => row.id === 'http:session-cookie');
    assert(newCookie); assert.equal(newCookie.revision, 1); assert.match(newCookie.value, /^e3_session_[a-f0-9]{32}$/);
    assert.notEqual(newCookie.value, baseline.services.find(row => row.id === 'http:session-cookie').value);
    expectedPreview.services = sorted([...expectedPreview.services, newCookie]);
    exactly(previewSnapshot, expectedPreview, 'Held service startup adds only a newly scoped local cookie');
    await request(preview, 'commands', { cookie: previewSession.cookie, body: first, expected: 409 });
    exactly(preview.store.captureBackup(candidate.version, archived.native), expectedPreview, 'Held command refusal has no retained mutation');
    await preview.close(); assert.equal(preview.drainStatus().closed, true); shutdown.push({ origin: preview.origin, closed: true }); preview = undefined;

    const originalBeforeActivation = capture(host.current.store);
    const expectedJobs = [created, reviewed, restoredJob].sort((a, b) => a.id < b.id ? -1 : 1);
    const jobsBeforeSwitch = (await (await request(host.current, 'storage/backups', { cookie: owner.cookie })).json()).jobs;
    assert.deepEqual(sorted(jobsBeforeSwitch), expectedJobs, 'All three original operations have durable ready acknowledgements');
    const activate = { requestId: randomUUID(), epoch: originalEpoch, recoveryId: restore.requestId }, activationBegan = Date.now();
    await request(host.current, 'storage/backups/activate', { cookie: owner.cookie, body: activate, expected: 202 });
    await host.waitForSwitch(); owners.push(host.current); noEffects(host.current);
    assert.deepEqual(host.status(), { active: true, switching: false });
    const active = host.current.store.captureBackup(candidate.version, archived.native), activeState = active.services.find(row => row.id === 'recovery:state');
    timestamp(activeState.value.activatedAt, activationBegan, Date.now());
    const heldState = expectedPreview.services.find(row => row.id === 'recovery:state');
    assert.deepEqual(activeState, { id: heldState.id, revision: heldState.revision + 1,
      value: { ...heldState.value, held: false, effectsPaused: true, activatedAt: activeState.value.activatedAt } });
    const expectedActive = { ...expectedPreview, services: sorted(expectedPreview.services.map(row => row.id === activeState.id ? activeState : row)) };
    exactly(active, expectedActive, 'Activation preserves all rows except the exact recovery-state transition');
    await assertFence(host.current, owner);
    assert.equal(host.current.store.authenticate(previewSession.token), previewSession.deviceId);
    await request(host.current, 'snapshot', { cookie: previewSession.cookie });
    await request(host.current, 'assistant/runtime/start', { cookie: previewSession.cookie, body: {}, expected: 409 });
    exactly(host.current.store.captureBackup(candidate.version, archived.native), expectedActive, 'Paused native-start refusal does not alter saved state');
    save('activated-retained-baseline.json', active);
    await closeHost(); await startHost();
    assert.equal(host.current.store.epoch, active.epoch); assert.equal(host.current.store.recoveryEffectsPaused, true);
    exactly(host.current.store.captureBackup(candidate.version, archived.native), expectedActive, 'Recovered selection and all saved state survive a real service restart');
    assert.equal(host.current.store.authenticate(previewSession.token), previewSession.deviceId);
    stages.push('held-preview-activation-and-recovered-restart');

    const returning = { requestId: randomUUID(), epoch: active.epoch };
    await request(host.current, 'storage/backups/return', { cookie: previewSession.cookie, body: returning, expected: 202 });
    await host.waitForSwitch(); owners.push(host.current); noEffects(host.current);
    assert.deepEqual(host.status(), { active: false, switching: false }); assert.equal(host.current.store.epoch, originalEpoch);
    assert.equal(host.current.store.authenticate(owner.token), owner.deviceId);
    const expectedOriginal = structuredClone(originalBeforeActivation);
    expectedOriginal.receipts.push({ requestId: activate.requestId, digest: digest(canonical({ ...activate, type: 'recovery.activate' })), deviceId: owner.deviceId, value: { accepted: true } });
    expectedOriginal.receipts.sort((a, b) => a.requestId < b.requestId ? -1 : 1);
    exactly(capture(host.current.store), expectedOriginal, 'Return reopens the unchanged original plus its exact activation receipt');
    const returnedJobs = (await (await request(host.current, 'storage/backups', { cookie: owner.cookie })).json()).jobs;
    assert.deepEqual(sorted(returnedJobs), expectedJobs, 'Export, inspection and restore acknowledgements survive restart and return');
    assert.deepEqual(readFileSync(join(directory, 'preview.key')), originalKey);
    assert.deepEqual(readFileSync(join(directory, 'blobs', file.id)), originalBlob);
    assert(!existsSync(join(directory, 'workspace-selection.json')));
    try {
      recovered = new Store(recoveredDirectory);
      const expectedReturned = structuredClone(expectedActive);
      expectedReturned.receipts.push({ requestId: returning.requestId, digest: digest(canonical({ ...returning, type: 'recovery.return' })), deviceId: previewSession.deviceId, value: { accepted: true } });
      expectedReturned.receipts.sort((a, b) => a.requestId < b.requestId ? -1 : 1);
      exactly(recovered.captureBackup(candidate.version, archived.native), expectedReturned, 'The separate recovered copy keeps all state and its own return receipt');
      save('recovered-after-return.json', recovered.captureBackup(candidate.version, archived.native));
    } finally { recovered?.close(); recovered = undefined; }
    save('original-after-return.json', capture(host.current.store)); stages.push('original-return-and-separate-copy-preserved');
    await closeHost(); assert.deepEqual(externalRequests, []); passed = true;
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    // Original owners stay reachable; never delete a fixture or kill an unsettled owner.
    const cleanupFailures = [];
    if (pendingStart) {
      try { const started = await pendingStart; if ('current' in started) host = started; else preview = started; }
      catch (error) { cleanupFailures.push(error); }
    }
    for (const owner of [preview, host, primaryFailure?.owner].filter(Boolean)) {
      try { await owner.close(); } catch (error) { cleanupFailures.push(error); }
    }
    globalThis.fetch = originalFetch;
    const allClosed = owners.every(owner => owner.drainStatus().closed);
    passed &&= allClosed && cleanupFailures.length === 0;
    save('RESULT.json', { operation, workspaceRoot, directory, passed, candidate: { version: candidate.version, buildVersion: candidate.buildVersion, schemaVersion: candidate.schemaVersion,
      sourceRevision: candidate.sourceRevision }, compiledModules: bindings, stages, shutdown, allObservedOwnersClosed: allClosed,
      externalRequests, syntheticOnly: true, genuineNativeStartupQualified: false, providerReplyQualified: false, hostedReleaseQualified: false,
      failure: primaryFailure ? { name: primaryFailure.name, message: primaryFailure.message } : null,
      cleanupFailures: cleanupFailures.map(error => ({ name: error.name, message: error.message })) });
    t.diagnostic('Retained local integration evidence: ' + evidence);
    if (cleanupFailures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures], 'Original integration or cleanup failed; fixture preserved');
    assert(allClosed, 'Every observed real service owner completed its maintained drain');
  }
});
