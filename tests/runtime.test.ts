import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../apps/service/store.js';
import { ManagedRuntime } from '../apps/service/runtime.js';
import type { AssistantConnection } from '../packages/domain/assistant.js';

test('reconnecting the owned runtime reuses its live process and leaves a healthy connection alone', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-runtime-'));
  const entry = join(directory, 'openclaw.mjs');
  const previous = process.env.E3_OPENCLAW_ENTRY;
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
  // A local readiness fixture, not evidence of the actual OpenClaw provider.
  writeFileSync(entry, `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync('starts.txt', 'started\\n');
const server = createServer((req, res) => { res.writeHead(200); res.end('ready'); });
server.listen(Number(process.env.OPENCLAW_GATEWAY_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  process.env.E3_OPENCLAW_ENTRY = entry;
  const store = new Store(join(directory, 'workspace'));
  let connection: AssistantConnection = { state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false };
  const connections: string[] = [];
  const gateway = {
    status: () => connection,
    configure: async (url: string) => { assert.equal(runtime.status().phase, 'gateway'); assert.equal(runtime.status().state, 'starting'); assert.equal(runtime.status().readyAt, undefined); connections.push(url); connection = { ...connection, state: 'ready', url }; return connection; },
  };
  const runtime = new ManagedRuntime(store, gateway);
  try {
    const starting = runtime.start();
    assert.equal(runtime.status().phase, 'preparing');
    assert.equal((await starting).state, 'running');
    assert.equal(runtime.status().phase, 'ready'); assert.ok(runtime.status().readyAt! >= runtime.status().startedAt!);
    assert.equal(connection.modelAuthReady, false); // Process readiness never grants model access.
    assert.equal(connections.length, 1);
    const signIn = runtime.signInCommand();
    assert.equal(signIn.args[signIn.args.indexOf('--agent') + 1], 'main'); // Native model commands require an owner when the assignment worker is present.
    assert(signIn.args.includes('--device-code'));
    assert(signIn.args.includes('openai:edition3-voice'));
    const browser = runtime.signInCommand('browser'); assert.deepEqual(browser.args, signIn.args.flatMap(arg => arg === '--device-code' ? ['--method', 'oauth'] : [arg]));
    const account = runtime.accountCommand(); assert.deepEqual(account.args, [...signIn.args.slice(0, 3), 'models', 'auth', 'list', '--agent', 'main', '--provider', 'openai', '--json']); assert.deepEqual(account.env, signIn.env);
    assert(!signIn.args.includes('--force')); assert(!signIn.args.includes('--set-default'));
    assert.equal(signIn.env.OPENCLAW_STATE_DIR, join(store.directory, 'openclaw-runtime/state'));
    assert.equal(signIn.env.OPENCLAW_CONFIG_PATH, join(store.directory, 'openclaw-runtime/openclaw.json'));
    assert.equal(runtime.status().canSignIn, true);
    await runtime.start();
    assert.equal(connections.length, 1);
    connection = { ...connection, state: 'disconnected' };
    assert.equal((await runtime.start()).state, 'running');
    assert.equal(connections.length, 2);
    assert.equal(connections[0], connections[1]);
    assert.equal(readFileSync(join(store.directory, 'openclaw-runtime/starts.txt'), 'utf8'), 'started\n');
    connection = { ...connection, url: 'wss://another-host.invalid' };
    assert.equal(runtime.status().canSignIn, false);
    assert.throws(() => runtime.signInCommand(), /Start the Assistant on this host/);
  } finally {
    await runtime.stop(); store.close();
    if (previous === undefined) delete process.env.E3_OPENCLAW_ENTRY; else process.env.E3_OPENCLAW_ENTRY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});


test('stop during initial port allocation prevents a late process and permits a later explicit start', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-runtime-stop-')), previous = process.env.E3_OPENCLAW_ENTRY;
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
  const entry = join(directory, 'openclaw.mjs');
  writeFileSync(entry, `import {appendFileSync} from 'node:fs';import {createServer} from 'node:http';appendFileSync('starts.txt','start\\n');const s=createServer((q,r)=>r.end('ready'));s.listen(Number(process.env.OPENCLAW_GATEWAY_PORT),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`);
  process.env.E3_OPENCLAW_ENTRY = entry; const store = new Store(join(directory, 'workspace')); let configurations = 0;
  const gateway = { status: (): AssistantConnection => ({ state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false }), configure: async () => { configurations++; return gateway.status(); } };
  const runtime = new ManagedRuntime(store, gateway);
  try {
    const starting = runtime.start(), stopping = runtime.stop(); assert.equal(runtime.stop(), stopping); await Promise.all([starting, stopping]);
    assert.equal(runtime.status().state, 'stopped'); assert.equal(configurations, 0); assert.equal(existsSync(join(store.directory, 'openclaw-runtime/starts.txt')), false);
    assert.equal((await runtime.start()).state, 'running'); assert.equal(configurations, 1);
  } finally { await runtime.stop(); store.close(); if (previous === undefined) delete process.env.E3_OPENCLAW_ENTRY; else process.env.E3_OPENCLAW_ENTRY = previous; rmSync(directory, { recursive: true, force: true }); }
});

test('stop during readiness waits for the owned process and prevents a late Gateway connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-runtime-readiness-')), previous = process.env.E3_OPENCLAW_ENTRY;
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
  const entry = join(directory, 'openclaw.mjs');
  writeFileSync(entry, `import {writeFileSync} from 'node:fs';import {createServer} from 'node:http';const s=createServer(()=>{writeFileSync('request-started.txt','started')});s.listen(Number(process.env.OPENCLAW_GATEWAY_PORT),'127.0.0.1');process.on('SIGTERM',()=>{s.closeAllConnections();s.close(()=>process.exit(0))});`);
  process.env.E3_OPENCLAW_ENTRY = entry; const store = new Store(join(directory, 'workspace')); let configurations = 0;
  const gateway = { status: (): AssistantConnection => ({ state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false }), configure: async () => { configurations++; return gateway.status(); } };
  const runtime = new ManagedRuntime(store, gateway);
  try {
    const starting = runtime.start(), marker = join(store.directory, 'openclaw-runtime/request-started.txt');
    // Hold readiness until stop; allow process startup under concurrent test load.
    const deadline = Date.now() + 10000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(marker), true); await runtime.stop(); assert.equal((await starting).state, 'stopped'); assert.equal(configurations, 0); assert.equal(runtime.status().canSignIn, false);
  } finally { await runtime.stop(); store.close(); if (previous === undefined) delete process.env.E3_OPENCLAW_ENTRY; else process.env.E3_OPENCLAW_ENTRY = previous; rmSync(directory, { recursive: true, force: true }); }
});

test('slow startup keeps one owned launch pending until readiness, exit or stop', async () => {
  for (const outcome of ['ready', 'changed-host', 'changed-credential', 'configuration-failure', 'exit', 'stop']) {
    const directory = mkdtempSync(join(tmpdir(), 'edition3-runtime-slow-')), previous = process.env.E3_OPENCLAW_ENTRY;
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
    const entry = join(directory, 'openclaw.mjs');
    writeFileSync(entry, `import {appendFileSync,existsSync} from 'node:fs';import {createServer} from 'node:http';appendFileSync('starts.txt','one\\n');const s=createServer((q,r)=>{if(existsSync('exit.txt'))process.exit(1);r.statusCode=existsSync('ready.txt')?200:503;r.end('readiness');});s.listen(Number(process.env.OPENCLAW_GATEWAY_PORT),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`);
    process.env.E3_OPENCLAW_ENTRY = entry;
    const store = new Store(join(directory, 'workspace')); let configurations = 0;
    let connection: AssistantConnection = { state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false };
    const gateway = { status: () => connection, configure: async (url: string) => { configurations++; if (outcome === 'configuration-failure') throw new Error('Fixture setup rejected'); connection = { ...connection, state: 'ready', url }; return connection; } };
    const runtime = new ManagedRuntime(store, gateway, 50);
    try {
      const starting = runtime.start(), root = join(store.directory, 'openclaw-runtime');
      const until = Date.now() + 10000;
      while ((!existsSync(join(root, 'starts.txt')) || !runtime.status().message.includes('longer')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(runtime.status().state, 'starting'); assert.equal(runtime.status().phase, 'process'); assert.equal(runtime.status().readyAt, undefined); assert.match(runtime.status().message, /longer/);
      assert.equal(runtime.start(), starting); assert.equal(configurations, 0); assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'one\n');
      if (outcome === 'changed-host') { store.internalWrite('gateway:configuration', { url: 'wss://chosen-host.invalid', token: 'fixture-only' }); connection = { ...connection, url: 'wss://chosen-host.invalid', state: 'ready' }; }
      if (outcome === 'changed-credential') { const config = store.internalRead<{ port: number }>('runtime:configuration')!; connection = { ...connection, url: `ws://127.0.0.1:${config.port}`, state: 'error' }; store.internalWrite('gateway:configuration', { url: connection.url, token: 'new-fixture-credential' }); }
      if (outcome === 'stop') await runtime.stop();
      else writeFileSync(join(root, outcome === 'exit' ? 'exit.txt' : 'ready.txt'), 'yes');
      const result = await starting;
      assert.equal(result.state, outcome === 'stop' ? 'stopped' : ['exit', 'configuration-failure'].includes(outcome) ? 'error' : 'running');
      assert.equal(configurations, ['ready', 'configuration-failure'].includes(outcome) ? 1 : 0);
      if (outcome === 'changed-host') assert.equal(connection.url, 'wss://chosen-host.invalid');
      if (outcome === 'changed-credential') assert.equal(store.internalRead<{ token: string }>('gateway:configuration')!.token, 'new-fixture-credential');
      assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'one\n');
    } finally {
      await runtime.stop(); store.close();
      if (previous === undefined) delete process.env.E3_OPENCLAW_ENTRY; else process.env.E3_OPENCLAW_ENTRY = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('an abrupt service exit stops only its IPC-owned runtime, including an unresponsive shutdown', { timeout: 25000 }, async () => {
  for (const ignoreStop of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'edition3-parent-exit-')), token = randomUUID();
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
    writeFileSync(join(directory, 'openclaw.mjs'), `import {writeFileSync} from 'node:fs';import {createServer} from 'node:http';
const port=Number(process.env.OPENCLAW_GATEWAY_PORT);
const server=createServer((q,r)=>{r.end('ready');if(q.url==='/${token}')process.exit(0)});
server.listen(port,'127.0.0.1',()=>writeFileSync('native.json',JSON.stringify({pid:process.pid,port,argv:process.argv,noRespawn:process.env.OPENCLAW_NO_RESPAWN})));
process.on('SIGTERM',()=>{writeFileSync('stop-requested.txt','yes');${ignoreStop ? '' : 'server.close(()=>process.exit(0));'}});
`);
    const parent = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./fixtures/runtime-owner-parent.ts', import.meta.url)), directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let log = '', native: { pid: number; port: number; argv: string[]; noRespawn: string } | undefined;
    parent.stderr?.on('data', data => { log += data.toString(); });
    const exited = once(parent, 'exit');
    try {
      const ready = await Promise.race([once(parent, 'message').then(([value]) => value as { status: { state: string }; native: NonNullable<typeof native> }), exited.then(() => { throw new Error(`Parent fixture exited before readiness: ${log}`); })]);
      native = ready.native;
      assert.equal(ready.status.state, 'running'); assert.equal(native.noRespawn, '1'); assert.equal(native.argv[1], join(directory, 'openclaw.mjs'));
      assert.equal(parent.kill('SIGKILL'), true); await exited;
      const until = Date.now() + 9000;
      let alive = true;
      while (alive && Date.now() < until) { try { process.kill(native.pid, 0); } catch { alive = false; } if (alive) await new Promise(resolve => setTimeout(resolve, 30)); }
      assert.equal(alive, false, `Orphan runtime survived its owner: ${log}`);
      if (process.platform !== 'win32') assert.equal(readFileSync(join(directory, 'workspace/openclaw-runtime/stop-requested.txt'), 'utf8'), 'yes');
      await assert.rejects(fetch(`http://127.0.0.1:${native.port}/healthz`, { signal: AbortSignal.timeout(300) }));
    } finally {
      // The random fixture-only endpoint cannot target an unrelated reused PID.
      if (native) await fetch(`http://127.0.0.1:${native.port}/${token}`, { signal: AbortSignal.timeout(300) }).catch(() => undefined);
      if (parent.exitCode === null && parent.signalCode === null) { parent.send('stop'); await exited; }
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('service relaunch resumes a previously selected managed runtime from its existing persisted intent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edition3-runtime-resume-')), previous = process.env.E3_OPENCLAW_ENTRY;
  const entry = join(directory, 'openclaw.mjs'), workspace = join(directory, 'workspace');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.2' }));
  writeFileSync(entry, `import {appendFileSync} from 'node:fs';import {createServer} from 'node:http';appendFileSync('starts.txt','one\\n');const s=createServer((q,r)=>r.end('ready'));s.listen(Number(process.env.OPENCLAW_GATEWAY_PORT),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`);
  process.env.E3_OPENCLAW_ENTRY = entry;
  let store = new Store(workspace), runtime: ManagedRuntime | undefined;
  const gatewayFor = (current: Store) => {
    let connection: AssistantConnection = { state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false };
    return { status: () => connection, configure: async (url: string, token?: string) => { current.internalWrite('gateway:configuration', { url, token, generation: 'fixture-generation' }); connection = { ...connection, state: 'ready', url }; return connection; } };
  };
  try {
    runtime = new ManagedRuntime(store, gatewayFor(store));
    assert.equal((await runtime.resume()).state, 'stopped', 'new workspace must require an explicit Start');
    assert.equal(existsSync(join(workspace, 'openclaw-runtime')), false);
    assert.equal((await runtime.start()).state, 'running');
    const configuration = store.internalRead('runtime:configuration'), selection = store.internalRead('gateway:configuration');
    await runtime.stop(); store.close();
    store = new Store(workspace); runtime = new ManagedRuntime(store, gatewayFor(store));
    assert.equal(runtime.status().state, 'stopped');
    const resumed = runtime.resume(); assert.equal(runtime.resume(), resumed, 'concurrent resumes join the same launch');
    assert.equal((await resumed).state, 'running'); assert.equal(runtime.status().canSignIn, true);
    assert.deepEqual(store.internalRead('runtime:configuration'), configuration); assert.deepEqual(store.internalRead('gateway:configuration'), selection);
    await runtime.resume(); assert.equal(readFileSync(join(workspace, 'openclaw-runtime/starts.txt'), 'utf8'), 'one\none\n');
  } finally { await runtime?.stop(); store.close(); if (previous === undefined) delete process.env.E3_OPENCLAW_ENTRY; else process.env.E3_OPENCLAW_ENTRY = previous; rmSync(directory, { recursive: true, force: true }); }
});

test('automatic resume never starts an unselected runtime or replaces another host or credential', async () => {
  for (const selection of [undefined, { url: 'wss://selected-host.invalid', token: 'fixture-token' }, { url: 'ws://127.0.0.1:41239', token: 'changed-token' }, { url: 'ws://127.0.0.1:41240', token: 'fixture-token' }]) {
    const directory = mkdtempSync(join(tmpdir(), 'edition3-runtime-resume-skip-')), store = new Store(directory);
    store.internalWrite('runtime:configuration', { port: 41239, token: 'fixture-token', entry: '/unused/openclaw.mjs' });
    if (selection) store.internalWrite('gateway:configuration', selection);
    let configurations = 0;
    const gateway = { status: (): AssistantConnection => ({ state: 'disconnected', message: '', methods: [], grantedScopes: [], modelAuthReady: false }), configure: async () => { configurations++; return gateway.status(); } };
    const runtime = new ManagedRuntime(store, gateway);
    try { assert.equal((await runtime.resume()).state, 'stopped'); assert.equal(configurations, 0); assert.equal(existsSync(join(directory, 'openclaw-runtime')), false); assert.deepEqual(store.internalRead('gateway:configuration'), selection); }
    finally { await runtime.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
