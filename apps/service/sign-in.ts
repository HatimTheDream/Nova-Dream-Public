import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { spawn, type IPty } from 'node-pty';
import { z } from 'zod';
import { assistantRequestSchema } from '../../packages/domain/assistant.js';
import type { ChatGptSignInStatus } from '../../packages/domain/sign-in.js';
import { Fault, Store } from './store.js';
import type { ManagedRuntime } from './runtime.js';

const key = 'signin:chatgpt:current';
const loginUrl = 'https://auth.openai.com/codex/device';
const active = (state: ChatGptSignInStatus['state']) => state === 'starting' || state === 'waiting';
type Attempt = Omit<ChatGptSignInStatus, 'userCode' | 'verificationUrl' | 'authorizationUrl'> & { id: string; startedAt: number; pid?: number };
type Terminal = Pick<IPty, 'pid' | 'onData' | 'onExit' | 'kill'>;
type TerminalFactory = (command: ReturnType<ManagedRuntime['signInCommand']>) => Terminal;
const startSchema = assistantRequestSchema.extend({ method: z.enum(['browser', 'device-code']).optional() }).strict();

/** Only complete pinned CLI authorization output. OAuth state/PKCE remain native-owned. */
export function browserSignInNote(output: string): { authorizationUrl: string } | undefined {
  const plain = stripVTControlCharacters(output);
  const raw = /(?:^|[\r\n│|])\s*Open:[ \t]*(https:\/\/[^\s│|]+)[ \t]*(?=[\r\n│|])/.exec(plain)?.[1]
    // OpenClaw 2026.9.2 prints this separate, unwrapped log on headless hosts.
    ?? /(?:^|[\r\n])[ \t]*Open this URL in your LOCAL browser:[ \t]*\r?\n[ \t]*\r?\n[ \t]*(https:\/\/[^\s│|]+)[ \t]*(?=[\r\n])/.exec(plain)?.[1];
  if (!raw || raw.length > 8192) return;
  try {
    const url = new URL(raw), q = url.searchParams;
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash) return;
    if ([...q.keys()].some(k => q.getAll(k).length !== 1) || ['access_token', 'refresh_token', 'id_token', 'code'].some(k => q.has(k))) return;
    if (q.get('response_type') !== 'code' || !q.get('client_id') || q.get('redirect_uri') !== 'http://localhost:1455/auth/callback' || q.get('code_challenge_method') !== 'S256') return;
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.get('code_challenge') ?? '') || !/^[A-Za-z0-9_-]{16,256}$/.test(q.get('state') ?? '')) return;
    return { authorizationUrl: url.href };
  } catch { return; }
}

/** Parse only the pinned CLI's code note. No raw terminal output reaches clients or logs. */
export function deviceCodeNote(output: string): { verificationUrl: string; userCode: string } | undefined {
  const plain = stripVTControlCharacters(output);
  if (!/(?:^|[\r\n│|])\s*URL:\s*https:\/\/auth\.openai\.com\/codex\/device(?=\s|[│|]|$)/.test(plain)) return;
  // OpenClaw forwards OpenAI's user_code without imposing a fixed 4–4 shape.
  const code = /(?:^|[\r\n│|])\s*Code:\s*([A-Z0-9]{3,10}(?:-[A-Z0-9]{3,10}){1,2})\s*(?:[│|\r\n]|$)/.exec(plain)?.[1];
  if (code) return { verificationUrl: loginUrl, userCode: code };
}

/** Fixed messages only: provider output may contain secrets or arbitrary errors. */
export function signInProgress(output: string): string | undefined {
  const plain = stripVTControlCharacters(output);
  if (plain.includes('OpenAI device code request failed')) return 'OpenAI could not issue a sign-in code. Review its account setup before trying again.';
  if (plain.includes('OpenAI device code login is not enabled')) return 'Device sign-in is unavailable for this account. Stop this attempt and choose browser sign-in.';
  if (plain.includes('OAuth prerequisites') && /TLS|certificates/.test(plain)) return 'This host could not verify OpenAI’s secure connection. Review the local runtime before trying again.';
  if (plain.includes('callback_validation_failed')) return 'OpenAI’s browser callback could not be verified. Start a new sign-in.';
  if (plain.includes('Select an auth method') || plain.includes('Select a provider')) return 'OpenClaw is waiting for a setup choice that this guided sign-in cannot answer.';
  if (plain.includes('Starting device code flow')) return 'OpenClaw is requesting a sign-in code from OpenAI…';
  if (plain.includes('Provider sign-in')) return 'OpenClaw has selected this host’s account setup…';
  return undefined;
}

/** Owns one fixed-purpose CLI sign-in; never exposes a shell or imports private OpenClaw modules. */
export class ChatGptSignIn {
  private terminal?: Terminal;
  private output = '';
  private code?: { verificationUrl: string; userCode: string } | { authorizationUrl: string };
  private timer?: ReturnType<typeof setTimeout>;
  private exited?: Promise<void>;
  private closed = false;
  private stopping = false;
  private stopMessage?: string;
  constructor(private store: Store, private runtime: Pick<ManagedRuntime, 'signInCommand'>, private createTerminal: TerminalFactory = command => spawn(command.file, command.args, { cwd: command.cwd, env: { ...command.env, TERM: 'xterm', NO_COLOR: '1', FORCE_COLOR: '0' } as Record<string, string>, name: 'xterm', cols: 120, rows: 32 })) {
    const old = this.current();
    if (old && active(old.state)) this.save({ ...old, state: 'interrupted', message: 'The service restarted before sign-in was confirmed. Check the account connection.' });
  }
  private current() { const id = this.store.internalRead<string>(key); return id ? this.store.internalRead<Attempt>(`signin:chatgpt:${id}`) : undefined; }
  private save(value: Attempt) { this.store.internalWrite(`signin:chatgpt:${value.id}`, value); this.store.internalWrite(key, value.id); return value; }
  status(id?: string): ChatGptSignInStatus {
    const current = id ? this.store.internalRead<Attempt>(`signin:chatgpt:${id}`) : this.current();
    if (!current) return { state: 'idle', message: 'Sign in to ChatGPT on this host for Assistant, agents and voice.' };
    const { pid, startedAt, ...status } = current;
    return { ...status, ...(current.id === this.current()?.id && current.state === 'waiting' && current.expiresAt! > Date.now() ? this.code : {}) };
  }
  start(device: string, raw: unknown) {
    const input = startSchema.parse(raw);
    if (this.closed) throw new Fault(503, 'signin_closed', 'Sign-in is unavailable while the host is closing.');
    let command: ReturnType<ManagedRuntime['signInCommand']> | undefined;
    const admitted = this.store.admit(device, input, { type: 'chatgpt.signin', ...input }, () => {
      const previous = this.current();
      if (this.terminal || previous && active(previous.state)) throw new Fault(409, 'signin_active', 'A ChatGPT sign-in is already waiting on this host.');
      if (previous?.state === 'interrupted' && previous.pid) {
        try { process.kill(previous.pid, 0); throw new Fault(409, 'signin_process_present', 'The earlier sign-in process is still present. Finish or close that OpenClaw sign-in before starting another.'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
      }
      command = this.runtime.signInCommand(input.method ?? 'device-code');
      return this.save({ id: randomUUID(), ...(input.method ? { method: input.method } : {}), state: 'starting', startedAt: Date.now(), message: input.method === 'browser' ? 'Opening secure ChatGPT sign-in…' : 'Requesting a ChatGPT sign-in code…' });
    });
    if (!admitted.fresh) return this.status(admitted.value.id);
    const attempt = admitted.value;
    try {
      const terminal = this.createTerminal(command!);
      this.terminal = terminal; this.stopping = false; this.stopMessage = undefined; this.output = ''; this.code = undefined;
      this.save({ ...attempt, pid: terminal.pid });
      this.exited = new Promise<void>(resolve => {
        terminal.onExit(result => {
          if (this.terminal !== terminal) { resolve(); return; }
          const progress = signInProgress(this.output);
          clearTimeout(this.timer); this.output = ''; this.code = undefined;
          if (!this.closed && this.current()?.id === attempt.id) this.save({ ...this.current()!, state: this.stopping ? 'interrupted' : result.exitCode === 0 ? 'completed' : 'failed', message: this.stopping ? this.stopMessage ?? 'Sign-in stopped. Check the connection in case account setup already completed.' : result.exitCode === 0 ? 'OpenClaw confirmed ChatGPT sign-in. Check account and model access.' : progress?.includes('could not') || progress?.includes('unavailable') ? progress : 'OpenClaw did not confirm sign-in. You can try again or review its account setup.' });
          if (this.terminal === terminal) this.terminal = undefined;
          resolve();
        });
      });
      terminal.onData(chunk => {
        if (this.closed || this.stopping || this.current()?.id !== attempt.id) return;
        this.output = (this.output + chunk).slice(-32768);
        const note = attempt.method === 'browser' ? browserSignInNote(this.output) : deviceCodeNote(this.output);
        const progress = signInProgress(this.output);
        if (!note && !this.code && progress && progress !== this.current()?.message) this.save({ ...this.current()!, message: progress });
        if (note && !this.code) {
          this.code = note;
          this.save({ ...this.current()!, state: 'waiting', expiresAt: Date.now() + 15 * 60000, message: attempt.method === 'browser' ? 'Finish sign-in in your browser on this computer. Waiting for OpenAI’s callback…' : 'Open ChatGPT and enter this code to connect your account.' });
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { if (!this.closed && this.current()?.id === attempt.id) void this.stopAttempt(); }, 15 * 60000);
        }
      });
      this.timer = setTimeout(() => { if (!this.closed && this.current()?.id === attempt.id) void this.stopAttempt('OpenClaw did not provide a usable sign-in link or code in time. Check its account setup before starting another sign-in.'); }, 90000);
    } catch {
      this.save({ ...attempt, state: 'failed', message: 'The host could not start OpenClaw sign-in. Review the local runtime setup.' });
    }
    return this.status();
  }
  async cancel(device: string, raw: unknown) {
    const input = assistantRequestSchema.extend({ attemptId: assistantRequestSchema.shape.requestId }).strict().parse(raw);
    const admitted = this.store.admit(device, input, { type: 'chatgpt.signin.cancel', ...input }, () => {
      if (this.current()?.id !== input.attemptId) throw new Fault(409, 'signin_changed', 'A different sign-in is now selected. Review its current status.');
      return { attemptId: input.attemptId };
    });
    if (admitted.fresh) await this.stopAttempt();
    return this.status(input.attemptId);
  }
  private async stopAttempt(message?: string) {
    const terminal = this.terminal;
    if (!terminal) return;
    this.stopping = true; this.stopMessage = message; this.code = undefined; clearTimeout(this.timer);
    const current = this.current();
    if (current && active(current.state)) this.save({ ...current, state: 'interrupted', message: 'Stopping sign-in. Check the connection in case account setup already completed.' });
    try { terminal.kill('SIGTERM'); } catch { /* Exit may have won the race. */ }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2500); })]);
    clearTimeout(timeout);
    if (this.terminal === terminal) {
      try { terminal.kill('SIGKILL'); } catch { /* Exact owned child only. */ }
      await Promise.race([this.exited, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2500); })]);
      clearTimeout(timeout);
    }
  }
  async close() { await this.stopAttempt(); this.closed = true; this.output = ''; this.code = undefined; clearTimeout(this.timer); }
}
