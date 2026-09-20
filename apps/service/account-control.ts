import type { AssistantTransport } from './gateway.js';
import type { AccessTransport } from './full-access.js';
import { Fault } from './store.js';

/** Separate finite administrator channel; ordinary chat retains read/write scopes only. */
export class ChatGptAccountControl {
  private clients = new Set<AccessTransport>();
  private closed = false;
  constructor(private ordinary: AssistantTransport, private factory?: () => AccessTransport) {}
  async request<T>(method: 'models.authOrderSet', params: unknown, beforeSend?: () => void): Promise<T> {
    const base = this.ordinary.status();
    if (this.closed || !this.factory || base.state !== 'ready') throw new Fault(503, 'account_order_unavailable', 'Account selection is unavailable on this connection.');
    const control = this.factory(); this.clients.add(control);
    try {
      control.start();
      const deadline = Date.now() + 12000;
      while (!this.closed && ['unconfigured', 'connecting'].includes(control.status().state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 80));
      const state = control.status(), current = this.ordinary.status();
      if (this.closed || current.state !== 'ready' || base.generation !== current.generation || base.url !== current.url || state.generation !== base.generation || state.url !== base.url || state.state !== 'ready' || !state.grantedScopes.includes('operator.admin')) throw new Fault(403, 'account_order_not_sent', 'The host did not authorize account selection. The current order is unchanged.');
      beforeSend?.();
      return await control.request<T>(method, params);
    } finally { try { await control.stop(); this.clients.delete(control); } catch { /* Retain the owned client for shutdown. */ } }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.clients].map(client => client.stop())); this.clients.clear(); }
}
