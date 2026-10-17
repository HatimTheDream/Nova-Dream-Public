import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { qualityPlan, runQualityPlan } from '../scripts/quality.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nova-quality-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const command = (id, code) => ({ id, file: process.execPath, args: ['--input-type=module', '-e', code] });
const marker = (name, value = 'done') => `writeFileSync(${JSON.stringify(name)},${JSON.stringify(value)});`;
const waitFor = name => `await new Promise((ok,no)=>{const end=Date.now()+8000;const timer=setInterval(()=>{if(existsSync(${JSON.stringify(name)})){clearInterval(timer);ok();}else if(Date.now()>end){clearInterval(timer);no(Error('peer did not start'));}},10);});`;
const fsImport = "import {writeFileSync,existsSync} from 'node:fs';";

test('quality preserves all five scripts and bounds only its test file workers to four', t => {
  const root = fixture(t), npm = join(root, 'npm-cli.js'); writeFileSync(npm, 'fixture');
  const plan = qualityPlan(npm);
  assert.deepEqual(plan.map(lane => lane.map(check => check.id)), [['test'], ['typecheck', 'validate:release', 'build'], ['security:audit']]);
  assert.deepEqual(plan[0][0].args, [npm, 'run', 'test:quality']);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts['test:quality'], pkg.scripts.test.replace('--test-concurrency=2', '--test-concurrency=4'));
  assert.match(pkg.scripts.test, /--test-concurrency=2\b/);
  assert.throws(() => qualityPlan('npm'), /through npm/);
});

test('independent checks overlap while build dependencies finish in order', async t => {
  const root = fixture(t);
  const plan = [
    [command('test', fsImport + marker('test-start') + waitFor('typecheck-start') + waitFor('audit-start') + marker('test-done'))],
    [command('typecheck', fsImport + marker('typecheck-start') + waitFor('test-start') + marker('typecheck-done')),
      command('validate', fsImport + "if(!existsSync('typecheck-done'))throw Error('early validation');" + marker('validate-done')),
      command('build', fsImport + "if(!existsSync('validate-done'))throw Error('early build');" + marker('build-done'))],
    [command('audit', fsImport + marker('audit-start') + waitFor('test-start') + marker('audit-done'))],
  ];
  const result = await runQualityPlan(plan, { cwd: root });
  assert.equal(result.passed, true); assert.equal(result.checks.length, 5);
  for (const name of ['test', 'typecheck', 'validate', 'build', 'audit']) assert.equal(existsSync(join(root, name + '-done')), true);
});

test('one failed check blocks its dependent build and waits for independent work', async t => {
  const root = fixture(t);
  const result = await runQualityPlan([
    [command('typecheck', 'process.exit(7)'), command('build', fsImport + marker('unexpected-build'))],
    [command('test', fsImport + 'await new Promise(ok=>setTimeout(ok,100));' + marker('test-done'))],
  ], { cwd: root });
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.map(check => check.state), ['failed', 'blocked', 'passed']);
  assert.equal(result.checks[0].exitCode, 7);
  assert.equal(existsSync(join(root, 'test-done')), true); assert.equal(existsSync(join(root, 'unexpected-build')), false);
});

test('spawn errors fail the gate and do not strand an independent check', async t => {
  const root = fixture(t);
  const result = await runQualityPlan([[{ id: 'missing', file: join(root, 'does-not-exist'), args: [] }],
    [command('peer', fsImport + marker('peer-done'))]], { cwd: root });
  assert.equal(result.passed, false); assert.equal(result.checks[0].error, 'ENOENT');
  assert.equal(result.checks[1].state, 'passed'); assert.equal(existsSync(join(root, 'peer-done')), true);
});

test('large output is drained with bounded live logs and a bounded diagnostic tail', async t => {
  const root = fixture(t), events = [];
  const result = await runQualityPlan([[command('noisy', "process.stdout.write('x'.repeat(256*1024)+'final diagnostic');process.stderr.write('stderr');process.exitCode=9;")]],
    { cwd: root, outputLimit: 1024, emit: event => events.push(event) });
  assert.equal(result.passed, false); assert.equal(result.checks[0].exitCode, 9); assert.equal(result.checks[0].truncated, true);
  assert.equal(events.filter(event => event.type === 'output').reduce((sum, event) => sum + event.content.length, 0), 1024);
  const tail = events.find(event => event.type === 'tail').content;
  assert.ok(tail.length <= 64 * 1024); assert.match(tail.toString(), /final diagnostic/);
});

test('arguments containing spaces and shell syntax remain literal', async t => {
  const root = fixture(t), literal = 'literal space & $(not-a-command)';
  const result = await runQualityPlan([[{ id: 'literal', file: process.execPath,
    args: ['--input-type=module', '-e', "import {writeFileSync} from 'node:fs';writeFileSync('args.json',JSON.stringify(process.argv.slice(1)));", literal] }]], { cwd: root });
  assert.equal(result.passed, true); assert.deepEqual(JSON.parse(readFileSync(join(root, 'args.json'))), [literal]);
});

test('explicit cancellation ends the owned child and its descendant and blocks later commands', async t => {
  const root = fixture(t), controller = new AbortController();
  const grandchild = "import {writeFileSync} from 'node:fs';writeFileSync('grandchild.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
  const parent = fsImport + "import {spawn} from 'node:child_process';" +
    `spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(grandchild)}],{stdio:'inherit',shell:false,windowsHide:true});` +
    "writeFileSync('parent.pid',String(process.pid));setInterval(()=>{},1000);";
  const running = runQualityPlan([[command('parent', parent), command('later', fsImport + marker('unexpected-later'))]], { cwd: root, signal: controller.signal });
  const deadline = Date.now() + 8000;
  while (!existsSync(join(root, 'grandchild.pid')) && Date.now() < deadline) await new Promise(ok => setTimeout(ok, 20));
  controller.abort(); const result = await running;
  assert.equal(result.cancelled, true); assert.equal(result.passed, false); assert.equal(result.checks[1].state, 'blocked');
  assert.equal(existsSync(join(root, 'unexpected-later')), false);
  for (const name of ['parent.pid', 'grandchild.pid']) {
    assert.equal(existsSync(join(root, name)), true);
    const pid = Number(readFileSync(join(root, name), 'utf8'));
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  }
});

test('the real tsx quality command schedules four isolated test files', async t => {
  const root = fixture(t), require = createRequire(import.meta.url);
  const tsx = process.env.NOVA_TEST_TSX_CLI ?? join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  const names = [];
  for (let index = 0; index < 4; index++) {
    const name = `worker-${index}.test.mjs`; names.push(name);
    writeFileSync(join(root, name), `import test from 'node:test';import{writeFileSync,readdirSync}from'node:fs';test('four simultaneous isolated test files',async()=>{writeFileSync('ready-${index}','ready');await new Promise((ok,no)=>{const end=Date.now()+8000;const t=setInterval(()=>{if(readdirSync('.').filter(n=>n.startsWith('ready-')).length===4){clearInterval(t);ok();}else if(Date.now()>end){clearInterval(t);no(Error('four files were not scheduled together'));}},10);});});`);
  }
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const output = [];
  const result = await runQualityPlan([[{ id: 'file-workers', file: process.execPath,
    args: [tsx, '--test', '--test-concurrency=4', ...names] }]],
    { cwd: root, env, emit: event => { if (event.type === 'output') output.push(event.content); } });
  const logs = Buffer.concat(output).toString('utf8');
  assert.equal(result.passed, true, logs); assert.match(logs, /# pass 4\b/);
  assert.equal(readdirSync(root).filter(name => name.startsWith('ready-')).length, 4);
});
