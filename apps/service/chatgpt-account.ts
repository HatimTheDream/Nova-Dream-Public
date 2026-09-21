import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { ChatGptAccount as Account, ChatGptAccountStatus } from '../../packages/domain/sign-in.js';
import { chatGptAccountOrderSchema, chatGptProfileIdSchema, chatGptRuntimeSnapshotSchema, chatGptUsageFreshMs, emptyChatGptUsage } from '../../packages/domain/chatgpt-accounts.js';
import type { ManagedRuntime } from './runtime.js';
import type { AssistantTransport } from './gateway.js';
import { Fault, type Store } from './store.js';

const unavailable = (): ChatGptAccountStatus => ({ state: 'unavailable', emails: [], profileCount: 0, accounts: [], order: [], preferredProfileId: null, canManage: false, message: 'Saved ChatGPT accounts could not be checked on this host.' });
const profile = z.object({ id: chatGptProfileIdSchema, provider: z.literal('openai'), type: z.string(), email: z.string().email().max(254).optional(), expiresAt: z.string().optional(), cooldownUntil: z.string().optional(), disabledUntil: z.string().optional() });
const nativeAccountsSchema = z.object({ agentId: z.literal('main'), provider: z.literal('openai'), profiles: z.array(profile).max(100) });
const timestamp = (v?: string) => v && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Saved-account metadata is never a claim about a past run's effective identity. */
export function readChatGptAccount(output: string, now = Date.now()): ChatGptAccountStatus {
  const result = nativeAccountsSchema.parse(JSON.parse(output));
  if (new Set(result.profiles.map(p => p.id)).size !== result.profiles.length) throw Error('Ambiguous account metadata.');
  const profiles = result.profiles.filter(p => p.type === 'oauth');
  const accounts: Account[] = profiles.map(p => ({ profileId: p.id, label: p.email ?? 'ChatGPT Account', ...(p.email ? { email: p.email } : {}), health: (timestamp(p.disabledUntil) ?? 0) > now ? 'reconnect' : (timestamp(p.cooldownUntil) ?? 0) > now ? 'cooldown' : 'unknown', cooldownUntil: timestamp(p.cooldownUntil), expiresAt: timestamp(p.expiresAt), usage: emptyChatGptUsage() }));
  return { state: accounts.length ? 'available' : 'empty', emails: [...new Set(profiles.flatMap(p => p.email ? [p.email] : []))].sort(), profileCount: profiles.length, checkedAt: now, accounts, order: accounts.map(a => a.profileId), preferredProfileId: null, canManage: false,
    message: profiles.length ? 'Connected accounts power Nova. Your conversations stay in Nova.' : 'No ChatGPT account is saved in this host’s connection.' };
}
type Command = ReturnType<ManagedRuntime['accountCommand']>;
type ReadCommand = (command: Command, signal: AbortSignal) => Promise<string>;
const readCommand: ReadCommand = (command, signal) => new Promise((resolve, reject) => {
  execFile(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false, windowsHide: true, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8', signal }, (error, stdout) => error ? reject(Error('Account metadata unavailable.')) : resolve(stdout));
});
type OrderControl = { request<T>(method: 'models.authOrderSet', params: unknown, beforeSend?: () => void): Promise<T> };
type OrderReceipt = { requestId: string; generation: string; profileIds: string[]; nativeIds: string[]; state: 'prepared' | 'sending' | 'confirmed' | 'unknown' | 'not-sent' };
type Options = { store: Store; gateway: AssistantTransport; control?: OrderControl; busy?: () => boolean };
export type ChatGptAccountRoute = { profileId: string; label: string; reason: 'preferred' | 'backup'; identityKey?: string; checkedAt: number };

/** Bounded reads through the native owner's public CLI and credential-isolated usage adapter. */
export class ChatGptAccount {
  private cache?: { until: number; fingerprint: string; value: ChatGptAccountStatus };
  private pending?: Promise<ChatGptAccountStatus>;
  private abort = new AbortController();
  private ordering?: Promise<ChatGptAccountStatus>;
  constructor(private runtime: Pick<ManagedRuntime, 'accountCommand'> & Partial<Pick<ManagedRuntime, 'accountOrderCommand'>>, private run: ReadCommand = readCommand, private now = Date.now, private options?: Options) {}
  private fingerprint(command: Command) { return JSON.stringify([command, this.options?.gateway.status().generation, this.options?.gateway.status().url]); }
  async read(refresh = false): Promise<ChatGptAccountStatus> {
    if (this.abort.signal.aborted) return unavailable();
    let command: Command;
    try { command = this.runtime.accountCommand(); } catch { this.cache = undefined; return unavailable(); }
    const fingerprint = this.fingerprint(command);
    if (this.pending) return this.pending;
    if (!refresh && this.cache && this.cache.fingerprint === fingerprint && this.cache.until > this.now()) return this.cache.value;
    const pending = (async () => {
      const state = this.options?.gateway.status();
      const [metadata, ordered, exact] = await Promise.allSettled([
        this.run(command, this.abort.signal),
        this.runtime.accountOrderCommand ? this.run(this.runtime.accountOrderCommand(), this.abort.signal) : Promise.resolve(undefined),
        state?.state === 'ready' && state.methods.includes('e3.accounts.snapshot') ? this.options!.gateway.request('e3.accounts.snapshot', { epoch: this.options!.store.epoch, refresh }) : Promise.resolve(undefined),
      ]);
      try { if (this.abort.signal.aborted || this.fingerprint(this.runtime.accountCommand()) !== fingerprint) return unavailable(); } catch { return unavailable(); }
      if (metadata.status !== 'fulfilled') return unavailable();
      const value = readChatGptAccount(metadata.value, this.now()), accounts = value.accounts!;
      let nativeOrder: string[] | undefined;
      if (ordered.status === 'fulfilled' && ordered.value) {
        const parsed = z.object({ agentId: z.literal('main'), provider: z.literal('openai'), order: z.array(chatGptProfileIdSchema).max(100).nullable() }).safeParse(JSON.parse(ordered.value));
        if (parsed.success) nativeOrder = parsed.data.order ?? undefined;
      }
      if (exact.status === 'fulfilled' && exact.value) {
        const parsed = chatGptRuntimeSnapshotSchema.safeParse(exact.value);
        if (parsed.success && parsed.data.epoch === this.options?.store.epoch) {
          const snapshot = parsed.data;
          for (const account of accounts) {
            const match = snapshot.accounts.find(a => a.profileId === account.profileId);
            if (!match || account.email && match.email && account.email.toLowerCase() !== match.email.toLowerCase()) continue;
            Object.assign(account, match, { label: match.email ?? account.label });
          }
          nativeOrder ??= snapshot.order.length ? snapshot.order : undefined;
        }
      }
      const order = [...(nativeOrder ?? []).filter(id => accounts.some(a => a.profileId === id)), ...accounts.map(a => a.profileId).filter(id => !nativeOrder?.includes(id))];
      const identities = new Map<string, string>();
      for (const id of order) {
        const account = accounts.find(a => a.profileId === id)!;
        if (!account.identityKey) continue;
        const first = identities.get(account.identityKey);
        if (first) account.duplicateOf = first;
        else identities.set(account.identityKey, id);
      }
      value.accounts = order.map(id => accounts.find(a => a.profileId === id)!); value.order = order;
      value.preferredProfileId = nativeOrder?.find(id => accounts.some(a => a.profileId === id)) ?? null;
      value.canManage = !!this.options?.control && state?.state === 'ready' && state.methods.includes('models.authOrderSet');
      this.cache = { until: this.now() + 30000, fingerprint, value }; return value;
    })().catch(unavailable).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending; return pending;
  }
  async validateReconnect(profileId: string) {
    chatGptProfileIdSchema.parse(profileId);
    const status = await this.read(true);
    if (status.state === 'unavailable') throw new Fault(503, 'signin_accounts_unavailable', 'Check the saved accounts before reconnecting. Existing connections are kept.');
    if (!status.accounts?.some(a => a.profileId === profileId)) throw new Fault(409, 'signin_profile_missing', 'That connection is no longer available. Add an account or choose a current connection.');
  }
  async validatePreference(profileId: string) {
    await this.validateReconnect(profileId);
    const account = this.cache?.value.accounts?.find(a => a.profileId === profileId);
    if (account?.duplicateOf) throw new Fault(409, 'account_duplicate', 'This is another connection to the same account. Choose its original connection.');
  }
  async configureOrder(device: string, raw: unknown): Promise<ChatGptAccountStatus> {
    const input = chatGptAccountOrderSchema.parse(raw), options = this.options;
    if (!options?.control) throw new Fault(503, 'account_order_unavailable', 'Account selection is unavailable on this host.');
    if (this.ordering) throw new Fault(409, 'account_order_busy', 'Another account change is being checked.');
    const work = this.applyOrder(device, input); this.ordering = work;
    try { return await work; } finally { if (this.ordering === work) this.ordering = undefined; }
  }
  private async applyOrder(device: string, input: z.infer<typeof chatGptAccountOrderSchema>) {
    const options = this.options!, store = options.store, gateway = options.gateway, state = gateway.status();
    const command = this.runtime.accountCommand(), fingerprint = this.fingerprint(command);
    const raw = await this.run(command, this.abort.signal), metadata = nativeAccountsSchema.parse(JSON.parse(raw));
    const ids = metadata.profiles.filter(p => p.type === 'oauth').map(p => p.id);
    const admitted = store.admit(device, input, { type: 'chatgpt.order', ...input }, () => {
      if (options.busy?.()) throw new Fault(409, 'account_order_busy', 'Finish the active Assistant turn or call before changing account order.');
      if (state.state !== 'ready' || !state.generation || this.fingerprint(this.runtime.accountCommand()) !== fingerprint) throw new Fault(409, 'account_host_changed', 'The account connection changed. Review its current accounts.');
      if (store.internalList<OrderReceipt>('accounts:order:').some(r => r.generation === state.generation && ['prepared', 'sending', 'unknown'].includes(r.state))) throw new Fault(409, 'account_order_unresolved', 'Check the earlier account change before starting another.');
      if (ids.length !== input.profileIds.length || ids.some(id => !input.profileIds.includes(id))) throw new Fault(409, 'account_order_membership', 'The saved accounts changed. Refresh their order first.');
      const nativeIds = [...input.profileIds, ...metadata.profiles.filter(p => p.type !== 'oauth').map(p => p.id)];
      const receipt: OrderReceipt = { requestId: input.requestId, generation: state.generation, profileIds: input.profileIds, nativeIds, state: 'prepared' };
      store.internalWrite(`accounts:order:${input.requestId}`, receipt); return { requestId: input.requestId };
    });
    const receipt = store.internalRead<OrderReceipt>(`accounts:order:${admitted.value.requestId}`)!;
    if (receipt.generation !== gateway.status().generation || fingerprint !== this.fingerprint(this.runtime.accountCommand())) throw new Fault(409, 'account_host_changed', 'This account change belongs to its original connection.');
    const save = (state: OrderReceipt['state']) => {
      if (store.epoch !== input.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed while checking account selection. Review its current order.');
      return store.internalWrite(`accounts:order:${receipt.requestId}`, { ...receipt, state });
    };
    if (receipt.state === 'confirmed') return this.read(true);
    if (receipt.state === 'not-sent') throw new Fault(403, 'account_order_not_sent', 'The host did not authorize this account change. The previous order is kept.');
    if (receipt.state !== 'prepared') {
      const status = await this.read(true);
      if (same(status.order, receipt.profileIds) && status.preferredProfileId === receipt.profileIds[0]) { save('confirmed'); return status; }
      throw new Fault(409, 'account_order_unknown', 'The earlier account change is not confirmed. Its request is kept; check the original connection before another change.');
    }
    save('sending');
    try {
      const result = z.object({ provider: z.literal('openai'), profileIds: z.array(chatGptProfileIdSchema) }).parse(await options.control!.request('models.authOrderSet', { provider: 'openai', agentId: 'main', profileIds: receipt.nativeIds }, () => {
        // Opening the isolated control connection is asynchronous. A reply or
        // call may have started during that wait; fence again at the mutation.
        let safe = false;
        try { safe = !this.abort.signal.aborted && store.epoch === input.epoch && !options.busy?.() && this.fingerprint(this.runtime.accountCommand()) === fingerprint; } catch { /* A vanished host is also a confirmed pre-send stop. */ }
        if (!safe) throw new Fault(409, 'account_order_not_sent', 'The workspace became busy or changed before account selection. The previous order is kept.');
      }));
      if (this.fingerprint(this.runtime.accountCommand()) !== fingerprint || !same(result.profileIds, receipt.nativeIds)) throw Error('Account order changed.');
      save('confirmed'); this.cache = undefined;
    } catch (error) {
      if (error instanceof Fault && ['account_order_not_sent', 'account_order_unavailable'].includes(error.code)) { save('not-sent'); throw error; }
      save('unknown'); throw new Fault(409, 'account_order_unknown', 'Account order was sent but is not confirmed. Retry this same change to check it.');
    }
    return this.read(true);
  }
  /** Choose once at a safe turn boundary. Never resend a turn or bypass a native restriction. */
  async route(input: { preferredProfileId?: string; model?: string } = {}): Promise<ChatGptAccountRoute | undefined> {
    if (input.model && !input.model.startsWith('openai/')) return undefined;
    const gateway = this.options?.gateway, epoch = this.options?.store.epoch, before = gateway?.status();
    if (!gateway || !epoch || before?.state !== 'ready' || !before.methods.includes('e3.accounts.snapshot')) {
      if (input.preferredProfileId) throw new Fault(409, 'account_unverified', 'Reconnect the account adapter before choosing this account.');
      return undefined;
    }
    // Sending and voice startup never wait on an allowance HTTP request or CLI
    // process. Native cooldowns are read fresh; quota uses its labelled cache.
    const snapshot = chatGptRuntimeSnapshotSchema.parse(await gateway.request('e3.accounts.snapshot', { epoch, includeUsage: false }));
    const current = gateway.status();
    if (current.state !== 'ready' || current.generation !== before.generation || current.url !== before.url || snapshot.epoch !== epoch || this.options!.store.epoch !== epoch) throw new Fault(409, 'account_host_changed', 'The account connection changed before selection.');
    const accounts: Account[] = snapshot.accounts.map(a => ({ ...a, label: a.email ?? 'ChatGPT Account' }));
    const order = [...snapshot.order.filter(id => accounts.some(a => a.profileId === id)), ...accounts.map(a => a.profileId).filter(id => !snapshot.order.includes(id))];
    if (input.preferredProfileId) {
      chatGptProfileIdSchema.parse(input.preferredProfileId);
      if (!accounts.some(a => a.profileId === input.preferredProfileId)) throw new Fault(409, 'account_missing', 'The preferred account is unavailable. Choose a connected account.');
      order.splice(0, order.length, input.preferredProfileId, ...order.filter(id => id !== input.preferredProfileId));
    }
    if (!accounts.length) return undefined;
    const now = this.now();
    const seen = new Set<string>();
    const selected = order.map(id => accounts.find(a => a.profileId === id)).find((a): a is Account => {
      if (!a || a.health !== 'ready' || (a.cooldownUntil ?? 0) > now) return false;
      if (a.identityKey && seen.has(a.identityKey)) return false;
      if (a.identityKey) seen.add(a.identityKey);
      // A stale reading does not erase known exhaustion before its reset. Without
      // a reset, only the last successful report's freshness can defer an account;
      // failed checks advance checkedAt and must not extend that limit forever.
      const reportFresh = a.usage.reportedAt !== null && a.usage.reportedAt <= now && a.usage.reportedAt + chatGptUsageFreshMs > now;
      return !a.usage.windows.some(w => a.usage.state !== 'unavailable' && w.usedPercent !== null && w.usedPercent >= 100 && (w.resetAt === null ? reportFresh : w.resetAt > now));
    });
    if (!selected) {
      if (!input.preferredProfileId && accounts.every(a => a.health === 'unknown')) return undefined;
      throw new Fault(409, 'account_no_eligible_backup', 'No connected account is currently ready. Saved chats and drafts are kept.');
    }
    return { profileId: selected.profileId, label: selected.label, ...(selected.identityKey ? { identityKey: selected.identityKey } : {}), reason: selected.profileId === order[0] ? 'preferred' : 'backup', checkedAt: snapshot.checkedAt };
  }
  invalidate() { this.cache = undefined; }
  async close() { this.abort.abort(); await Promise.allSettled([this.pending, this.ordering]); this.cache = undefined; }
}
