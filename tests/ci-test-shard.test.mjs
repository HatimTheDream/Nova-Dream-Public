import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { discoverTestInventory, githubIdentity, parseArguments, parseTapSummary, runShard, selectShard, validateShardReceipts } from '../scripts/ci-test-shard.mjs';

const script = 'tsx --test --test-concurrency=4 tests/*.test.ts tests/*.test.mjs';
const identity = { repository: 'example/application', commit: 'a'.repeat(40), runId: '123', runAttempt: '1' };
const env = { ...process.env, GITHUB_REPOSITORY: identity.repository, GITHUB_SHA: identity.commit, GITHUB_RUN_ID: identity.runId, GITHUB_RUN_ATTEMPT: identity.runAttempt };
const summary = '# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nova-ci-shard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'test:quality': script } }));
  return root;
}
function addTests(root, names) {
  for (const name of names) writeFileSync(join(root, 'tests', name), "import test from 'node:test';test('selected fixture',()=>{});\n");
}
function successfulReceipt(index, inventory) {
  const selectedTests = selectShard(inventory, index);
  const command = { id: 'test-shard', file: '/node', args: ['/app/node_modules/tsx/dist/cli.mjs', '--test', '--test-reporter=tap', '--test-concurrency=2', ...selectedTests] };
  return { kind: 'nova-ci-shard-measurement', schemaVersion: 1, purpose: 'measurement-only', identity,
    shard: { index, total: 2 }, inventory, inventorySha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'), selectedTests, command,
    elapsedMs: 5, test: { state: 'passed', exitCode: 0, truncated: false, command, counts: parseTapSummary(summary) },
    nonTestQuality: index === 1 ? { passed: true, checks: ['typecheck', 'validate:release', 'build', 'security:audit'].map(id => ({ id, state: 'passed', exitCode: 0, truncated: false })) } : null,
    log: { file: `ci-shard-${index}.log`, sha256: 'c'.repeat(64) }, passed: true, error: null };
}

test('inventory matches both existing test globs, and two deterministic partitions cover it exactly once', t => {
  const root = fixture(t); addTests(root, ['z.test.ts', 'a.test.mjs', 'odd.test.mjs', 'b.test.ts']);
  writeFileSync(join(root, 'tests', 'ignored.txt'), 'ignored');
  mkdirSync(join(root, 'tests', 'nested')); writeFileSync(join(root, 'tests', 'nested', 'other.test.mjs'), 'not part of existing glob');
  const inventory = discoverTestInventory(root);
  assert.deepEqual(inventory, ['tests/a.test.mjs', 'tests/b.test.ts', 'tests/odd.test.mjs', 'tests/z.test.ts']);
  const one = selectShard(inventory, 1), two = selectShard(inventory, 2);
  assert.equal(new Set([...one, ...two]).size, inventory.length);
  assert.deepEqual([...one, ...two].sort(), inventory);
  assert.deepEqual(one, ['tests/a.test.mjs', 'tests/odd.test.mjs']);
  assert.throws(() => selectShard(inventory, 0), /two shards/);
  assert.throws(() => selectShard(inventory, 1, 3), /two shards/);
  assert.throws(() => selectShard([...inventory].reverse(), 1), /sorted/);
  assert.throws(() => selectShard([inventory[0], inventory[0]], 1), /unique/);
});

test('empty inventories, directory lookalikes and changed test commands fail instead of silently omitting tests', t => {
  const root = fixture(t);
  assert.throws(() => discoverTestInventory(root), /inventory/);
  addTests(root, ['a.test.mjs', 'b.test.mjs']);
  mkdirSync(join(root, 'tests', 'directory.test.mjs'));
  assert.throws(() => discoverTestInventory(root), /regular files/);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:quality': `${script} more-tests/*.test.mjs` } }));
  assert.throws(() => discoverTestInventory(root), /command changed/);
});

test('source identity requires the exact checkout, run and attempt', () => {
  assert.deepEqual(githubIdentity(env, identity.commit), identity);
  for (const changed of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '' }, { GITHUB_REPOSITORY: 'missing' }]) {
    assert.throws(() => githubIdentity({ ...env, ...changed }, identity.commit), /identity/);
  }
});

test('TAP summaries retain existing platform skips but reject absent, ambiguous or inconsistent counts', () => {
  assert.deepEqual(parseTapSummary(summary), { tests: 3, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.throws(() => parseTapSummary(summary.replace('# pass 2\n', '')), /pass/);
  assert.throws(() => parseTapSummary(summary + '# tests 3\n'), /ambiguous/);
  assert.throws(() => parseTapSummary(summary.replace('# tests 3', '# tests 4')), /reconcile/);
  assert.throws(() => parseTapSummary(summary.replace('# tests 3', '# tests 9007199254740992')), /summary/);
});

test('receipt validation rejects missing, duplicate, failed and corrupt shard evidence', () => {
  const inventory = ['tests/a.test.mjs', 'tests/b.test.ts', 'tests/c.test.mjs'];
  const originals = [successfulReceipt(1, inventory), successfulReceipt(2, inventory)];
  const accepted = validateShardReceipts(originals, identity, inventory);
  assert.equal(accepted.purpose, 'measurement-only'); assert.equal(accepted.testFiles, 3); assert.equal(accepted.counts.tests, 6);
  assert.equal(validateShardReceipts(originals, { runAttempt: identity.runAttempt, runId: identity.runId, commit: identity.commit, repository: identity.repository }, inventory).passed, true);
  assert.throws(() => validateShardReceipts(originals.slice(0, 1), identity, inventory), /Both distinct/);
  assert.throws(() => validateShardReceipts([originals[0], originals[0]], identity, inventory), /Both distinct/);
  for (const mutate of [
    receipts => { receipts[1].passed = false; },
    receipts => { receipts[1].test.state = 'blocked'; },
    receipts => { receipts[1].test.exitCode = 1; },
    receipts => { receipts[1].test.counts.fail = 1; },
    receipts => { receipts[1].test.counts = null; },
    receipts => { receipts[1].test.truncated = true; },
    receipts => { receipts[1].identity.commit = 'b'.repeat(40); },
    receipts => { receipts[1].identity.runId = '456'; },
    receipts => { receipts[1].identity.runAttempt = '2'; },
    receipts => { receipts[1].inventory.pop(); },
    receipts => { receipts[1].inventorySha256 = 'b'.repeat(64); },
    receipts => { receipts[1].selectedTests = receipts[0].selectedTests; },
    receipts => { receipts[1].test.command.args.splice(2, 0, '--test-name-pattern=safe'); },
    receipts => { receipts[1].log.sha256 = 'corrupt'; },
    receipts => { receipts[1].elapsedMs = -1; },
    receipts => { receipts[0].nonTestQuality.checks.pop(); },
    receipts => { receipts[0].nonTestQuality.checks[0].state = 'skipped'; },
    receipts => { receipts[1].nonTestQuality = receipts[0].nonTestQuality; },
    receipts => { receipts[0].purpose = 'release'; },
  ]) {
    const receipts = structuredClone(originals); mutate(receipts);
    assert.throws(() => validateShardReceipts(receipts, identity, inventory));
  }
});

test('CLI requires explicit unique shard arguments without test filters', () => {
  assert.equal(parseArguments(['--shard=1/2', '--output-dir=out', '--with-quality']).shardIndex, 1);
  assert.equal(parseArguments(['--shard=2/2', '--output-dir=out']).withQuality, false);
  for (const args of [[], ['--shard=1/3', '--output-dir=out'], ['--shard=1/2', '--shard=2/2', '--output-dir=out'], ['--shard=1/2', '--output-dir=out', '--test-name-pattern=x']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('real child processes execute each selected file once and preserve all four other checks', async t => {
  const root = fixture(t); addTests(root, ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs']);
  const tsxDir = join(root, 'node_modules', 'tsx', 'dist'); mkdirSync(tsxDir, { recursive: true });
  writeFileSync(join(tsxDir, 'cli.mjs'), "import{spawnSync}from'node:child_process';const r=spawnSync(process.execPath,process.argv.slice(2),{stdio:'inherit',shell:false,windowsHide:true});process.exit(r.status??1);\n");
  const npmCli = join(root, 'npm-cli.mjs'); writeFileSync(npmCli, "if(process.argv[2]!=='run')process.exit(2);console.log('check '+process.argv[3]);\n");
  const receipts = [];
  for (const shardIndex of [1, 2]) receipts.push(await runShard({ cwd: root, outputDir: join(root, `out-${shardIndex}`), shardIndex,
    withQuality: shardIndex === 1, npmCli, env, head: identity.commit, emit: () => {} }));
  assert.equal(receipts[0].passed, true); assert.equal(receipts[1].passed, true);
  const result = validateShardReceipts(receipts, identity, discoverTestInventory(root));
  assert.equal(result.counts.pass, 4);
  for (const receipt of receipts) {
    const log = readFileSync(join(root, `out-${receipt.shard.index}`, receipt.log.file));
    assert.equal(createHash('sha256').update(log).digest('hex'), receipt.log.sha256);
    assert.equal(JSON.parse(readFileSync(join(root, `out-${receipt.shard.index}`, `ci-shard-${receipt.shard.index}.json`))).passed, true);
  }
  await assert.rejects(() => runShard({ cwd: root, outputDir: join(root, 'out-1'), shardIndex: 1, withQuality: true, npmCli, env, head: identity.commit, emit: () => {} }), /EEXIST/);
});

test('failed child, missing TAP summary, cancellation and omission of the non-test lane cannot pass', async t => {
  const root = fixture(t); addTests(root, ['a.test.mjs', 'b.test.mjs']);
  await assert.rejects(() => runShard({ cwd: root, outputDir: join(root, 'out'), shardIndex: 1, env, head: identity.commit }), /must run/);
  for (const [name, state, exitCode, output, cancelled] of [
    ['failed', 'failed', 1, summary, false], ['missing', 'passed', 0, '', false], ['cancelled', 'cancelled', null, summary, true],
  ]) {
    const receipt = await runShard({ cwd: root, outputDir: join(root, name), shardIndex: 2, env, head: identity.commit, emit: () => {},
      runPlan: async (_, options) => {
        options.emit({ type: 'output', id: 'test-shard', stream: 'stdout', content: Buffer.from(output) });
        return { passed: exitCode === 0, cancelled, checks: [{ id: 'test-shard', state, exitCode, truncated: false }] };
      } });
    assert.equal(receipt.passed, false, name);
  }
});
