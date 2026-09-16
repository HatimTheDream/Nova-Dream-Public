import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import policy from '../apps/desktop/launch-policy.cjs';
import { desktopHealth } from '../scripts/desktop-health.mjs';

const expected = { version: '0.69.0', buildVersion: '1.0.122', schemaVersion: 51, apiVersion: 1, candidateId: 'a'.repeat(64) };
const valid = { ...expected, application: 'nova-dream-edition-3', status: 'ready' };
async function listener(handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { address: `http://127.0.0.1:${server.address().port}`, close() { server.closeAllConnections(); return new Promise(ok => server.close(ok)); } };
}
test('desktop QA requires an isolated short profile and explicit non-primary port', () => {
  assert.deepEqual(policy.launchOptions([]), { qa: false, port: 4383, address: 'http://127.0.0.1:4383' });
  assert.deepEqual(policy.launchOptions(['--port=4398', '--qa', '--profile=release-069']), { qa: true, port: 4398, address: 'http://127.0.0.1:4398', profile: 'release-069' });
  for (const profile of ['../owner', '/tmp/owner', 'a/b', 'a\\b', 'Dream Claw', '.hidden', 'UPPER', 'x'.repeat(41)]) assert.throws(() => policy.launchOptions(['--qa', '--port=4398', `--profile=${profile}`]));
  for (const args of [['--qa'], ['--profile=qa', '--port=4398'], ['--qa', '--profile=qa', '--port=4383'], ['--qa', '--profile=qa', '--port=80'], ['--qa', '--profile=qa', '--port=65536'], ['--qa', '--profile=qa', '--port=04398'], ['--qa', '--profile=qa', '--port=4398', '--qa'], ['--user-data-dir=/tmp/owner']]) assert.throws(() => policy.launchOptions(args));
});
test('Windows QA stays inside windows-profiles and directory symlinks cannot redirect review data', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'Dream Claw desktop '));
  const outside = mkdtempSync(join(tmpdir(), 'edition3-outside-'));
  try {
    const options = policy.launchOptions(['--qa', '--profile=release-069', '--port=4398']);
    const profile = policy.profileDirectory(options, workspace, outside, 'win32');
    assert.equal(profile, join(workspace, '.tmp-qa/windows-profiles/release-069'));
    assert.equal(policy.prepareQaDirectory(profile, workspace), profile);
    const redirect = join(workspace, '.tmp-qa/redirect'); symlinkSync(outside, redirect, 'dir');
    assert.throws(() => policy.prepareQaDirectory(join(redirect, 'new-profile'), workspace), /symlinks/);
    assert.equal(existsSync(join(outside, 'new-profile')), false);
    assert.throws(() => policy.prepareQaDirectory(outside, workspace), /inside/);
    assert.equal(policy.profileDirectory(policy.launchOptions([]), workspace, outside), join(outside, 'NovaDream-Edition3-Preview'));
  } finally { rmSync(workspace, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
test('desktop only reuses the exact ready candidate, including same-version rebuild identity', async () => {
  let data = valid;
  const service = await listener((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); });
  try {
    assert.equal(await desktopHealth(service.address, expected), true);
    for (const change of [{ version: '0.68.0' }, { candidateId: 'b'.repeat(64) }, { buildVersion: '1.0.121' }, { schemaVersion: 50 }, { apiVersion: 2 }, { status: 'starting' }, { application: 'unrelated' }, { candidateId: undefined }]) {
      data = { ...valid, ...change }; await assert.rejects(desktopHealth(service.address, expected), /left running/);
    }
    data = valid; assert.equal(await desktopHealth(service.address, expected), true);
  } finally { await service.close(); }
});
test('only a refused listener allows startup; unknown HTML, redirects and a hung response remain untouched', async () => {
  let mode = 'html';
  const service = await listener((_req, res) => {
    if (mode === 'hang') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1' }); res.end(); return; }
    res.end('<html>Another app</html>');
  });
  try {
    await assert.rejects(desktopHealth(service.address, expected), /left running/);
    mode = 'redirect'; await assert.rejects(desktopHealth(service.address, expected), /left running/);
    mode = 'hang'; await assert.rejects(desktopHealth(service.address, expected, 60), /left running/);
  } finally { await service.close(); }
  assert.equal(await desktopHealth(service.address, expected), false);
});
test('desktop candidates require a complete supported shell manifest', () => {
  assert.throws(() => policy.expectedCandidate({}, expected.candidateId), /paired desktop/);
  assert.throws(() => policy.expectedCandidate({ desktopFormat: 1 }, 'invalid'), /paired desktop/);
  assert.deepEqual(policy.expectedCandidate({ ...expected, desktopFormat: 1 }, expected.candidateId), expected);
});
