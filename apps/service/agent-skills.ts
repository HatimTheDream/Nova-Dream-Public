import { installedSkillsSchema, type InstalledSkills } from '../../packages/domain/agent-skills.js';
import type { AssistantTransport } from './gateway.js';
import { Fault } from './store.js';

/** Read the same native main-agent identity used by the Nova Dream worker. */
export class AgentSkills {
  constructor(private gateway: AssistantTransport, private now = Date.now) {}
  async installed(): Promise<InstalledSkills> {
    const connection = this.gateway.status();
    if (connection.state !== 'ready' || !connection.generation) throw new Fault(503, 'skills_disconnected', 'Connect the Assistant on this host to inspect installed skills.');
    if (!connection.grantedScopes.includes('operator.read')) throw new Fault(403, 'skills_permissions', 'This host connection does not allow reading skill availability.');
    if (!connection.methods.includes('skills.status')) throw new Fault(501, 'skills_capability', 'This host does not expose installed skill status.');
    let raw: unknown;
    try { raw = await this.gateway.request('skills.status', { agentId: 'main' }); }
    catch { throw new Fault(503, 'skills_unavailable', 'Installed skills could not be read. Reconnect or refresh this original host.'); }
    const current = this.gateway.status();
    if (current.state !== 'ready' || current.generation !== connection.generation) throw new Fault(409, 'skills_host_changed', 'The Assistant host changed while skills were loading. Refresh the current host.');
    const parsed = installedSkillsSchema.safeParse(raw);
    if (!parsed.success || new Set(parsed.data.skills.map(s => s.skillKey)).size !== parsed.data.skills.length) throw new Fault(502, 'skills_response', 'The host returned an unsupported skill inventory. No availability has been inferred.');
    return { observedAt: this.now(), generation: connection.generation, nativeAgentId: 'main', skills: parsed.data.skills.sort((a, b) => a.name.localeCompare(b.name) || a.skillKey.localeCompare(b.skillKey)) };
  }
}
