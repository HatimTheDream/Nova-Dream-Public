import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256 } from '../scripts/release-plan.mjs';

test('real CLI normalizes relative evidence; status and blocked resume preserve the original operation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-release-command-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = c => c.repeat(64), now = Date.now(), id = randomUUID(), epoch = randomUUID(), lease = randomUUID();
  const put = (name, value, absolute = false) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    writeFileSync(join(directory, name), bytes); return { path: absolute ? join(directory, name) : name, sha256: sha256(bytes) }; };
  const proof = put('proof.json', { synthetic: true });
  const review = put('review.json', { leaseId: lease, candidateId: h('b'), workspaceEpoch: epoch });
  const operation = { id, stage: 'frozen', candidateId: h('a'), publicCandidateId: h('c'), priorCandidateId: h('b'), workspaceEpoch: epoch,
    version: '2.2.0', buildVersion: '1.0.281', agentVersion: '2026.9.8', priorAgentVersion: '2026.9.6',
    sourceCommits: { private: 'd'.repeat(40), public: 'e'.repeat(40) }, bundleSha256: h('f'), trustedPublicKeySha256: h('1'), changeClass: 'runtime',
    helperHashes: Object.fromEntries(['install.py', 'recovery.py', 'codex_log_retention.py', 'app_dependencies.py', 'workspace_key.py', 'verify-session-bindings.mjs', 'operator_rehearsal.py'].map(name => [name, h('2')])) };
  const installSpec = put('install.json', { format: 1, operationId: id, candidateId: h('a'), priorCandidateId: h('b'), workspaceEpoch: epoch,
    version: operation.version, buildVersion: operation.buildVersion, priorVersion: '2.1.4', priorBuildVersion: '1.0.280', schemaVersion: 55, apiVersion: 1,
    agentVersion: operation.agentVersion, priorAgentVersion: operation.priorAgentVersion, bundleSha256: h('f'), rehearsalLeaseId: lease, rehearsalProofSha256: proof.sha256 });
  const transport = put('transport.json', { format: 1, hostAlias: 'synthetic-do-not-connect', sshConfig: put('ssh-config', 'Host synthetic-do-not-connect\n  HostName example.invalid\n', true) });
  const input = { format: 1, operation, evidence: { recovery: { review, proof } }, remainingEstimates: {},
    timeline: { startedAtMs: now, original: { id: randomUUID(), step: 'total', issuedAtMs: now, remainingMs: null,
      confidence: 'unknown', basis: 'Synthetic CLI check.', reason: 'Missing qualification.', nextCheckpointAtMs: now + 300000 },
      revisions: [], reviews: [], lastCheckpointAtMs: now } };
  const descriptor = put('descriptor.json', { format: 1, input, adapter: { transport, installSpec } }, true);
  const script = fileURLToPath(new URL('../scripts/release-coordinate.mjs', import.meta.url)), journal = join(directory, 'private-journal');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: tmpdir() });
  const created = run('init', journal, descriptor.path);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const initial = JSON.parse(created.stdout); assert.equal(initial.operationId, id); assert.equal(initial.intent, null);
  const dbPath = join(journal, 'release.sqlite'), before = sha256(readFileSync(dbPath));
  const status = run('status', journal, id); assert.equal(status.status, 0, status.stdout + status.stderr);
  const plan = run('plan', journal, id); assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.equal(JSON.parse(plan.stdout).readiness, 'blocked');
  assert.equal(sha256(readFileSync(dbPath)), before, 'Read-only commands must preserve journal bytes.');
  const refused = run('resume', journal, id); assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).automaticReplayPermitted, false);
  const after = JSON.parse(run('status', journal, id).stdout);
  assert.equal(after.intent, null, 'Missing evidence must fail before intent or transport dispatch.');
  assert.deepEqual(after.events, initial.events);
  assert.deepEqual(after.storedPlan.timeline.original, initial.storedPlan.timeline.original);
});
