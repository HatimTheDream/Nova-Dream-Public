import test from 'node:test';
import assert from 'node:assert/strict';
import { observeReleaseHost, readLoopbackJson, HOST_OBSERVATION_LIMITS } from '../scripts/release-observe-host.mjs';

const epoch = '22222222-2222-4222-8222-222222222222', jobId = '11111111-1111-4111-8111-111111111111', candidate = 'a'.repeat(64);
function fixture() {
  const paths = { config: '/etc/nova-update/config.json', state: '/var/lib/nova-update', agent: '/opt/nova/runtime/openclaw', resolved: '/opt/nova/runtime/managed/node_modules/openclaw', node: '/opt/nova/runtime/openclaw-node' };
  const files = new Map([
    [paths.config, { agentDirectory: paths.agent, agentNodePath: paths.node, stateDirectory: paths.state, workspaceDirectory: '/var/lib/nova/workspace', token: 'NEVER-EXPOSE-CONFIG-TOKEN', privateKey: 'NEVER-EXPOSE-KEY' }],
    [paths.resolved + '/package.json', { name: 'openclaw', version: '2026.9.6', secret: 'NEVER-EXPOSE-PACKAGE' }],
    [paths.state + '/jobs/journal.json', { format: 1, currentId: jobId, jobs: [{ id: jobId, state: 'completed', hold: false, candidateId: candidate, epoch, message: 'NEVER-EXPOSE-JOB' }] }],
    [paths.state + '/operator-maintenance/current.json', { id: jobId, phase: 'released', releaseKind: 'rehearsed', candidateId: candidate, workspaceEpoch: epoch, token: 'NEVER-EXPOSE-LEASE' }],
  ]);
  const reads = [], requests = [];
  const deps = { now: () => 1000, readFile: (path, max) => { reads.push({ path, max }); if (!files.has(path)) throw Error('NEVER-EXPOSE-ERROR'); return { bytes: Buffer.from(JSON.stringify(files.get(path))), mtimeMs: 900 }; },
    realpath: path => path === paths.agent ? paths.resolved : '/opt/nova/runtime/node/bin/node', disk: () => ({ totalBytes: 1000, usedBytes: 400, freeBytes: 600 }),
    getJson: async path => { requests.push(path); return path === '/api/health' ? { status: 'ready', version: '2.1.4', candidateId: candidate, secret: 'NEVER-EXPOSE-HEALTH' } : { workspaceEpoch: epoch, token: 'NEVER-EXPOSE-CONTEXT' }; } };
  return { paths, files, reads, requests, deps, run: () => observeReleaseHost({ configPath: paths.config }, deps) };
}

test('direct package selector, actual currentId and live epoch; disk never qualifies capacity', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, 'observed'); assert.equal(result.runtime.agentVersion, '2026.9.6');
  assert.equal(result.runtime.resolvedDirectory, f.paths.resolved); assert.equal(result.workspaceEpoch, epoch);
  assert.equal(result.journal.currentId, jobId); assert.equal(result.journal.currentJob.id, jobId);
  assert.equal(result.capacity.status, 'unknown'); assert.equal(result.capacity.authoritativeAdmission, false);
  assert.equal(result.controller.status, 'not-observed'); assert.equal(result.deliveryQualification, false);
  assert.equal(result.atomic, false); assert.equal(result.sources.length, 4);
  assert.equal(JSON.stringify(result).includes('NEVER-EXPOSE'), false);
  assert.deepEqual(f.requests, ['/api/health', '/api/access/context', '/api/health', '/api/access/context']);
  assert.ok(f.reads.every(r => !/key|credential|runner/.test(r.path)));
});
test('does not infer a current job from the last array entry', async () => {
  const f = fixture(); delete f.files.get(f.paths.state + '/jobs/journal.json').currentId;
  const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(r.journal, null);
});
test('changed live candidate or epoch invalidates the snapshot', async () => {
  for (const change of ['candidate', 'epoch']) {
    const f = fixture(), original = f.deps.getJson; let n = 0;
    f.deps.getJson = async path => { const value = await original(path); if (++n > 2) { if (change === 'candidate' && path === '/api/health') value.candidateId = 'b'.repeat(64); if (change === 'epoch' && path === '/api/access/context') value.workspaceEpoch = jobId; } return value; };
    const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(r.identityStable, false); assert.equal(r.workspaceEpoch, null);
  }
});
test('source replacement or missing source is unknown without leaking errors', async () => {
  const f = fixture(), original = f.deps.readFile; let n = 0;
  f.deps.readFile = (path, max) => { if (path === f.paths.config && ++n > 1) return { bytes: Buffer.from('{}'), mtimeMs: 901 }; return original(path, max); };
  assert.ok((await f.run()).diagnostics.includes('controller-config-changed'));
  f.files.delete(f.paths.config); const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(JSON.stringify(r).includes('NEVER-EXPOSE'), false);
});
test('bounded journal output preserves a current job outside the final window', async () => {
  const f = fixture(), journal = f.files.get(f.paths.state + '/jobs/journal.json');
  journal.jobs.push(...Array.from({ length: 40 }, (_, i) => ({ ...journal.jobs[0], id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` })));
  const r = await f.run(); assert.equal(r.journal.jobs.length, HOST_OBSERVATION_LIMITS.jobs); assert.equal(r.journal.currentJob.id, jobId); assert.equal(r.journal.truncated, true);
});
test('oversized source and arbitrary endpoint rejected', async () => {
  const f = fixture(); f.deps.readFile = () => ({ bytes: Buffer.alloc(HOST_OBSERVATION_LIMITS.configBytes + 1), mtimeMs: 0 });
  assert.equal((await f.run()).status, 'unknown'); assert.throws(() => readLoopbackJson('https://example.com/'), /unsupported-endpoint/);
});
test('malformed current job outside the output window remains unknown', async () => {
  for (const field of ['state', 'hold']) {
    const f = fixture(), journal = f.files.get(f.paths.state + '/jobs/journal.json');
    journal.jobs.push(...Array.from({ length: 40 }, (_, i) => ({ ...journal.jobs[0], id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` })));
    journal.jobs[0][field] = 'invalid';
    const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(r.journal, null); assert.ok(r.diagnostics.includes('update-journal-invalid'));
  }
});
