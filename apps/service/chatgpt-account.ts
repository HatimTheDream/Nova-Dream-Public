import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { ChatGptAccountStatus } from '../../packages/domain/sign-in.js';
import type { ManagedRuntime } from './runtime.js';

const unavailable = (): ChatGptAccountStatus => ({ state: 'unavailable', emails: [], profileCount: 0, message: 'Saved ChatGPT accounts could not be checked on this host.' });
const profile = z.object({ id: z.string().min(1).max(512), provider: z.literal('openai'), type: z.string(), email: z.string().email().max(254).optional() });
/** This is saved-account metadata, never a claim about a past run's effective identity. */
export function readChatGptAccount(output: string): ChatGptAccountStatus {
  const result = z.object({ agentId: z.literal('main'), provider: z.literal('openai'), profiles: z.array(profile).max(100) }).parse(JSON.parse(output));
  if (new Set(result.profiles.map(p => p.id)).size !== result.profiles.length) throw Error('Ambiguous account metadata.');
  const profiles = result.profiles.filter(p => p.type === 'oauth');
  return { state: profiles.length ? 'available' : 'empty', emails: [...new Set(profiles.flatMap(p => p.email ? [p.email] : []))].sort(), profileCount: profiles.length,
    message: profiles.length ? 'Saved in Nova’s connection. Signing into Codex separately does not switch these accounts.' : 'No ChatGPT account is saved in this host’s connection.' };
}
type Command = ReturnType<ManagedRuntime['accountCommand']>;
type ReadCommand = (command: Command, signal: AbortSignal) => Promise<string>;
const readCommand: ReadCommand = (command, signal) => new Promise((resolve, reject) => {
  execFile(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false, windowsHide: true, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8', signal }, (error, stdout) => error ? reject(Error('Account metadata unavailable.')) : resolve(stdout));
});

/** A bounded, coalesced read through the native owner's public CLI. No credentials persist here. */
export class ChatGptAccount {
  private cache?: { until: number; value: ChatGptAccountStatus };
  private pending?: Promise<ChatGptAccountStatus>;
  private abort = new AbortController();
  constructor(private runtime: Pick<ManagedRuntime, 'accountCommand'>, private run: ReadCommand = readCommand, private now = Date.now) {}
  async read(refresh = false): Promise<ChatGptAccountStatus> {
    if (this.abort.signal.aborted) return unavailable();
    let command: Command;
    try { command = this.runtime.accountCommand(); } catch { this.cache = undefined; return unavailable(); }
    if (this.pending) return this.pending;
    if (!refresh && this.cache && this.cache.until > this.now()) return this.cache.value;
    const pending = this.run(command, this.abort.signal).then(readChatGptAccount).catch(unavailable).then(value => {
      // An owned-host change during the CLI read must not expose an old host's label.
      try { if (JSON.stringify(this.runtime.accountCommand()) !== JSON.stringify(command)) return unavailable(); } catch { return unavailable(); }
      if (this.abort.signal.aborted) return unavailable();
      this.cache = { until: this.now() + 30000, value }; return value;
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending; return pending;
  }
  async close() { this.abort.abort(); await this.pending; this.cache = undefined; }
}
