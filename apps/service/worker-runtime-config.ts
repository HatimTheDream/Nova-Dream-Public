import { z } from 'zod';
import { assignmentRuntimeAgent, assignmentNativeRuntimeAgent, assignmentRuntimePolicy, assignmentPolicyWithNativeTools, configuredAssignmentNativeTools, nativeToolNamesSchema, matchesAssignmentRuntimePolicy } from '../../packages/domain/agent-capabilities.js';
import { workerPluginId } from '../../packages/domain/worker.js';

const configSchema = z.object({ plugins: z.object({ enabled: z.boolean().optional(), allow: z.array(z.string()).optional(), load: z.object({ paths: z.array(z.string()).optional() }).passthrough().optional(), entries: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() }).passthrough();
export function withWorkerPlugin(raw: unknown, epoch: string, bundlePath: string, receiptDirectory: string) {
  const config = configSchema.parse(raw), plugins = config.plugins ?? {};
  if (plugins.enabled === false) throw new Error('Plugins are disabled in this owned runtime. Review its configuration before enabling agent assignments.');
  const previous = z.object({ enabled: z.boolean().optional(), config: z.object({ epoch: z.string().optional(), bundlePath: z.string().optional(), nativeTools: nativeToolNamesSchema.optional() }).passthrough().optional() }).passthrough().parse(plugins.entries?.[workerPluginId] ?? {});
  if (previous.enabled === false) throw new Error('The assignment worker is explicitly disabled in this runtime.');
  const agents = z.object({ entries: z.record(z.string(), z.unknown()).optional(), defaults: z.object({ systemAgent: z.object({ agentId: z.string().optional() }).passthrough().optional() }).passthrough().optional() }).passthrough().parse(config.agents ?? {});
  const previousAgent = agents.entries?.[assignmentRuntimeAgent], nativeTools = configuredAssignmentNativeTools(config);
  if (previousAgent && !matchesAssignmentRuntimePolicy(previousAgent)) throw new Error('The assignment runtime policy was changed. Review the dedicated agent before enabling module tools.');
  const previousNative = agents.entries?.[assignmentNativeRuntimeAgent];
  if (previousNative && !matchesAssignmentRuntimePolicy(previousNative, previous.config?.nativeTools ?? [])) throw new Error('The native assignment policy changed. Review its exact tool access.');
  const paths = [...new Set([...(plugins.load?.paths ?? []).filter(path => path !== previous.config?.bundlePath), bundlePath])];
  return Object.assign({}, config, { agents: { ...agents, ownership: agents.ownership ?? 'explicit', defaults: { ...agents.defaults, systemAgent: { agentId: 'main', ...agents.defaults?.systemAgent } }, entries: { main: {}, ...agents.entries, [assignmentRuntimeAgent]: assignmentRuntimePolicy, ...(nativeTools.length || previousNative ? { [assignmentNativeRuntimeAgent]: assignmentPolicyWithNativeTools(nativeTools) } : {}) } }, plugins: { ...plugins, enabled: true, allow: [...new Set([...(plugins.allow ?? []), workerPluginId])], load: { ...plugins.load, paths }, entries: { ...plugins.entries, [workerPluginId]: { enabled: true, config: { epoch, bundlePath, receiptDirectory, ...(nativeTools.length ? { nativeTools } : {}) } } } } });
}
