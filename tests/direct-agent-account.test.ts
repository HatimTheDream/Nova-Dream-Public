import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerAccounts, type AccountPluginApi, type AccountSdk } from '../apps/service/account-plugin/index.js';

function fixture() {
  const epoch = randomUUID(), config = { agents: { entries: { 'edition3-direct': {} } } };
  const credential = { type: 'oauth', provider: 'openai', access: 'synthetic-secret', accountId: 'synthetic-identity', expires: 900000 };
  const main = { profiles: { 'openai:chosen': { ...credential } }, usageStats: {} as Record<string, any> };
  const direct = structuredClone(main), methods = new Map<string, Parameters<AccountPluginApi['registerGatewayMethod']>[1]>();
  let reads = 0, resolveCalls = 0, providerCalls = 0, stop!: () => Promise<void>, beforeRead = () => {};
  const sdk: AccountSdk = {
    resolveAgentDir: (actual, agent) => { assert.equal(actual, config); assert.ok(['main', 'edition3-direct'].includes(agent)); return agent; },
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
  const read = async (extra = {}) => {
    let result: any;
    await methods.get('e3.accounts.direct-profile')!({ params: { epoch, agentId: 'edition3-direct', profileId: 'openai:chosen', ...extra },
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
