import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { chatGptAccountPluginId, supportsChatGptAccountRuntime, chatGptAccountSnapshotSchema, chatGptProfileIdSchema, chatGptUsageFreshMs, emptyChatGptUsage } from '../../../packages/domain/chatgpt-accounts.js';
import type { ChatGptAccountUsage } from '../../../packages/domain/sign-in.js';

type Credential = { provider: string; type: string; access?: string; accountId?: string; email?: string; expires?: number };
type NativeStore = { profiles: Record<string, Credential>; order?: Record<string, string[]>; usageStats?: Record<string, { cooldownUntil?: number; disabledUntil?: number; blockedUntil?: number; disabledReason?: string }> };
/** Public pinned SDK contracts. These objects never cross the Gateway boundary. */
export type AccountSdk = {
  resolveAgentDir(config: unknown, agentId: string): string;
  loadAuthProfileStoreWithoutExternalProfiles(agentDir: string, options: { allowKeychainPrompt: false }): NativeStore;
  resolveApiKeyForProfile(params: { cfg: unknown; store: NativeStore; agentDir: string; profileId: string; allowProfileFallback: false }): Promise<{ apiKey: string; provider: string; profileId: string; profileType: string } | null>;
  resolveOpenAICodexAuthIdentity(params: { access: string; accountId?: string; email?: string }): { accountId?: string; email?: string };
  fetchCodexUsage(token: string, accountId: string, timeoutMs: number, fetchFn: typeof fetch): Promise<unknown>;
};
export type AccountPluginApi = {
  registrationMode: string; pluginConfig?: unknown; config?: unknown;
  runtime: { version: string };
  registerGatewayMethod(name: string, handler: (options: { params: unknown; respond(ok: boolean, value?: unknown, error?: { code: string; message: string }): void }) => Promise<void>, options: { scope: 'operator.read' }): void;
  registerService(service: { id: string; start(): void; stop(): Promise<void> }): void;
};

async function loadSdk(runtimeEntry: string): Promise<AccountSdk> {
  // Resolve only package-exported public SDK modules from the exact pinned
  // runtime. Nova itself never opens or decodes the credential database.
  const require = createRequire(runtimeEntry);
  const load = (name: string) => import(pathToFileURL(require.resolve(`openclaw/plugin-sdk/${name}`)).href);
  const [runtime, oauth, usage] = await Promise.all([load('agent-runtime'), load('provider-oauth-runtime'), load('provider-usage')]);
  return { resolveAgentDir: runtime.resolveAgentDir, loadAuthProfileStoreWithoutExternalProfiles: runtime.loadAuthProfileStoreWithoutExternalProfiles, resolveApiKeyForProfile: runtime.resolveApiKeyForProfile, resolveOpenAICodexAuthIdentity: oauth.resolveOpenAICodexAuthIdentity, fetchCodexUsage: usage.fetchCodexUsage };
}
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const email = (v: unknown) => z.string().email().max(254).safeParse(v).success ? v as string : undefined;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Runtime-owned exact-profile account usage; never changes routing or refreshes another profile. */
export function registerAccounts(api: AccountPluginApi, sdkLoader = loadSdk, now = Date.now, fetchFn: typeof fetch = fetch) {
  if (api.registrationMode !== 'full') return;
  const config = z.object({ epoch: z.string().uuid(), bundlePath: z.string().min(1), runtimeEntry: z.string().min(1) }).strict().parse(api.pluginConfig);
  let closing = false, sdkPromise: Promise<AccountSdk> | undefined;
  const cache = new Map<string, ChatGptAccountUsage>(), flights = new Map<string, Promise<ChatGptAccountUsage>>();
  const current = () => { if (closing || !supportsChatGptAccountRuntime(api.runtime.version)) throw Error('Account adapter unavailable.'); };
  const identity = (sdk: AccountSdk, cred?: Credential) => {
    if (!cred || cred.provider !== 'openai' || cred.type !== 'oauth' || !cred.access) return undefined;
    const info = sdk.resolveOpenAICodexAuthIdentity({ access: cred.access, ...(cred.accountId ? { accountId: cred.accountId } : {}), ...(cred.email ? { email: cred.email } : {}) });
    return info.accountId ? { accountId: info.accountId, identityKey: createHash('sha256').update(`${config.epoch}\0${info.accountId}`).digest('hex'), email: email(info.email) } : undefined;
  };
  api.registerGatewayMethod('e3.accounts.snapshot', async ({ params, respond }) => {
    try {
      current(); const input = chatGptAccountSnapshotSchema.parse(params);
      if (input.epoch !== config.epoch) throw Error('Account workspace changed.');
      const sdk = await (sdkPromise ??= sdkLoader(config.runtimeEntry)); current();
      const agentDir = sdk.resolveAgentDir(api.config, 'main');
      const read = () => sdk.loadAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false });
      const native = read(), ids = Object.keys(native.profiles).filter(id => chatGptProfileIdSchema.safeParse(id).success && native.profiles[id]?.provider === 'openai' && native.profiles[id]?.type === 'oauth').sort().slice(0, 100);
      const observedAt = now();
      const accounts = await Promise.all(ids.map(async (profileId, index) => {
        const cred = native.profiles[profileId], info = identity(sdk, cred), stats = native.usageStats?.[profileId];
        const disabled = finite(stats?.disabledUntil), blocked = Math.max(finite(stats?.cooldownUntil) ?? 0, finite(stats?.blockedUntil) ?? 0);
        const health = disabled && disabled > observedAt ? 'reconnect' as const : blocked > observedAt ? 'cooldown' as const : info ? 'ready' as const : 'unknown' as const;
        let usage = emptyChatGptUsage() as ChatGptAccountUsage;
        if (info) {
          const cacheId = `${profileId}:${info.identityKey}`, previous = cache.get(cacheId);
          const checkIdentity = () => { current(); return identity(sdk, read().profiles[profileId])?.identityKey === info.identityKey; };
          const refresh = async () => {
            let value: ChatGptAccountUsage;
            try {
              const token = await sdk.resolveApiKeyForProfile({ cfg: api.config, store: native, agentDir, profileId, allowProfileFallback: false });
              if (!token || token.profileId !== profileId || token.provider !== 'openai' || token.profileType !== 'oauth' || !checkIdentity()) throw Error('Exact account unavailable.');
              // The pinned SDK substitutes zero for missing percentages. Inspect
              // its response inside the runtime so missing values stay unknown.
              let rawWindows: unknown[] | undefined;
              const checkedFetch: typeof fetch = async (...args) => {
                const result = await fetchFn(...args);
                if (result.ok) {
                  try { const data = record(await result.clone().json()), limits = record(data.rate_limit); rawWindows = [limits.primary_window, limits.secondary_window].filter(Boolean).map(window => record(window).used_percent); } catch { /* SDK reports the fetch failure. */ }
                }
                return result;
              };
              const raw = record(await sdk.fetchCodexUsage(token.apiKey, info.accountId, 6000, checkedFetch));
              if (!checkIdentity() || raw.provider !== 'openai' || raw.error || !Array.isArray(raw.windows)) throw Error('Usage unavailable.');
              const windows = raw.windows.slice(0, 20).map((window: unknown, i: number) => {
                const w = record(window), percent = rawWindows ? finite(rawWindows[i]) : null;
                return { label: typeof w.label === 'string' ? w.label.slice(0, 120) : 'Allowance', usedPercent: percent === null ? null : Math.min(100, percent), resetAt: finite(w.resetAt) };
              });
              value = { state: 'ready', checkedAt: now(), reportedAt: now(), windows, plan: typeof raw.plan === 'string' ? raw.plan.slice(0, 120) : null, credits: finite(Array.isArray(raw.billing) ? raw.billing.find((b: any) => b?.type === 'balance' && b?.unit === 'credits')?.amount : null) };
            } catch { value = previous ? { ...previous, state: 'stale', checkedAt: now() } : { ...emptyChatGptUsage(), checkedAt: now() }; }
            if (!checkIdentity()) return emptyChatGptUsage();
            cache.set(cacheId, value); return value;
          };
          if (!input.refresh && previous && (previous.checkedAt ?? 0) + chatGptUsageFreshMs > observedAt) usage = previous;
          else if (input.includeUsage !== false && index < 10 && health !== 'reconnect') {
            let pending = flights.get(cacheId);
            if (!pending) { pending = refresh(); flights.set(cacheId, pending); void pending.finally(() => { if (flights.get(cacheId) === pending) flights.delete(cacheId); }).catch(() => undefined); }
            usage = await pending;
          } else if (previous) usage = { ...previous, state: 'stale' };
          if (!checkIdentity()) return undefined;
        }
        return { profileId, ...(info ? { identityKey: info.identityKey, ...(info.email ? { email: info.email } : {}) } : {}), health, cooldownUntil: blocked > observedAt ? blocked : null, expiresAt: finite(cred.expires), usage };
      }));
      current();
      const latest = read();
      if (!same(ids, Object.keys(latest.profiles).filter(id => chatGptProfileIdSchema.safeParse(id).success && latest.profiles[id]?.provider === 'openai' && latest.profiles[id]?.type === 'oauth').sort().slice(0, 100))) throw Error('Accounts changed.');
      respond(true, { epoch: config.epoch, checkedAt: now(), order: (latest.order?.openai ?? []).filter(id => ids.includes(id)), accounts: accounts.filter(Boolean) });
    } catch { respond(false, undefined, { code: 'UNAVAILABLE', message: 'Exact ChatGPT account usage is unavailable. Saved connections are kept.' }); }
  }, { scope: 'operator.read' });
  api.registerService({ id: chatGptAccountPluginId, start() {}, async stop() { closing = true; await Promise.allSettled([...flights.values()]); cache.clear(); } });
}
export default { id: chatGptAccountPluginId, name: 'Nova Dream accounts', description: 'Exact-profile account health and usage without exporting credentials.', register: registerAccounts };
