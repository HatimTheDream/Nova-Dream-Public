import type { ConnectedAccount } from '../../../../packages/domain/accounts';
import type { MailIndexCommand, MailIndexRead, MailIndexResult } from '../../../../packages/domain/mail-index';
import { ApiError, request } from '../api';
import type { NativeMailIndexProvider, NativeMailIndexSnapshot } from './services/native/mailIndex';

export type InboxIndexTransport = {
  read(input: MailIndexRead, signal: AbortSignal): Promise<MailIndexResult>;
  command(input: MailIndexCommand, signal: AbortSignal): Promise<MailIndexResult>;
  pollMs?: number;
};
export const inboxIndexTransport: InboxIndexTransport = {
  read: (input, signal) => request('mail/index/read', input, signal, 35000),
  command: (input, signal) => request('mail/index/command', input, signal, 35000),
};
type Identity = { provider: NativeMailIndexProvider; accountId: string };
type Cached = { revision: string; runId?: string; snapshot: NativeMailIndexSnapshot };

/** The original index API over the account-scoped Nova Dream service. */
export function createInboxIndexApi(epoch: string, account: (provider: ConnectedAccount['provider'], id: string) => ConnectedAccount, signal: AbortSignal, transport: InboxIndexTransport) {
  const cache = new Map<string, Cached>(), watched = new Map<string, ConnectedAccount>();
  const reads = new Map<string, Promise<Cached>>(), commands = new Map<string, Promise<Cached>>();
  const listeners = new Set<(snapshot: NativeMailIndexSnapshot) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined, polling = false;
  const current = () => signal.throwIfAborted();
  const owner = (input: Identity) => {
    current();
    const value = account(input.provider === 'gmail' ? 'google' : 'microsoft', input.accountId);
    watched.set(value.id, value); schedule(); return value;
  };
  const identity = (value: ConnectedAccount) => ({ epoch, accountId: value.id, generation: value.generation });
  const accept = (value: ConnectedAccount, result: MailIndexResult): Cached => {
    current();
    const previous = cache.get(value.id);
    if (result.accountId !== value.id || result.generation !== value.generation) throw new Error('The returned index belongs to another mail connection. Reopen Inbox.');
    const revision = result.revision === 'none' && !result.runId ? 0 : Number(result.revision.slice((result.runId?.length ?? 0) + 1));
    if (!Number.isSafeInteger(revision) || revision < 0 || (result.revision !== 'none' && (!result.runId || result.revision !== `${result.runId}.${revision}`))) throw new Error('The returned index revision is invalid. Refresh Inbox.');
    if (previous && revision <= (previous.snapshot.indexRevision ?? 0)) return previous;
    if (result.unchanged || !result.snapshot) throw new Error('The current index could not be read. Refresh Inbox.');
    const snapshot = result.snapshot;
    if (snapshot.accountId !== value.id || snapshot.provider !== (value.provider === 'google' ? 'gmail' : 'microsoft') || snapshot.query !== 'inbox') throw new Error('The returned index belongs to another Inbox.');
    const next = { revision: result.revision, runId: result.runId, snapshot: { ...snapshot, indexRevision: revision } };
    cache.set(value.id, next);
    listeners.forEach(listener => listener(next.snapshot));
    return next;
  };
  const read = (value: ConnectedAccount) => {
    const revision = cache.get(value.id)?.revision, key = value.id + ':' + revision;
    let pending = reads.get(key);
    if (!pending) {
      pending = transport.read({ ...identity(value), ...(revision ? { revision } : {}) }, signal).then(result => accept(value, result));
      reads.set(key, pending);
      void pending.finally(() => reads.delete(key)).catch(() => {});
    }
    return pending;
  };
  function schedule() {
    if (timer || polling || !listeners.size || !watched.size || signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined; polling = true;
      void Promise.allSettled([...watched.values()].map(read)).finally(() => { polling = false; schedule(); });
    }, transport.pollMs ?? 1500);
  }
  const command = (value: ConnectedAccount, action: 'sync' | 'pause', mode?: 'resume' | 'refresh' | 'rebuild') => {
    // Serialize controls for this account, so pause is bound to the run it follows.
    const previous = commands.get(value.id);
    const pending = (async () => {
      if (previous) await previous.catch(() => {});
      current();
      const known = cache.get(value.id) ?? await read(value);
      if (action === 'pause' && !known.runId) return known;
      const input: MailIndexCommand = action === 'pause'
        ? { ...identity(value), requestId: crypto.randomUUID(), action, expectedRunId: known.runId! }
        : { ...identity(value), requestId: crypto.randomUUID(), action, mode: mode!, ...(known.runId ? { expectedRunId: known.runId } : {}) };
      let result: MailIndexResult;
      try { result = await transport.command(input, signal); }
      catch (error) {
        current();
        if (error instanceof ApiError) throw error;
        // A lost response must retry the exact receipt, not admit a second refresh.
        result = await transport.command(input, signal);
      }
      return accept(value, result);
    })();
    commands.set(value.id, pending);
    void pending.finally(() => { if (commands.get(value.id) === pending) commands.delete(value.id); }).catch(() => {});
    return pending;
  };
  const safe = async (run: () => Promise<Cached>) => {
    try { const result = await run(); current(); return { success: true, snapshot: result.snapshot }; }
    catch (error) { current(); return { success: false, error: error instanceof Error ? error.message : 'The mail index could not be loaded.' }; }
  };
  signal.addEventListener('abort', () => { if (timer) clearTimeout(timer); timer = undefined; listeners.clear(); watched.clear(); cache.clear(); }, { once: true });
  return {
    getSnapshot: (input: Identity) => safe(() => read(owner(input))),
    sync: (input: Identity & { mode: 'resume' | 'refresh' | 'rebuild' }) => safe(() => command(owner(input), 'sync', input.mode)),
    pause: (input: Identity) => safe(() => command(owner(input), 'pause')),
    onProgress(callback: (snapshot: NativeMailIndexSnapshot) => void) {
      current(); listeners.add(callback); schedule();
      return () => { listeners.delete(callback); if (!listeners.size && timer) { clearTimeout(timer); timer = undefined; } };
    },
  };
}
