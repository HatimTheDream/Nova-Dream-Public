/** Local qualification only. One maintained host lifetime; never copies or restores data.
 * Private result includes generated local bridge credentials. Never print that result.
 * A pending drain retains this original owner and accepts explicit stdin observation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const modules = ['apps/service/workspace-host.js', 'apps/service/http.js', 'apps/service/runtime.js',
  'apps/service/browser-network.js', 'apps/service/service-drain.js', 'apps/service/store.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const errorRecord = error => ({ name: String(error?.name ?? 'Error').slice(0, 120),
  message: String(error?.message ?? error).slice(0, 2048),
  ...(error?.outcome ? { outcome: { state: error.outcome.state, phase: error.outcome.phase,
    reason: error.outcome.reason, localSettled: error.outcome.localSettled } } : {}) });
const inside = (parent, child) => { const rel = relative(parent, child); return !rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)); };
function absolute(value) { assert.equal(typeof value, 'string'); assert(isAbsolute(value)); assert(!value.includes('\0')); return resolve(value); }
function ordinary(path, directory) { const stat = lstatSync(path); assert(!stat.isSymbolicLink()); assert(directory ? stat.isDirectory() : stat.isFile()); return stat; }
function readJson(path, max = 65536) { const stat = ordinary(path, false); assert(stat.size <= max); return JSON.parse(readFileSync(path, 'utf8')); }
function save(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 262144);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function parseInput(path) {
  const value = readJson(absolute(path));
  assert.deepEqual(Object.keys(value).sort(), ['expectedBuildVersion', 'expectedSchema', 'expectedVersion', 'format', 'kind',
    'operationId', 'readyTimeoutMs', 'releaseRoot', 'resultPath', 'workspaceRoot'].sort());
  assert.equal(value.format, 1); assert.equal(value.kind, 'local-native-retained-host');
  assert.match(value.operationId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.match(value.expectedVersion, /^\d+\.\d+\.\d+$/); assert.match(value.expectedBuildVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(value.expectedSchema, 60);
  assert(Number.isInteger(value.readyTimeoutMs) && value.readyTimeoutMs >= 1000 && value.readyTimeoutMs <= 300000);
  for (const key of ['workspaceRoot', 'releaseRoot', 'resultPath']) value[key] = absolute(value[key]);
  ordinary(value.workspaceRoot, true); ordinary(value.releaseRoot, true); ordinary(resolve(value.resultPath, '..'), true);
  assert(!inside(value.workspaceRoot, value.resultPath) && !inside(value.releaseRoot, value.resultPath));
  assert(!inside(value.releaseRoot, value.workspaceRoot) && !inside(value.workspaceRoot, value.releaseRoot));
  assert(!existsSync(value.resultPath) && !existsSync(value.resultPath + '.started.json'));
  assert.equal(process.env.E3_SERVER_KEY_FILE, undefined, 'External server-key scope is not admitted');
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must remain enabled');
  const candidate = readJson(join(value.releaseRoot, 'dist/candidate.json'));
  assert.equal(candidate.version, value.expectedVersion); assert.equal(candidate.buildVersion, value.expectedBuildVersion);
  assert.equal(candidate.schemaVersion, value.expectedSchema);
  return value;
}
function hostBindings(releaseRoot) {
  return Object.fromEntries(modules.map(name => {
    const path = join(releaseRoot, 'dist/service', name); ordinary(path, false); return [name, sha(readFileSync(path))];
  }));
}
function generatedBindings(service, identity) {
  const runtime = service.runtime;
  // These exact instance attributes are bound to the compiled runtime/browser-network
  // inputs above. No source-policy value is accepted from the AFTER configuration.
  assert.equal(typeof runtime.moduleBridge, 'function');
  const bridge = runtime.moduleBridge();
  assert.deepEqual(Object.keys(bridge).sort(), ['token', 'url']);
  assert.equal(bridge.url, service.origin + '/workspace'); assert.match(bridge.token, /^[a-f0-9]{64}$/);
  const network = runtime.browserNetwork;
  assert(network?.server?.listening && typeof network.address === 'string');
  const address = network.server.address();
  assert(address && typeof address === 'object' && address.address === '127.0.0.1');
  assert.equal(network.address, `http://127.0.0.1:${address.port}`);
  const native = new URL(identity.url); assert.equal(native.protocol, 'ws:'); assert.equal(native.hostname, '127.0.0.1');
  return { moduleBridge: bridge, browserProxy: { url: network.address, port: address.port }, epoch: service.store.epoch,
    ports: { app: Number(new URL(service.origin).port), native: Number(native.port), browserProxy: address.port } };
}

export async function runHost(input, startWorkspaceHost) {
  const bindings = hostBindings(input.releaseRoot);
  const report = { format: 1, kind: 'local-native-retained-host-result', operationId: input.operationId,
    startedAt: now(), startedEpochMs: Date.now(), candidate: { version: input.expectedVersion,
      buildVersion: input.expectedBuildVersion, schemaVersion: input.expectedSchema },
    workspaceRoot: input.workspaceRoot, releaseRoot: input.releaseRoot, bindings,
    observer: { pid: process.pid, parentPid: process.ppid, node: process.execPath, nodeVersion: process.version },
    observations: [], observedNativePids: [], ready: false, closed: false, providerRequestSubmitted: false };
  save(input.resultPath + '.started.json', report);
  let host, service, startPendingOwner, primary, cleanup, lastState, nativePids = new Set();
  const observe = () => {
    if (!service) return;
    const runtime = service.runtime, child = runtime?.child;
    if (child?.pid) { assert(Number.isSafeInteger(child.pid) && child.pid > 0); nativePids.add(child.pid); }
    const state = runtime?.status(), gateway = service.gateway.status();
    const key = JSON.stringify({ state: state?.state, phase: state?.phase, gateway: gateway.state, pid: child?.pid });
    if (key !== lastState) {
      assert(report.observations.length < 128); lastState = key;
      report.observations.push({ at: now(), runtime: { state: state?.state, phase: state?.phase },
        gateway: gateway.state, nativePid: child?.pid ?? null });
    }
    return { state, gateway };
  };
  const closeOriginal = async () => {
    if (host) { await host.close(); assert.equal(service.drainStatus().closed, true); }
    else if (startPendingOwner) { await startPendingOwner.close(); assert.equal(startPendingOwner.status().closed, true); }
    report.closed = true;
  };
  try {
    try {
      host = await startWorkspaceHost({ directory: input.workspaceRoot, port: 0, version: input.expectedVersion,
        buildVersion: input.expectedBuildVersion, schemaVersion: input.expectedSchema });
    } catch (error) { if (error?.owner?.close && error?.owner?.status) startPendingOwner = error.owner; throw error; }
    service = host.current; report.origin = service.origin;
    assert(service.runtime, 'Managed native runtime is required'); assert.equal(service.phoneAccess.enabled, false);
    const deadline = report.startedEpochMs + input.readyTimeoutMs;
    for (;;) {
      const status = observe();
      if (Date.now() >= deadline) throw Error('Original native readiness deadline expired');
      if (status.state?.state === 'running' && status.gateway.state === 'ready') {
        const identity = service.runtime.updateIdentity(); assert(identity && identity.version === '2026.9.8');
        assert.equal(identity.epoch, service.store.epoch); nativePids.add(identity.pid);
        report.nativeIdentity = identity; report.generated = generatedBindings(service, identity);
        report.moduleBridge = report.generated.moduleBridge; report.browserProxy = report.generated.browserProxy;
        report.ready = true; report.readyAt = now(); break;
      }
      if (['error', 'unavailable'].includes(status.state?.state)) throw Error('Original native startup reached ' + status.state.state);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch (error) { primary = error; }
  finally {
    try { observe(); } catch (error) { primary ??= error; }
    try { await closeOriginal(); } catch (error) { cleanup = error; }
    report.observedNativePids = [...nativePids].sort((a, b) => a - b);
    report.endedAt = now(); report.endedEpochMs = Date.now();
    if (primary) report.primaryError = errorRecord(primary);
    if (cleanup) report.cleanupError = errorRecord(cleanup);
    report.passed = report.ready && report.closed && !primary && !cleanup;
    report.originalOwnerRetained = !report.closed;
    try { assert.deepEqual(hostBindings(input.releaseRoot), bindings, 'Compiled inputs changed during qualification'); }
    catch (error) { report.inputBindingError = errorRecord(error); report.passed = false; }
    try { save(input.resultPath, report); }
    catch (error) { report.receiptWriteError = errorRecord(error); report.passed = false; }
  }
  return { report, closeOriginal, service, startPendingOwner };
}

export async function observeClose(original, input, index, write = save, summary = value => process.stdout.write(value)) {
  const observation = { operationId: input.operationId, observedAt: now(), closed: false };
  try { await original.closeOriginal(); observation.closed = true; } catch (error) { observation.error = errorRecord(error); }
  let receiptWritten = false;
  try { write(input.resultPath + '.close-' + index + '.json', observation); receiptWritten = true; }
  catch (error) { observation.receiptWriteError = errorRecord(error); }
  // Retain diagnostics on the same owner even if disk/transport is unavailable.
  (original.closeObservations ??= []).push(observation);
  try { summary(JSON.stringify({ operationId: input.operationId, closeObservation: index,
    closed: observation.closed, receiptWritten }) + '\n'); } catch (error) { observation.summaryError = errorRecord(error); }
  return { observation, receiptWritten };
}

export function guardTransports(streams, errors) {
  for (const [name, stream] of Object.entries(streams)) stream.on('error', error => {
    if (errors.length < 16) errors.push({ transport: name, ...errorRecord(error) });
  });
}

async function main() {
  const transportErrors = [];
  guardTransports({ stdout: process.stdout, stderr: process.stderr }, transportErrors);
  assert.equal(process.platform, 'win32'); assert.equal(process.argv.length, 3);
  const input = parseInput(process.argv[2]);
  const beforeImport = hostBindings(input.releaseRoot);
  const { startWorkspaceHost } = await import(pathToFileURL(join(input.releaseRoot, 'dist/service/apps/service/workspace-host.js')).href);
  assert.deepEqual(hostBindings(input.releaseRoot), beforeImport, 'Compiled inputs changed during import');
  const original = await runHost(input, startWorkspaceHost);
  original.transportErrors = transportErrors;
  try { process.stdout.write(JSON.stringify({ operationId: input.operationId, passed: original.report.passed,
    ready: original.report.ready, closed: original.report.closed, resultPath: input.resultPath }) + '\n'); }
  catch (error) { if (transportErrors.length < 16) transportErrors.push(errorRecord(error)); }
  process.exitCode = original.report.passed ? 0 : 1;
  if (!original.report.closed) {
    // No restart, retry dispatch, forced exit or forced child kill. A subsequent
    // explicit command only observes the retained original service drain owner.
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let busy = false, index = 0;
    lines.on('line', async line => {
      if (busy || line.length > 1024) return;
      let command;
      try { command = JSON.parse(line); } catch { return; }
      if (command.action !== 'observe-close' || command.operationId !== input.operationId || Object.keys(command).length !== 2) return;
      if (index >= 128) return;
      busy = true;
      try {
        const result = await observeClose(original, input, ++index);
        if (result.observation.closed) lines.close();
      } catch (error) {
        // An unexpected observer error cannot destroy the original owner.
        original.controlError = errorRecord(error);
      } finally { busy = false; }
    });
    // Keep this control channel/owner reachable even if the launcher's stdin ends.
    const retained = setInterval(() => {}, 60000);
    lines.on('close', () => { if (original.report.closed) clearInterval(retained); });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { process.stderr.write('Local host qualification failed: ' + errorRecord(error).name + '\n'); process.exitCode = 1; });
