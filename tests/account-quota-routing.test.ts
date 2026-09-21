import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerAccounts, type AccountPluginApi, type AccountSdk } from '../apps/service/account-plugin/index.js';
import { ChatGptAccount } from '../apps/service/chatgpt-account.js';
import type { AssistantTransport } from '../apps/service/gateway.js';
import type { Store } from '../apps/service/store.js';
import { chatGptUsageFreshMs, chatGptRuntimeSnapshotSchema } from '../packages/domain/chatgpt-accounts.js';

// Exercise the real cache and router together. The injected SDK/fetch is entirely
// synthetic; dispatch must never start a CLI or refresh provider usage.
function fixture(firstUsed: number | null = 100, resetAt: number | null = 800000) {
  const epoch = randomUUID();
  let now = 1000, reads = 0, fail = false;
  let handler!: Parameters<AccountPluginApi['registerGatewayMethod']>[1], stop!: () => Promise<void>;
  const native = { profiles: {
    'openai:first': { provider: 'openai', type: 'oauth', access: 'fixture-first', accountId: 'fixture-first' },
    'openai:backup': { provider: 'openai', type: 'oauth', access: 'fixture-backup', accountId: 'fixture-backup' },
  }, order: { openai: ['openai:first', 'openai:backup'] } };
  const sdk: AccountSdk = {
    resolveAgentDir: () => '/fixture',
    loadAuthProfileStoreWithoutExternalProfiles: () => structuredClone(native),
    resolveOpenAICodexAuthIdentity: input => ({ accountId: input.accountId }),
    async resolveApiKeyForProfile(input) { return { apiKey: input.store.profiles[input.profileId].access!, provider: 'openai', profileId: input.profileId, profileType: 'oauth' }; },
    async fetchCodexUsage(token, _id, _timeout, run) {
      const value = await (await run('https://fixture.invalid', { headers: { Authorization: token } })).json() as { rate_limit: { primary_window: { used_percent: number | null } } };
      return { provider: 'openai', windows: [{ label: '5h', usedPercent: value.rate_limit.primary_window.used_percent ?? 0, resetAt }] };
    },
  };
  registerAccounts({ registrationMode: 'full', pluginConfig: { epoch, bundlePath: '/fixture/plugin', runtimeEntry: '/fixture/runtime' }, runtime: { version: '2026.9.2' },
    registerGatewayMethod(_name, value) { handler = value; }, registerService(value) { stop = value.stop; },
  }, async () => sdk, () => now, async (_url, init) => {
    reads++; if (fail) throw Error('Synthetic provider unavailable');
    const token = (init?.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: token === 'fixture-first' ? firstUsed : 20 } } }));
  });
  const read = async (extra: { refresh?: boolean; includeUsage?: boolean } = {}) => {
    let output: unknown;
    await handler({ params: { epoch, ...extra }, respond(ok, value) { assert(ok); output = value; } });
    return chatGptRuntimeSnapshotSchema.parse(output);
  };
  const gateway = { status: () => ({ state: 'ready', generation: 'same-host', url: 'ws://fixture', methods: ['e3.accounts.snapshot'] }),
    request: (_method: string, params: { includeUsage?: boolean }) => { assert.equal(params.includeUsage, false); return read(params); },
  } as unknown as AssistantTransport;
  const service = new ChatGptAccount({ accountCommand: () => assert.fail('Routing must not start a CLI') }, async () => assert.fail('Routing must not start a CLI'), () => now, { store: { epoch } as Store, gateway });
  return { read, advance: (ms: number) => { now += ms; }, fail: () => { fail = true; }, async route() {
    const before = reads, result = await service.route(); assert.equal(reads, before, 'Routing must not fetch provider usage'); return result?.profileId;
  }, async close() { await service.close(); await stop(); } };
}

test('known exhaustion keeps selecting the backup after cache expiry and failed refresh until the reported reset', async () => {
  const f = fixture();
  try {
    await f.read(); assert.equal(await f.route(), 'openai:backup');
    f.advance(chatGptUsageFreshMs + 1);
    const stale = await f.read({ includeUsage: false });
    assert.equal(stale.accounts[1].usage.state, 'stale');
    assert.equal(await f.route(), 'openai:backup');
    f.fail(); const failed = await f.read({ refresh: true });
    assert.equal(failed.accounts[1].usage.state, 'stale');
    assert.equal(failed.accounts[1].usage.reportedAt, 1000);
    assert.equal(await f.route(), 'openai:backup');
    f.advance(800000 - failed.checkedAt);
    assert.equal(await f.route(), 'openai:first', 'The elapsed reset releases the old exhausted reading');
  } finally { await f.close(); }
});

test('exhaustion without a reset expires from the successful report, not repeated failed checks', async () => {
  const f = fixture(100, null);
  try {
    await f.read(); assert.equal(await f.route(), 'openai:backup');
    f.advance(chatGptUsageFreshMs - 1); f.fail();
    const failed = await f.read({ refresh: true });
    assert.equal(failed.accounts[1].usage.reportedAt, 1000);
    assert.equal(failed.accounts[1].usage.checkedAt, 1000 + chatGptUsageFreshMs - 1);
    assert.equal(await f.route(), 'openai:backup');
    f.advance(1); await f.read({ refresh: true });
    assert.equal(await f.route(), 'openai:first', 'A failed refresh cannot renew unknown-reset exhaustion indefinitely');
  } finally { await f.close(); }
});

test('unavailable usage and missing percentages remain eligible rather than becoming exhausted', async () => {
  const f = fixture(null);
  try {
    assert.equal(await f.route(), 'openai:first', 'There is no known allowance before the first provider read');
    const read = await f.read();
    assert.equal(read.accounts[1].usage.windows[0].usedPercent, null, 'The SDK zero fallback must remain unknown');
    assert.equal(await f.route(), 'openai:first');
    f.advance(chatGptUsageFreshMs + 1); f.fail(); await f.read({ refresh: true });
    assert.equal(await f.route(), 'openai:first');
  } finally { await f.close(); }
});
