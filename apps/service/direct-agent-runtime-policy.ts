import { createHash } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { directReadTool, directRuntimeAgent } from './direct-agent-tool-calls.js';

export const directPluginId = 'edition3-direct-agent';
export const directToolPolicyId = 'nova-direct-read-only';
export const directKnownPlugins = new Set(['openai', 'codex', 'browser', 'document-extract',
  'edition3-worker', 'edition3-workspace', 'edition3-sources', 'edition3-accounts', directPluginId]);
export const directRuntimePolicy = {
  name: 'Nova Dream direct agent', skills: [] as string[],
  contextInjection: 'never',
  tools: { allow: [directReadTool], elevated: { enabled: false } },
  subagents: { allowAgents: [] as string[] },
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('The managed runtime configuration is unavailable.');
  return value as Record<string, unknown>;
};
/** Compare the complete resolved configuration. Exclude only this field's own
 * self-reference, not plugin paths, tokens, model policy or hook contributors.
 * A matching digest is a drift check, not native runtime qualification. */
export function directConfigurationHash(raw: unknown): string {
  const config = structuredClone(object(raw));
  const plugins = object(config.plugins), entries = object(plugins.entries);
  const entry = object(entries[directPluginId]), own = object(entry.config);
  delete own.policySha256;
  const text = canonical(config);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error('The managed runtime configuration is too large.');
  return createHash('sha256').update(text).digest('hex');
}
export function assertDirectConfiguration(raw: unknown, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || directConfigurationHash(raw) !== expected)
    throw Error('The qualified direct-agent configuration changed.');
  assertDirectConfigurationShape(raw);
}
/** Source configuration and the SDK's resolved snapshot have different hashes.
 * Both must retain this exact dedicated policy; neither hash qualifies native
 * inference by itself. */
export function assertDirectConfigurationShape(raw: unknown) {
  const config = object(raw), plugins = object(config.plugins), entries = object(plugins.entries);
  if (plugins.enabled !== true || object(entries[directPluginId]).enabled !== true
    || !Array.isArray(plugins.allow) || !plugins.allow.includes(directPluginId)
    || plugins.allow.some(id => typeof id !== 'string' || !directKnownPlugins.has(id))
    || Object.entries(entries).some(([id, value]) => object(value).enabled !== false && !directKnownPlugins.has(id)))
    throw Error('The dedicated read policy is not enabled.');
  const agents = object(config.agents), entriesMap = object(agents.entries);
  const empty = (value: unknown) => value === undefined || Object.keys(object(value)).length === 0;
  if (config.$include || agents.list || !empty(config.hooks) || !empty(config.channels)
    || config.bindings !== undefined && (!Array.isArray(config.bindings) || config.bindings.length)
    || object(config.cron).enabled !== false || object(object(agents.defaults).heartbeat).every !== '0m'
    || object(config.update).checkOnStart !== false || object(object(config.update).auto).enabled !== false
    || object(object(config.models).catalogRefresh).enabled !== false)
    throw Error('The controlled runtime has an unqualified policy contributor.');
  for (const value of Object.values(entriesMap)) {
    const policy = object(value);
    if (policy.hooks || policy.channel || policy.heartbeat && object(policy.heartbeat).every !== '0m')
      throw Error('The controlled runtime has an unqualified agent contributor.');
  }
  const entry = object(entriesMap[directRuntimeAgent]);
  // Exact policy includes separate, explicitly admitted workspace/agentDir.
  const { workspace, agentDir, ...policy } = entry;
  if (typeof workspace !== 'string' || !workspace || typeof agentDir !== 'string' || !agentDir
    || workspace === agentDir || canonical(policy) !== canonical(directRuntimePolicy))
    throw Error('The dedicated agent policy changed.');
  const gateway = object(config.gateway);
  if (gateway.bind !== 'loopback' || object(gateway.controlUi).enabled !== false)
    throw Error('The managed direct-agent control policy changed.');
}
