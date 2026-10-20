import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerDirectAgentTools, type DirectPluginApi } from '../apps/service/direct-agent-plugin/index.js';
import { directConfigurationHash, directPluginId, directRuntimePolicy, directToolPolicyId } from '../apps/service/direct-agent-runtime-policy.js';
import { directRuntimeAgent, directReadTool } from '../apps/service/direct-agent-tool-calls.js';

function fixture() {
  const epoch = randomUUID(), conversationId = randomUUID(), sessionId = randomUUID(), runId = randomUUID();
  const pluginConfig = { epoch, bundlePath: '/owned/direct-plugin', url: 'http://127.0.0.1:4383/workspace/direct', token: 'a'.repeat(64), policySha256: '' };
  const config = {
    plugins: { enabled: true, allow: [directPluginId], entries: { [directPluginId]: { enabled: true, config: pluginConfig } } },
    agents: { entries: { [directRuntimeAgent]: { ...structuredClone(directRuntimePolicy), workspace: '/owned/direct-workspace', agentDir: '/owned/direct-agent' } } },
    gateway: { controlUi: { enabled: false } },
  };
  pluginConfig.policySha256 = directConfigurationHash(config);
  let policy!: Parameters<DirectPluginApi['registerTrustedToolPolicy']>[0];
  let factory!: Parameters<DirectPluginApi['registerTool']>[0];
  let lifecycle!: Parameters<DirectPluginApi['lifecycle']['registerRuntimeLifecycle']>[0];
  let terminal!: Parameters<DirectPluginApi['agent']['events']['registerAgentEventSubscription']>[0];
  let after!: Parameters<DirectPluginApi['on']>[1];
  let active = true;
  const session = { sessionId, permissionMode: 'read-only', permissionModePending: false, authProfileOverride: 'original-account' };
  const api: DirectPluginApi = {
    registrationMode: 'full', pluginConfig, runtime: { version: '2026.9.8', config: { current: () => config },
      agent: { session: { getSessionEntry: () => session } } },
    registerTrustedToolPolicy: value => { policy = value; }, registerTool: (value, options) => {
      assert.equal(value.contextVersion, 2); assert.deepEqual(options.names, [directReadTool]); factory = value;
    }, on: (name, value) => { assert.equal(name, 'after_tool_call'); after = value; },
    lifecycle: { registerRuntimeLifecycle: value => { lifecycle = value; } },
    agent: { events: { registerAgentEventSubscription: value => { terminal = value; } } },
  };
  const controller = new AbortController();
  const context = { agentId: directRuntimeAgent, sessionKey: `agent:edition3-direct:e3:${conversationId}`, sessionId,
    runId, toolCallId: 'call-one', toolName: directReadTool, abortSignal: controller.signal };
  const read = { operation: 'records.read', input: { kind: 'task', id: 'task:one' } };
  const event = { toolName: directReadTool, runId, toolCallId: context.toolCallId, params: read };
  const execution = { ...context, getRuntimeConfig: () => config, assertInvocationCurrent: () => { if (!active) throw Error('stale invocation'); } };
  const reply = (request: any) => ({ epoch, operationId: randomUUID(), requestId: runId, conversationId,
    agentId: directRuntimeAgent, sessionKey: context.sessionKey, sessionId, runId, toolCallId: context.toolCallId,
    generation: 'managed-generation', accountId: 'original-account', policySha256: pluginConfig.policySha256, inputSha256: request.inputSha256 });
  return { api, config, pluginConfig, session, context, event, execution, read, controller, reply,
    stale: () => { active = false; },
    get policy() { return policy; }, get factory() { return factory; }, get lifecycle() { return lifecycle; },
    get terminal() { return terminal; }, get after() { return after; } };
}
test('exact public version2 policy and execution contract performs only the original authenticated read', async t => {
  const f = fixture(), requests: { url: string; body: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const body = JSON.parse(String(options?.body)); requests.push({ url: String(url), body });
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer ' + f.pluginConfig.token);
    assert.equal(options?.redirect, 'error'); assert.equal(options?.method, 'POST'); assert.ok(options?.signal);
    return Response.json(String(url).endsWith('/policy') ? f.reply(body) : { task: { title: 'Saved' } });
  });
  registerDirectAgentTools(f.api);
  assert.equal(f.policy.id, directToolPolicyId);
  assert.equal((await f.policy.evaluate(f.event, f.context))?.block, false);
  const tool = f.factory.create(f.execution)!;
  const result: any = await tool.execute('call-one', f.read, f.controller.signal);
  assert.deepEqual(result.details, { task: { title: 'Saved' } });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.origin.runId, f.context.runId);
  assert.equal(requests[1].body.origin.toolCallId, 'call-one');
  assert.deepEqual(requests[1].body.read, f.read);
  f.after(f.event, f.context);
  await assert.rejects(tool.execute('call-one', f.read));
  assert.equal(requests.length, 2);
});
test('ordinary roles and discovery are inert; unapproved direct tools and mismatched hook identities refuse', async t => {
  const f = fixture(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('must not request'); });
  f.api.registrationMode = 'tool-discovery'; registerDirectAgentTools(f.api);
  assert.equal(typeof f.factory, 'undefined');
  f.api.registrationMode = 'full'; registerDirectAgentTools(f.api);
  assert.equal(f.factory.create({ ...f.execution, agentId: 'main' }), null);
  assert.equal(await f.policy.evaluate(f.event, { ...f.context, agentId: 'main' }), undefined);
  for (const event of [{ ...f.event, toolName: 'exec' }, { ...f.event, runId: randomUUID() }, { ...f.event, toolCallId: 'other' }])
    assert.equal((await f.policy.evaluate(event, f.context))?.block, true);
  assert.equal(calls, 0);
});
test('resolved configuration includes other contributors; drift is refused before or after a read', async t => {
  const f = fixture(); let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (String(url).endsWith('/policy')) return Response.json(f.reply(JSON.parse(String(options?.body))));
    reads++; (f.config as any).hooks = { unexpected: 'changed' };
    return Response.json({ withheld: 'result' });
  });
  registerDirectAgentTools(f.api);
  assert.equal((await f.policy.evaluate(f.event, f.context))?.block, false);
  const tool = f.factory.create(f.execution)!;
  await assert.rejects(tool.execute('call-one', f.read), /configuration changed/);
  assert.equal(reads, 1);
  assert.equal((await f.policy.evaluate({ ...f.event, toolCallId: 'new' }, { ...f.context, toolCallId: 'new' }))?.block, true);
  assert.equal(reads, 1);
});
test('native session permission and stale version2 owner guard refuse before read', async t => {
  for (const change of ['native', 'permission', 'invocation'] as const) {
    const f = fixture(); let reads = 0;
    const mocked = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (String(url).endsWith('/read')) { reads++; assert.fail('must not read'); }
      return Response.json(f.reply(JSON.parse(String(options?.body))));
    });
    registerDirectAgentTools(f.api); await f.policy.evaluate(f.event, f.context);
    const tool = f.factory.create(f.execution)!;
    if (change === 'native') f.session.sessionId = randomUUID();
    if (change === 'permission') f.session.permissionModePending = true;
    if (change === 'invocation') f.stale();
    await assert.rejects(tool.execute('call-one', f.read)); assert.equal(reads, 0); mocked.mock.restore();
  }
});
test('plugin lifecycle closure invalidates an outstanding policy promise without writing or replaying', async t => {
  const f = fixture(); let finish!: (response: Response) => void, body: any;
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    body = JSON.parse(String(options?.body)); return new Promise<Response>(resolve => { finish = resolve; });
  });
  registerDirectAgentTools(f.api);
  const pending = f.policy.evaluate(f.event, f.context);
  f.lifecycle.cleanup({ reason: 'restart' }); finish(Response.json(f.reply(body)));
  assert.equal((await pending)?.block, true);
  await assert.rejects(f.factory.create(f.execution)!.execute('call-one', f.read));
});
test('a native account change during the asynchronous read withholds the result', async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (String(url).endsWith('/policy')) return Response.json(f.reply(JSON.parse(String(options?.body))));
    f.session.authProfileOverride = 'different-account';
    return Response.json({ withheld: 'original-account data' });
  });
  registerDirectAgentTools(f.api); await f.policy.evaluate(f.event, f.context);
  await assert.rejects(f.factory.create(f.execution)!.execute('call-one', f.read), /account changed/);
});
test('declared manifest matches the only trusted policy/tool and unsupported versions cannot register', () => {
  const manifest = JSON.parse(readFileSync(new URL('../apps/service/direct-agent-plugin/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts, { tools: [directReadTool], trustedToolPolicies: [directToolPolicyId] });
  const f = fixture(); f.api.runtime.version = '2026.9.7';
  assert.throws(() => registerDirectAgentTools(f.api), /SDK version/); assert.equal(f.policy, undefined);
});
