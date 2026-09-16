import type { AssistantTransport } from './gateway.js';
import { Fault } from './store.js';

export interface AccessTransport extends AssistantTransport { start(): void; stop(): Promise<void> }
/** Explicit settings control only. Ordinary chat never receives this connection. */
export class SessionSettingsControl {
  private clients = new Set<AccessTransport>();
  private closed = false;
  constructor(private ordinary: AssistantTransport, private factory?: () => AccessTransport, private kind: 'access' | 'response' = 'access') {}
  private unavailable(unauthorized = false) {
    const label = this.kind === 'access' ? 'Full access' : 'Response settings';
    return new Fault(unauthorized ? 403 : 503, this.kind === 'access' ? 'access_not_sent' : 'response_not_sent', unauthorized ? `The host did not authorize ${label} controls. Your current settings are unchanged.` : `${label} controls are unavailable on this connection. Your current settings are unchanged.`);
  }
  async request<T>(method: 'sessions.create' | 'sessions.patch', params: unknown): Promise<T> {
    const base = this.ordinary.status();
    if (this.closed || !this.factory || base.state !== 'ready') throw this.unavailable();
    const control = this.factory(); this.clients.add(control);
    try {
      control.start();
      const deadline = Date.now() + 12000;
      while (!this.closed && ['unconfigured', 'connecting'].includes(control.status().state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 80));
      const state = control.status(), current = this.ordinary.status();
      if (this.closed || current.state !== 'ready' || base.generation !== current.generation || base.url !== current.url || state.generation !== base.generation || state.url !== base.url || state.state !== 'ready' || !state.grantedScopes.includes('operator.admin')) throw this.unavailable(true);
      // Keep model selection on ordinary per-session authority: an admin model
      // patch may also change the host's default model. Retain a partially
      // applied intent if its following effort/speed write is not confirmed.
      const patch = params as Record<string, unknown>;
      if (this.kind === 'response' && method === 'sessions.patch' && Object.hasOwn(patch, 'model')) {
        const { model, ...response } = patch;
        await this.ordinary.request(method, { key: patch.key, expectedSessionId: patch.expectedSessionId, model });
        try { return await control.request<T>(method, response); }
        catch { throw new Fault(409, 'response_partial', 'The model was updated, but the remaining response settings are not confirmed. Check their current state.'); }
      }
      return await control.request<T>(method, params);
    } finally {
      // A teardown error cannot turn a confirmed setting into an unknown edit.
      try { await control.stop(); this.clients.delete(control); } catch { /* Retain for workspace shutdown. */ }
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.clients].map(client => client.stop())); this.clients.clear(); }
}
