import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const TAIL_LIMIT = 64 * 1024;

// Keep the existing scripts and their coverage. Tests use source and isolated
// fixtures; only the build lane writes the application's dist directory.
export function qualityPlan(npmCli) {
  if (!isAbsolute(npmCli) || !existsSync(npmCli)) throw new Error('Run quality through npm with its existing npm CLI.');
  const command = id => ({ id, file: process.execPath, args: [npmCli, 'run', id === 'test' ? 'test:quality' : id] });
  return [[command('test')], [command('typecheck'), command('validate:release'), command('build')], [command('security:audit')]];
}

function killOwnedTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    // npm launches its trusted package scripts as children. Kill only the tree
    // rooted at this invocation's actual PID on explicit operator cancellation.
    return new Promise(resolveKill => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolveKill(); });
      killer.once('close', resolveKill);
    });
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  return new Promise(resolveKill => {
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      resolveKill();
    }, 2000);
    // Keep the grace period even if the npm parent exits first: a descendant
    // that ignores SIGTERM must not survive cancellation of this owned group.
  });
}

function runCommand(command, { cwd, env, signal, emit, outputLimit, clock }) {
  const started = clock();
  emit({ type: 'start', id: command.id, elapsedMs: 0 });
  return new Promise(resolveCommand => {
    let child;
    try {
      child = spawn(command.file, command.args, { cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const result = { id: command.id, state: 'failed', exitCode: null, signal: null, error: error.code ?? error.message,
        elapsedMs: Math.round(clock() - started), outputBytes: 0, truncated: false };
      emit({ type: 'finish', ...result }); resolveCommand(result); return;
    }
    let emitted = 0, total = 0, tail = Buffer.alloc(0), spawnError = null, stopped = null;
    const receive = (stream, bytes) => {
      total += bytes.length;
      tail = Buffer.concat([tail, bytes]).subarray(-TAIL_LIMIT);
      const remaining = Math.max(0, outputLimit - emitted);
      if (remaining) {
        const content = bytes.subarray(0, remaining); emitted += content.length;
        emit({ type: 'output', id: command.id, stream, content });
      }
    };
    child.stdout.on('data', bytes => receive('stdout', bytes));
    child.stderr.on('data', bytes => receive('stderr', bytes));
    child.once('error', error => { spawnError = error.code ?? error.message; });
    const abort = () => { stopped ??= killOwnedTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('close', async (exitCode, processSignal) => {
      signal?.removeEventListener('abort', abort);
      if (stopped) await stopped;
      const result = { id: command.id, state: signal?.aborted ? 'cancelled' : spawnError || exitCode !== 0 ? 'failed' : 'passed',
        exitCode, signal: processSignal, error: spawnError, elapsedMs: Math.round(clock() - started), outputBytes: total, truncated: total > emitted };
      if (result.truncated) emit({ type: 'tail', id: command.id, content: tail });
      emit({ type: 'finish', ...result }); resolveCommand(result);
    });
    if (signal?.aborted) abort();
  });
}

export async function runQualityPlan(plan, { cwd = process.cwd(), env = process.env, signal,
  emit = () => {}, outputLimit = OUTPUT_LIMIT, clock = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 0 || outputLimit > OUTPUT_LIMIT) throw new Error('Invalid quality output limit.');
  const names = plan.flat().map(command => command.id);
  if (!plan.length || plan.some(lane => !lane.length) || new Set(names).size !== names.length) throw new Error('Quality checks must be unique and nonempty.');
  const started = clock();
  const lanes = await Promise.all(plan.map(async lane => {
    const results = [];
    for (const command of lane) {
      if (signal?.aborted || results.some(result => result.state !== 'passed')) {
        results.push({ id: command.id, state: 'blocked', elapsedMs: 0 });
      } else results.push(await runCommand(command, { cwd, env, signal, emit, outputLimit, clock }));
    }
    return results;
  }));
  const checks = lanes.flat();
  return { kind: 'nova-quality-result', passed: checks.every(check => check.state === 'passed'),
    cancelled: signal?.aborted ?? false, elapsedMs: Math.round(clock() - started), checks };
}

export async function qualityMain() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const plan = qualityPlan(process.env.npm_execpath ?? '');
    const result = await runQualityPlan(plan, { signal: controller.signal, emit: event => {
      if (event.type === 'output') (event.stream === 'stderr' ? process.stderr : process.stdout).write(event.content);
      else if (event.type === 'tail') process.stdout.write(`\n[quality:${event.id}] Output limit reached; final output follows:\n${event.content.toString('utf8')}\n`);
      else process.stdout.write(`\n[quality:${event.id}] ${event.type === 'start' ? 'started' : `${event.state} in ${(event.elapsedMs / 1000).toFixed(2)}s`}\n`);
    } });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.cancelled ? 130 : result.passed ? 0 : 1;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await qualityMain(); }
  catch (error) { process.stderr.write(`Quality runner failed: ${error.message}\n`); process.exitCode = 1; }
}
