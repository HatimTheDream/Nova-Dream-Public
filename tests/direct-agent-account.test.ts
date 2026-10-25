import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerAccounts, type AccountPluginApi, type AccountSdk } from '../apps/service/account-plugin/index.js';

function fixture(agentId: 'edition3-direct' | 'edition3-group' = 'edition3-direct') {
  const epoch = randomUUID(), config = { agents: { entries: { [agentId]: {} } } };
  const credential = { type: 'oauth', provider: 'openai', access: 'synthetic-secret', accountId: 'synthetic-identity', expires: 900000 };
  const main = { profiles: { 'openai:chosen': { ...credential } }, usageStats: {} as Record<string, any> };
  const direct = structuredClone(main), methods = new Map<string, Parameters<AccountPluginApi['registerGatewayMethod']>[1]>();
  let reads = 0, resolveCalls = 0, providerCalls = 0, stop!: () => Promise<void>, beforeRead = () => {};
  const sdk: AccountSdk = {
    resolveAgentDir: (actual, agent) => { assert.equal(actual, config); assert.ok(['main', agentId].includes(agent)); return agent; },
    loadAuthProfileStoreWithoutExternalProfiles: (agent, options) => {
      reads++; beforeRead(); assert.deepEqual(options, { allowKeychainPrompt: false });
      return structuredClone(agent === 'main' ? main : direct);
    },
    resolveOpenAICodexAuthIdentity: input => ({ accountId: input.accountId }),
    resolveApiKeyForProfile: async () => { resolveCalls++; throw Error('No credential resolution allowed'); },
    fetchCodexUsage: async () => { providerCalls++; throw Error('No provider request allowed'); },
  };
  const api: AccountPluginApi = {
    registrationMode: 'full', pluginConfig: { epoch, bundlePath: '/synthetic/plugin', runtimeEntry: '/synthetic/native-entry' },
    config, runtime: { version: '2026.9.8', config: { current: () => config } },
    registerGatewayMethod(name, handler, options) { assert.equal(options.scope, 'operator.read'); methods.set(name, handler); },
    registerService(service) { stop = service.stop; },
  };
  registerAccounts(api, async () => sdk, () => 1000, async () => { providerCalls++; throw Error('No fetch allowed'); });
  const read = async (extra = {}, originalOnly = false) => {
    let result: any;
    await methods.get(originalOnly ? 'e3.accounts.group-identity' : agentId === 'edition3-group' ? 'e3.accounts.group-profile' : 'e3.accounts.direct-profile')!({ params: { epoch, agentId, profileId: 'openai:chosen', ...extra },
      respond(ok, value, error) { result = { ok, value, error }; } });
    return result;
  };
  return { main, direct, config, read, stop: () => stop(), beforeRead: (callback: () => void) => { beforeRead = callback; },
    counts: () => ({ reads, resolveCalls, providerCalls }) };
}
test('exact-profile observation rereads both views and exports only opaque identity/expiry', async () => {
  const f = fixture(), before = structuredClone({ main: f.main, direct: f.direct });
  const result = await f.read();
  assert.equal(result.ok, true); assert.match(result.value.identityKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.counts(), { reads: 4, resolveCalls: 0, providerCalls: 0 });
  assert.deepEqual({ main: f.main, direct: f.direct }, before);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-identity'), false);
  await f.stop(); assert.equal((await f.read()).ok, false);
  assert.equal(f.counts().reads, 4);
});

test('Group exact-account branch keeps separate agent identity and refuses drift without refresh or fallback', async () => {
  const f = fixture('edition3-group'), before = structuredClone({ main: f.main, direct: f.direct });
  assert.equal((await f.read({ agentId: 'edition3-direct' })).ok, false); assert.equal(f.counts().reads, 0);
  const result = await f.read(); assert.equal(result.ok, true); assert.equal(result.value.agentId, 'edition3-group');
  assert.deepEqual(f.counts(), { reads: 4, resolveCalls: 0, providerCalls: 0 });
  assert.deepEqual({ main: f.main, direct: f.direct }, before);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|synthetic-identity/);
  f.beforeRead(() => { if (f.counts().reads === 7) f.direct.profiles['openai:chosen'].accountId = 'changed'; });
  assert.equal((await f.read()).ok, false);
  assert.equal(f.counts().resolveCalls, 0); assert.equal(f.counts().providerCalls, 0);
  await f.stop(); assert.equal((await f.read()).ok, false);
});
test('missing, replaced, expired, blocked or malformed exact profile never falls back or refreshes', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { delete (f.direct.profiles as any)['openai:chosen']; },
    (f: ReturnType<typeof fixture>) => { f.direct.profiles['openai:chosen'].accountId = 'different'; },
    (f: ReturnType<typeof fixture>) => { f.direct.profiles['openai:chosen'].expires = 30000; },
    (f: ReturnType<typeof fixture>) => { f.direct.usageStats['openai:chosen'] = { cooldownUntil: 5000 }; },
    (f: ReturnType<typeof fixture>) => { f.direct.usageStats['openai:chosen'] = { blockedUntil: Number.NaN }; },
  ]) {
    const f = fixture(); change(f);
    assert.equal((await f.read()).ok, false);
    assert.equal(f.counts().resolveCalls, 0); assert.equal(f.counts().providerCalls, 0); await f.stop();
  }
});
test('a selected identity or configuration change during independently repeated reads withholds proof', async () => {
  for (const kind of ['identity', 'config']) {
    const f = fixture();
    f.beforeRead(() => {
      if (f.counts().reads !== 3) return;
      if (kind === 'identity') f.direct.profiles['openai:chosen'].accountId = 'replacement';
      else (f.config as any).replaced = true;
    });
    assert.equal((await f.read()).ok, false); assert.equal(f.counts().providerCalls, 0); await f.stop();
  }
});
test('different epoch, arbitrary agent or unexpected request properties cannot read profiles', async () => {
  const f = fixture();
  for (const value of [{ epoch: randomUUID() }, { agentId: 'main' }, { refresh: true }])
    assert.equal((await f.read(value)).ok, false);
  assert.equal(f.counts().reads, 0); await f.stop();
});

test('Group identity-only observation survives cooldown and expiry without authorizing new work', async () => {
  for (const mode of ['cooldown', 'expired', 'disabled'] as const) {
    const f = fixture('edition3-group');
    try {
      const original = await f.read({}, true); assert.equal(original.ok, true);
      if (mode === 'expired') f.main.profiles['openai:chosen'].expires = f.direct.profiles['openai:chosen'].expires = 500;
      else f.direct.usageStats['openai:chosen'] = mode === 'cooldown' ? { cooldownUntil: 5000 } : { disabledUntil: 5000 };
      assert.equal((await f.read()).ok, false, 'new work still requires readiness');
      const observed = await f.read({}, true); assert.equal(observed.ok, true);
      assert.equal(observed.value.identityKey, original.value.identityKey);
      assert.deepEqual(Object.keys(observed.value).sort(), ['agentId', 'epoch', 'format', 'identityKey', 'profileId']);
      assert.doesNotMatch(JSON.stringify(observed), /synthetic-secret|synthetic-identity/);
      assert.equal(f.counts().resolveCalls, 0); assert.equal(f.counts().providerCalls, 0);
    } finally { await f.stop(); }
  }
});

test('Group identity-only reads preserve exact account, epoch, agent and repeated-read fences', async () => {
  for (const kind of ['missing', 'replaced', 'during-read', 'config'] as const) {
    const f = fixture('edition3-group');
    try {
      if (kind === 'missing') delete (f.direct.profiles as any)['openai:chosen'];
      if (kind === 'replaced') f.direct.profiles['openai:chosen'].accountId = 'replacement';
      if (kind === 'during-read' || kind === 'config') f.beforeRead(() => {
        if (f.counts().reads !== 3) return;
        if (kind === 'config') (f.config as any).changed = true;
        else f.direct.profiles['openai:chosen'].accountId = 'replacement';
      });
      assert.equal((await f.read({}, true)).ok, false);
      assert.equal(f.counts().resolveCalls, 0); assert.equal(f.counts().providerCalls, 0);
    } finally { await f.stop(); }
  }
  const f = fixture('edition3-group');
  try {
    for (const extra of [{ epoch: randomUUID() }, { agentId: 'edition3-direct' }, { refresh: true }])
      assert.equal((await f.read(extra, true)).ok, false);
    assert.equal(f.counts().reads, 0);
  } finally { await f.stop(); }
});
