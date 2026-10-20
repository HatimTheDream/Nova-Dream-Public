import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  DirectAgentToolCalls, directReadInputSchema, directReadTool, directRuntimeAgent,
  type DirectExecutionContext, type TrustedDirectCall,
} from '../direct-agent-tool-calls.js';
import { assertDirectConfiguration, assertDirectConfigurationShape, directConfigurationHash, directPluginId, directToolPolicyId } from '../direct-agent-runtime-policy.js';

// Exact public 2026.9.8 SDK subset. Registration alone is not runtime admission.
export type DirectPluginApi = {
  registrationMode: string; pluginConfig?: Record<string, unknown>;
  runtime: {
    version: string; config: { current(): unknown };
    agent: { session: { getSessionEntry(input: { agentId: string; sessionKey: string; readConsistency: 'latest' }):
      { sessionId?: string; permissionMode?: string; permissionModePending?: boolean; authProfileOverride?: string;
        lifecycleRevision?: string | null; model?: string; modelProvider?: string } | undefined } };
  };
  registerGatewayMethod(name: string, handler: (input: {
    params: unknown; respond(ok: boolean, result?: unknown, error?: { code: string; message: string }): void;
  }) => void, options: { scope: 'operator.read' }): void;
  registerTrustedToolPolicy(policy: { id: string; description: string; evaluate(
    event: { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string },
    context: TrustedDirectCall): Promise<{ block: boolean; blockReason?: string } | void> }): void;
  registerTool(factory: { contextVersion: 2; create(context: DirectExecutionContext & { getRuntimeConfig?: () => unknown }): {
    name: string; label: string; description: string; parameters: unknown;
    execute(toolCallId: string, raw: unknown, signal?: AbortSignal): Promise<unknown>;
  } | null }, options: { names: string[] }): void;
  on(name: 'after_tool_call', callback: (event: { toolName: string; runId?: string; toolCallId?: string }, context: TrustedDirectCall) => void): void;
  lifecycle: { registerRuntimeLifecycle(input: { id: string; cleanup(context: {
    reason: 'disable' | 'reset' | 'delete' | 'restart'; sessionKey?: string; runId?: string;
  }): void; dispose(): void }): void };
  agent: { events: { registerAgentEventSubscription(input: {
    id: string; streams: string[]; handle(event: { runId: string; sessionKey?: string; data: Record<string, unknown> }): void;
  }): void } };
};
export function registerDirectAgentTools(api: DirectPluginApi) {
  if (api.registrationMode !== 'full') return;
  if (api.runtime.version !== '2026.9.8') throw Error('The dedicated agent adapter requires its qualified SDK version.');
  const config = z.object({
    epoch: z.uuid(), bundlePath: z.string().min(1), policySha256: z.string().regex(/^[a-f0-9]{64}$/),
    url: z.url(), token: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().parse(api.pluginConfig);
  const url = new URL(config.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/workspace/direct'
    || url.search || url.hash || url.username || url.password) throw Error('Direct reads require the owning loopback service.');
  const initial = api.runtime.config.current();
  assertDirectConfigurationShape(initial);
  const policySha256 = directConfigurationHash(initial), registrationId = randomUUID();
  let disposed = false;
  const current = () => {
    if (disposed) throw Error('The original direct-agent registration is closed.');
    assertDirectConfiguration(api.runtime.config.current(), policySha256);
  };
  current();
  const calls = new DirectAgentToolCalls({ epoch: config.epoch, policySha256 }, current);
  api.registerGatewayMethod('e3.direct.policy', ({ params, respond }) => {
    try {
      current();
      const input = z.object({ epoch: z.uuid(), nativeKey: z.string().regex(/^agent:edition3-direct:e3:[a-f0-9-]{36}$/),
        nativeId: z.uuid().nullable() }).strict().parse(params);
      if (input.epoch !== config.epoch) throw Error('Workspace replaced.');
      const entry = api.runtime.agent.session.getSessionEntry({ agentId: directRuntimeAgent, sessionKey: input.nativeKey, readConsistency: 'latest' });
      if (input.nativeId && entry?.sessionId !== input.nativeId) throw Error('Original session replaced.');
      const session = entry ? {
        key: input.nativeKey, id: z.uuid().parse(entry.sessionId),
        lifecycleRevision: z.string().min(1).max(512).nullable().parse(entry.lifecycleRevision ?? null),
        permissionMode: entry.permissionMode, permissionModePending: entry.permissionModePending === true,
        accountId: entry.authProfileOverride ?? null,
        model: typeof entry.model === 'string' ? entry.model.includes('/') ? entry.model : entry.modelProvider ? `${entry.modelProvider}/${entry.model}` : null : null,
      } : null;
      current();
      respond(true, { format: 1, epoch: config.epoch, agentId: directRuntimeAgent, registrationId,
        sourcePolicySha256: config.policySha256, policySha256, nativeKey: input.nativeKey, session });
    } catch { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'The original direct-agent policy or session is unavailable.' }); }
  }, { scope: 'operator.read' });
  const bridge = async (path: '/policy' | '/read', body: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    const response = await fetch(config.url + path, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ registrationId, request: body }), signal: AbortSignal.any([signal, AbortSignal.timeout(path === '/policy' ? 5000 : 30000)]),
    });
    // Bound the stream before parsing; no oversized unauthorized data is retained.
    const reader = response.body?.getReader();
    if (!reader) throw Error('The original read could not be verified.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const next = await reader.read(); signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > (path === '/policy' ? 8192 : 1024 * 1024)) throw Error('Narrow this read request.');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (!response.ok) throw Error('The original direct-agent read is unavailable or no longer permitted.');
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  };
  api.registerTrustedToolPolicy({
    id: directToolPolicyId, description: 'Bind direct-agent reads to the original native run and captured current access.',
    evaluate: async (event, context) => {
      if (context.agentId !== directRuntimeAgent) return;
      if (event.toolName !== directReadTool || context.toolName !== event.toolName
        || event.runId !== context.runId || event.toolCallId !== context.toolCallId)
        return { block: true, blockReason: 'This direct agent can use only its original authorized read tool.' };
      try {
        await calls.authorize(context, event.params, (request, signal) => bridge('/policy', request, signal));
        return { block: false };
      } catch { return { block: true, blockReason: 'The original direct-agent read authority could not be verified.' }; }
    },
  });
  api.registerTool({
    contextVersion: 2,
    create: context => {
      if (context.agentId !== directRuntimeAgent) return null;
      const check = () => {
        context.assertInvocationCurrent();
        if (typeof context.getRuntimeConfig !== 'function') throw Error('Current tool policy is unavailable.');
        assertDirectConfiguration(context.getRuntimeConfig(), policySha256);
        if (!context.sessionKey || !context.sessionId) throw Error('The original native session is unavailable.');
        const entry = api.runtime.agent.session.getSessionEntry({ agentId: directRuntimeAgent, sessionKey: context.sessionKey, readConsistency: 'latest' });
        if (entry?.sessionId !== context.sessionId || entry.permissionMode !== 'read-only' || entry.permissionModePending)
          throw Error('The original native session or permission changed.');
      };
      check();
      return {
        name: directReadTool, label: 'Read permitted Nova records',
        description: 'Read only the Nova records permitted for this exact saved agent and original turn. No writes, sends, tools or delegated actions. A denied read must not be retried through another tool.',
        parameters: z.toJSONSchema(directReadInputSchema),
        async execute(toolCallId, raw, signal) {
          const result = await calls.consume({ ...context, assertInvocationCurrent: check }, toolCallId, raw, signal,
            async (origin, read, signal) => {
              const account = () => {
                check();
                const entry = api.runtime.agent.session.getSessionEntry({ agentId: directRuntimeAgent, sessionKey: origin.sessionKey, readConsistency: 'latest' });
                if (entry?.authProfileOverride !== origin.accountId) throw Error('The original native account changed.');
              };
              account();
              const result = await bridge('/read', { origin, read }, signal);
              account();
              return result;
            });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: false };
        },
      };
    },
  }, { names: [directReadTool] });
  api.on('after_tool_call', (event, context) => {
    if (event.toolName === directReadTool && event.runId === context.runId && event.toolCallId === context.toolCallId) calls.finish(context);
  });
  api.agent.events.registerAgentEventSubscription({
    id: 'nova-direct-call-closure', streams: ['lifecycle'],
    handle: event => {
      if (['end', 'error'].includes(String(event.data.phase)))
        calls.endRun(event.runId, event.sessionKey?.startsWith('agent:edition3-direct:e3:') === true);
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: 'nova-direct-call-authority', cleanup: context => {
      if (!context.sessionKey && !context.runId) disposed = true;
      calls.cleanup(context);
    }, dispose: () => { disposed = true; calls.dispose(); },
  });
}
export default { id: directPluginId, name: 'Nova Dream direct-agent reads', register: registerDirectAgentTools };
