import { z } from 'zod';
export const agentModules = ['tasks', 'calendar', 'inbox', 'contacts', 'content', 'projects', 'profile', 'home', 'computer'] as const;
export const agentAccessSchema = z.partialRecord(z.enum(agentModules), z.enum(['read', 'edit'])).default({});
export type AgentAccess = Partial<Record<typeof agentModules[number], 'read' | 'edit'>>;
const recordModule: Record<string, typeof agentModules[number]> = { task: 'tasks', routine: 'tasks', contact: 'contacts', content: 'content', project: 'projects', profile: 'profile', layout: 'home' };
/** Both the pinned design and current design must allow access. A live edit can
 * revoke access immediately, but cannot enlarge an already running assignment. */
export function agentMayUse(pinned: AgentAccess, current: AgentAccess, operation: string, input: Record<string, unknown>, write: boolean) {
  if (operation.startsWith('sources.')) return !write && ['projects', 'content'].some(key => !!pinned[key as keyof AgentAccess] && !!current[key as keyof AgentAccess]);
  if (operation === 'catalog' || operation === 'actions.read') return !write;
  if (operation === 'accounts.list') return !write && ['calendar', 'inbox', 'contacts'].some(module => pinned[module as keyof AgentAccess] && current[module as keyof AgentAccess]);
  // Quest steps and their evidence are canonical Tasks; Profile access alone
  // cannot grant a task capability that the agent was not given.
  if (operation.startsWith('profile.')) return ['profile', 'tasks'].every(key => !!pinned[key as keyof AgentAccess] && !!current[key as keyof AgentAccess] && (!write || pinned[key as keyof AgentAccess] === 'edit' && current[key as keyof AgentAccess] === 'edit'));
  const module = operation.startsWith('records.') ? recordModule[String(input.kind)] : operation.split('.')[0] as keyof AgentAccess;
  return !!module && !!pinned[module] && !!current[module] && (!write || pinned[module] === 'edit' && current[module] === 'edit');
}
export const assignmentRuntimeAgent = 'edition3-assignment';
export const assignmentNativeRuntimeAgent = 'edition3-native-assignment';
export const assignmentRuntimePolicy = { name: 'Nova Dream assignments', skills: [] as string[], tools: { allow: ['nova_read', 'nova_write'], elevated: { enabled: false } }, subagents: { allowAgents: [] as string[] } };
export const nativeToolNamesSchema = z.array(z.string().regex(/^[a-z0-9_-]+__[a-zA-Z0-9_-]+$/)).max(64).refine(names => new Set(names).size === names.length);
/** Only an explicitly selected assignment agent with a finite exact filter
 * may receive native MCP tools. Main Assistant registration is insufficient. */
export function configuredAssignmentNativeTools(raw: unknown): string[] {
  const config = z.object({ mcp: z.object({ servers: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() }).passthrough().parse(raw ?? {});
  const names: string[] = [];
  for (const [name, rawServer] of Object.entries(config.mcp?.servers ?? {})) {
    if (!rawServer || typeof rawServer !== 'object') continue;
    const server = rawServer as Record<string, any>;
    if (server.enabled === false || !Array.isArray(server.codex?.agents) || !server.codex.agents.includes(assignmentNativeRuntimeAgent)) continue;
    if (!/^[a-z0-9_-]+$/.test(name) || !Array.isArray(server.toolFilter?.include) || !server.toolFilter.include.length || server.codex.defaultToolsApprovalMode !== 'prompt') throw new Error('Assignment MCP access requires an exact tool filter and native prompt approval.');
    for (const tool of server.toolFilter.include) {
      if (typeof tool !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tool)) throw new Error('Assignment MCP filters must name exact tools.');
      if (!server.toolFilter.exclude?.includes(tool)) names.push(`${name}__${tool}`);
    }
  }
  return nativeToolNamesSchema.parse([...new Set(names)].sort());
}
export function assignmentPolicyWithNativeTools(names: string[] = []) {
  return { ...assignmentRuntimePolicy, tools: { ...assignmentRuntimePolicy.tools, allow: [...assignmentRuntimePolicy.tools.allow, ...nativeToolNamesSchema.parse(names)] } };
}
/** Native schema parsing reorders object fields. Compare the complete policy,
 * including unexpected grants, without treating key order as permission. */
export function matchesAssignmentRuntimePolicy(value: unknown, nativeTools: string[] = []): boolean {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)])) : v;
  return JSON.stringify(ordered(value)) === JSON.stringify(ordered(assignmentPolicyWithNativeTools(nativeTools)));
}
