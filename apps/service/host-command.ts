import { spawn } from 'node:child_process';

/** Finite host commands: no shell interpolation or inherited service credentials. */
export function hostEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TMPDIR','TEMP','TMP','LANG']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, LANG: 'C.UTF-8', ...extra };
}
export type HostCommand = (executable: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string|Buffer; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; output?: (chunk: string) => void }) => Promise<Buffer>;
export const hostCommand: HostCommand = (executable, args, options = {}) => new Promise((accept, reject) => {
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? hostEnvironment(), shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const chunks: Buffer[] = []; let bytes = 0, failure: Error|undefined, force: ReturnType<typeof setTimeout>|undefined;
  const stop = (reason: string) => { failure ??= Error(reason); child.kill('SIGTERM'); force ??= setTimeout(() => child.kill('SIGKILL'), 1000); force.unref(); };
  const aborted = () => stop('The host operation was cancelled.');
  const timer = setTimeout(() => stop('The host operation timed out. Review its state before trying again.'), options.timeoutMs ?? 30000); timer.unref();
  options.signal?.addEventListener('abort', aborted, { once: true });
  const data = (chunk: Buffer, stdout: boolean) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 2*1024*1024)) { stop('The host response exceeded its limit.'); return; } options.output?.(chunk.toString('utf8')); if (stdout) chunks.push(chunk); };
  child.stdout.on('data', chunk => data(chunk, true)); child.stderr.on('data', chunk => data(chunk, false));
  child.on('error', error => { failure = error; });
  child.on('close', code => { clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', aborted); if (failure) reject(failure); else if (code !== 0) reject(Error(`The ${executable === 'git' ? 'Git' : 'host'} command could not complete (exit ${code}).`)); else accept(Buffer.concat(chunks)); });
  child.stdin.on('error', () => {}); child.stdin.end(options.input);
  if (options.signal?.aborted) aborted();
});
