import { createHash } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { directReadTool, directRuntimeAgent } from './direct-agent-tool-calls.js';

export const directPluginId = 'edition3-direct-agent';
export const directToolPolicyId = 'nova-direct-read-only';
export const directRuntimePolicy = {
  name: 'Nova Dream direct agent', skills: [] as string[],
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
  const config = object(raw), plugins = object(config.plugins), entries = object(plugins.entries);
  if (plugins.enabled !== true || object(entries[directPluginId]).enabled !== true
    || !Array.isArray(plugins.allow) || !plugins.allow.includes(directPluginId))
    throw Error('The dedicated read policy is not enabled.');
  const agents = object(config.agents), entriesMap = object(agents.entries);
  const entry = object(entriesMap[directRuntimeAgent]);
  // Exact policy includes separate, explicitly admitted workspace/agentDir.
  const { workspace, agentDir, ...policy } = entry;
  if (typeof workspace !== 'string' || !workspace || typeof agentDir !== 'string' || !agentDir
    || workspace === agentDir || canonical(policy) !== canonical(directRuntimePolicy))
    throw Error('The dedicated agent policy changed.');
  const gateway = object(config.gateway);
  if (object(gateway.controlUi).enabled !== false) throw Error('The managed direct-agent control policy changed.');
}
