import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerAccounts, type AccountPluginApi, type AccountSdk } from '../apps/service/account-plugin/index.js';

function fixture() {
  const epoch = randomUUID(), native = { profiles: { 'openai:a': { provider: 'openai', type: 'oauth', access: 'SECRET_A', accountId: 'ACCOUNT_A', email: 'a@example.com', expires: 9999999 }, 'openai:b': { provider: 'openai', type: 'oauth', access: 'SECRET_B', accountId: 'ACCOUNT_B', email: 'b@example.com', expires: 9999999 } }, order: { openai: ['openai:a', 'openai:b'] } };
  let now = 1000, fail = false, reads = 0, resolves = 0, missing = false, wrong = false;
  let stop!: () => Promise<void>, handler!: Parameters<AccountPluginApi['registerGatewayMethod']>[1];
  const sdk: AccountSdk = {
    resolveAgentDir: (_cfg, id) => { assert.equal(id, 'main'); return '/fixture/main'; },
    loadAuthProfileStoreWithoutExternalProfiles: (_dir, opts) => { assert.equal(opts.allowKeychainPrompt, false); return structuredClone(native); },
    resolveOpenAICodexAuthIdentity: p => ({ accountId: p.accountId, email: p.email }),
    async resolveApiKeyForProfile(p) { resolves++; assert.equal(p.allowProfileFallback, false); const c = p.store.profiles[p.profileId]; return { apiKey: c.access!, provider: 'openai', profileId: wrong ? 'openai:other' : p.profileId, profileType: 'oauth' }; },
    async fetchCodexUsage(token, accountId, timeout, run) {
      assert.equal(accountId, token === 'SECRET_A' ? 'ACCOUNT_A' : 'ACCOUNT_B'); assert.equal(timeout, 6000);
      const data = await (await run('https://fixture.invalid', { headers: { Authorization: token } })).json() as any;
      return { provider: 'openai', windows: [{ label: '5h', usedPercent: data.rate_limit.primary_window.used_percent ?? 0, resetAt: 800000 }], plan: 'plus' };
    },
  };
  const api: AccountPluginApi = { registrationMode: 'full', pluginConfig: { epoch, bundlePath: '/fixture/plugin', runtimeEntry: '/fixture/openclaw.mjs' }, runtime: { version: '2026.9.2' }, registerGatewayMethod(name, h, opts) { assert.equal(name, 'e3.accounts.snapshot'); assert.equal(opts.scope, 'operator.read'); handler = h; }, registerService(service) { stop = service.stop; } };
  registerAccounts(api, async () => sdk, () => now, async (_url, init) => { reads++; if (fail) throw Error('SECRET_PROVIDER_ERROR'); const token = (init?.headers as Record<string, string>).Authorization; return new Response(JSON.stringify({ rate_limit: { primary_window: missing ? {} : { used_percent: token === 'SECRET_A' ? 19 : 73 } } }), { status: 200 }); });
  const read = async (requestedEpoch = epoch, extra: { refresh?: boolean; includeUsage?: boolean } = {}) => { let output: any; await handler({ params: { epoch: requestedEpoch, ...extra }, respond(ok, value, error) { output = { ok, value, error }; } }); return output; };
  return { api, read, stop: () => stop(), native, counters: () => ({ reads, resolves }), advance: () => { now += 31000; }, failure: () => { fail = true; }, missing: () => { missing = true; }, wrong: () => { wrong = true; } };
}

test('account SDK accepts only the two reviewed engine versions', async () => {
  const f = fixture();
  try {
    f.api.runtime.version = '2026.9.6';
    const accepted=await f.read(); assert.equal(accepted.ok,true); assert.equal(accepted.value.accounts.length, 2);
    const before = f.counters();
    f.api.runtime.version = '2026.9.5';
    assert.equal((await f.read()).ok,false);
    assert.deepEqual(f.counters(), before);
  } finally { await f.stop(); }
});

test('exact account usage stays credential-isolated, independent, cached and coalesced', async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.read(), f.read()]);
    assert.equal(a.ok, true); assert.deepEqual(a, b); assert.deepEqual(a.value.accounts.map((p: any) => p.usage.windows[0].usedPercent), [19, 73]);
    assert.notEqual(a.value.accounts[0].identityKey, a.value.accounts[1].identityKey);
    assert(!JSON.stringify(a).includes('SECRET')); assert(!JSON.stringify(a).includes('ACCOUNT_A')); assert.deepEqual(f.counters(), { reads: 2, resolves: 2 });
    await f.read(); assert.equal(f.counters().reads, 2);
    await f.read(undefined, { refresh: true }); assert.equal(f.counters().reads, 4, 'an explicit usage refresh bypasses the fresh cache');
    f.advance(); await f.read(undefined, { includeUsage: false }); assert.equal(f.counters().reads, 4, 'routing cannot trigger a provider fetch even with expired usage');
  } finally { await f.stop(); }
});
test('missing quota stays unknown and failed refresh preserves original reported time as stale', async () => {
  const f = fixture();
  try {
    f.missing(); const first = await f.read(); assert.equal(first.value.accounts[0].usage.windows[0].usedPercent, null);
    f.advance(); f.failure(); const failed = await f.read();
    assert.equal(failed.value.accounts[0].usage.state, 'stale'); assert.equal(failed.value.accounts[0].usage.reportedAt, first.value.accounts[0].usage.reportedAt); assert(failed.value.accounts[0].usage.checkedAt > first.value.accounts[0].usage.checkedAt);
    assert(!JSON.stringify(failed).includes('SECRET_PROVIDER'));
  } finally { await f.stop(); }
});
test('a resolver fallback cannot charge another account quota to the requested profile', async () => {
  const f = fixture(); f.wrong();
  try { const result = await f.read(); assert.equal(result.ok, true); assert(result.value.accounts.every((a: any) => a.usage.state === 'unavailable')); assert.equal(f.counters().reads, 0); }
  finally { await f.stop(); }
});
test('foreign workspace and stopped adapter cannot read provider credentials', async () => {
  const f = fixture(); assert.equal((await f.read(randomUUID())).ok, false); assert.equal(f.counters().resolves, 0);
  await f.stop(); assert.equal((await f.read()).ok, false); assert.equal(f.counters().resolves, 0);
});
