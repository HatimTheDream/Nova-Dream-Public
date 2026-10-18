import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { qualityPlan, runQualityPlan } from './quality.mjs';

const TEST_SCRIPT = 'tsx --test --test-concurrency=4 tests/*.test.ts tests/*.test.mjs';
const CHECK_IDS = ['typecheck', 'validate:release', 'build', 'security:audit'];
const COUNTS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function discoverTestInventory(cwd) {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (pkg.scripts?.['test:quality'] !== TEST_SCRIPT) throw new Error('Test command changed; review the shard inventory contract before measuring.');
  const inventory = readdirSync(join(cwd, 'tests'), { withFileTypes: true })
    .filter(entry => /\.test\.(?:ts|mjs)$/.test(entry.name)).map(entry => {
      if (!entry.isFile()) throw new Error('Test inventory may only contain regular files.');
      return `tests/${entry.name}`;
    }).sort();
  validateInventory(inventory);
  return inventory;
}

function validateInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length < 2 || inventory.some(name => typeof name !== 'string' || !/^tests\/[^/\\]+\.test\.(?:ts|mjs)$/.test(name)) ||
      new Set(inventory).size !== inventory.length || !equal(inventory, [...inventory].sort())) throw new Error('Expected a sorted, unique, nonempty two-shard test inventory.');
}

export function selectShard(inventory, index, total = 2) {
  validateInventory(inventory);
  if (total !== 2 || ![1, 2].includes(index)) throw new Error('Exactly two shards are supported.');
  return inventory.filter((_, position) => position % total === index - 1);
}

export function githubIdentity(env, head) {
  const identity = { repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
  if (!/^[^/\s]+\/[^/\s]+$/.test(identity.repository ?? '') || !/^[a-f0-9]{40}$/.test(identity.commit ?? '') ||
      !/^[1-9][0-9]*$/.test(identity.runId ?? '') || !/^[1-9][0-9]*$/.test(identity.runAttempt ?? '') || identity.commit !== head) {
    throw new Error('GitHub identity must bind this checkout, run, and attempt.');
  }
  return identity;
}

export function parseTapSummary(output) {
  const counts = {};
  for (const name of COUNTS) {
    const found = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
    if (found.length !== 1 || !Number.isSafeInteger(Number(found[0][1]))) throw new Error(`Missing or ambiguous TAP summary: ${name}.`);
    counts[name] = Number(found[0][1]);
  }
  if (!counts.tests || counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) throw new Error('TAP test counts do not reconcile.');
  return counts;
}

export function shardCommand(cwd, selectedTests) {
  return { id: 'test-shard', file: process.execPath, args: [join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--test', '--test-reporter=tap', '--test-concurrency=2', ...selectedTests] };
}

function cleanSourceHead(cwd) {
  const options = { cwd, encoding: 'utf8', windowsHide: true };
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options).trim()) throw new Error('CI measurement requires a clean committed checkout.');
  return execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
}

export async function runShard({ cwd, outputDir, shardIndex, withQuality = false, npmCli, env = process.env, signal,
  runPlan = runQualityPlan, head = cleanSourceHead(cwd),
  emit = content => process.stdout.write(content) }) {
  if (withQuality !== (shardIndex === 1)) throw new Error('Shard one must run the non-test quality checks; shard two must not duplicate them.');
  const identity = githubIdentity(env, head), inventory = discoverTestInventory(cwd), selectedTests = selectShard(inventory, shardIndex);
  const command = shardCommand(cwd, selectedTests);
  const checks = withQuality ? qualityPlan(npmCli).filter(lane => lane[0].id !== 'test') : [];
  if (withQuality && !equal(checks.flat().map(check => check.id), CHECK_IDS)) throw new Error('Quality checks changed; review the shard contract before measuring.');
  mkdirSync(outputDir, { recursive: true });
  const logName = `ci-shard-${shardIndex}.log`, logPath = join(outputDir, logName), receiptPath = join(outputDir, `ci-shard-${shardIndex}.json`);
  writeFileSync(logPath, '', { flag: 'wx' });
  const startedAt = new Date().toISOString(), started = performance.now();
  let testTail = '', counts = null, error = null;
  const cleanEnv = { ...env }; delete cleanEnv.NODE_TEST_CONTEXT;
  const result = await runPlan([[command], ...checks], { cwd, env: cleanEnv, signal, emit: event => {
    let content;
    if (event.type === 'output' || event.type === 'tail') {
      content = event.content;
      if (event.id === 'test-shard' && (event.stream === 'stdout' || event.type === 'tail')) testTail = (testTail + content.toString('utf8')).slice(-64 * 1024);
    } else content = `\n[ci:${event.id}] ${JSON.stringify(event)}\n`;
    appendFileSync(logPath, content); emit(content);
  } });
  try { counts = parseTapSummary(testTail); } catch (caught) { error = caught.message; }
  const test = result.checks.find(check => check.id === 'test-shard');
  const nonTestChecks = result.checks.filter(check => check.id !== 'test-shard');
  const receipt = { kind: 'nova-ci-shard-measurement', schemaVersion: 1, purpose: 'measurement-only', identity,
    shard: { index: shardIndex, total: 2 }, inventorySha256: hash(JSON.stringify(inventory)), inventory, selectedTests,
    command, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
    test: { ...test, counts, command }, nonTestQuality: withQuality ? { passed: nonTestChecks.every(check => check.state === 'passed'), checks: nonTestChecks } : null,
    log: { file: logName, sha256: hash(readFileSync(logPath)) },
    passed: result.passed && !result.cancelled && !result.checks.some(check => check.truncated) && !!counts && counts.pass > 0 && !counts.fail && !counts.cancelled && !error,
    error };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

// This validates a measurement, never a release-admission receipt. The existing
// canonical CI and publication contracts remain unchanged until separately qualified.
export function validateShardReceipts(receipts, expectedIdentity, expectedInventory) {
  validateInventory(expectedInventory);
  githubIdentity({ GITHUB_REPOSITORY: expectedIdentity.repository, GITHUB_SHA: expectedIdentity.commit,
    GITHUB_RUN_ID: expectedIdentity.runId, GITHUB_RUN_ATTEMPT: expectedIdentity.runAttempt }, expectedIdentity.commit);
  if (!Array.isArray(receipts) || receipts.length !== 2 || new Set(receipts.map(receipt => receipt?.shard?.index)).size !== 2) throw new Error('Both distinct shard receipts are required.');
  for (const receipt of receipts) {
    const index = receipt?.shard?.index;
    if (receipt?.kind !== 'nova-ci-shard-measurement' || receipt.schemaVersion !== 1 || receipt.purpose !== 'measurement-only' || receipt.shard.total !== 2 || ![1, 2].includes(index)) throw new Error('Wrong measurement receipt contract.');
    if (!receipt.identity || ['repository', 'commit', 'runId', 'runAttempt'].some(key => receipt.identity[key] !== expectedIdentity[key])) throw new Error('Shard source, run, or attempt does not match.');
    if (!Number.isSafeInteger(receipt.elapsedMs) || receipt.elapsedMs < 0) throw new Error('Shard elapsed time is missing or invalid.');
    if (!equal(receipt.inventory, expectedInventory) || receipt.inventorySha256 !== hash(JSON.stringify(expectedInventory)) ||
        !equal(receipt.selectedTests, selectShard(expectedInventory, index))) throw new Error('Shard inventory or partition is incomplete or changed.');
    const args = receipt.test?.command?.args;
    if (!Array.isArray(args) || args.length !== receipt.selectedTests.length + 4 || !/[\\/]node_modules[\\/]tsx[\\/]dist[\\/]cli\.mjs$/.test(args[0]) ||
        !equal(args.slice(1), ['--test', '--test-reporter=tap', '--test-concurrency=2', ...receipt.selectedTests]) || !equal(receipt.command, receipt.test.command)) throw new Error('Shard command is not the complete unfiltered test selection.');
    const counts = receipt.test?.counts;
    if (!receipt.passed || receipt.error || receipt.test?.state !== 'passed' || receipt.test.exitCode !== 0 || receipt.test.truncated ||
        !counts || COUNTS.some(name => !Number.isSafeInteger(counts[name]) || counts[name] < 0) || !counts.pass || counts.fail || counts.cancelled ||
        counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) throw new Error('A test shard failed or its count evidence is incomplete.');
    if (!/^[a-f0-9]{64}$/.test(receipt.log?.sha256 ?? '') || receipt.log.file !== `ci-shard-${index}.log`) throw new Error('Shard log digest is missing.');
    if (index === 1) {
      const checks = receipt.nonTestQuality?.checks;
      if (!receipt.nonTestQuality?.passed || !Array.isArray(checks) || !equal(checks.map(check => check.id), CHECK_IDS) ||
          checks.some(check => check.state !== 'passed' || check.exitCode !== 0 || check.truncated)) throw new Error('All non-test quality checks must pass exactly once.');
    } else if (receipt.nonTestQuality !== null) throw new Error('Non-test checks were duplicated.');
  }
  return { kind: 'nova-ci-shard-measurement-summary', schemaVersion: 1, purpose: 'measurement-only', passed: true, identity: expectedIdentity,
    inventorySha256: hash(JSON.stringify(expectedInventory)), testFiles: expectedInventory.length,
    counts: Object.fromEntries(COUNTS.map(name => [name, receipts.reduce((sum, receipt) => sum + receipt.test.counts[name], 0)])),
    parallelElapsedMs: Math.max(...receipts.map(receipt => receipt.elapsedMs)) };
}

export function parseArguments(args) {
  const values = new Map();
  for (const arg of args) {
    const match = /^(--shard|--output-dir)=(.+)$/.exec(arg);
    const key = match?.[1] ?? arg;
    if ((!match && arg !== '--with-quality') || values.has(key)) throw new Error('Usage: ci-test-shard.mjs --shard=1/2 --output-dir=PATH --with-quality (or shard 2/2 without quality).');
    values.set(key, match?.[2] ?? true);
  }
  const shard = /^([12])\/2$/.exec(values.get('--shard') ?? '');
  if (!shard || !values.get('--output-dir')) throw new Error('An exact shard and output directory are required.');
  return { shardIndex: Number(shard[1]), outputDir: resolve(values.get('--output-dir')), withQuality: values.has('--with-quality') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const receipt = await runShard({ ...parseArguments(process.argv.slice(2)), cwd: process.cwd(), npmCli: process.env.npm_execpath ?? '', signal: controller.signal });
    process.stdout.write(`${JSON.stringify({ kind: receipt.kind, shard: receipt.shard.index, passed: receipt.passed, elapsedMs: receipt.elapsedMs, counts: receipt.test.counts })}\n`);
    process.exitCode = controller.signal.aborted ? 130 : receipt.passed ? 0 : 1;
  } catch (error) { process.stderr.write(`CI measurement failed: ${error.message}\n`); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
