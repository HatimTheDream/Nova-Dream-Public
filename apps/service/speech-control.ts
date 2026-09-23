import type { AssistantTransport } from './gateway.js';
import type { AccessTransport } from './full-access.js';
import { Fault } from './store.js';

/** On-demand speech authority; a denied speech connection never replaces ordinary chat. */
export class SpeechGatewayControl implements AssistantTransport {
  private client?: AccessTransport;
  private opening?: Promise<void>;
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private requests = 0;
  constructor(private ordinary: AssistantTransport, private factory: () => AccessTransport) {}
  status() { return this.client?.status() ?? { ...this.ordinary.status(), state: 'unconfigured' as const, grantedScopes: [] }; }
  models() { return this.ordinary.models(); }
  attachmentPolicy() { return this.ordinary.attachmentPolicy(); }
  subscribe: AssistantTransport['subscribe'] = () => () => {};
  private current() {
    const ordinary = this.ordinary.status(), speech = this.client?.status();
    return !this.closed && ordinary.state === 'ready' && speech?.state === 'ready' && speech.generation === ordinary.generation && speech.url === ordinary.url && speech.grantedScopes.includes('operator.talk');
  }
  private scheduleClose() {
    if (this.idle) clearTimeout(this.idle);
    if (this.closed || this.requests) return;
    this.idle = setTimeout(() => { const client = this.client; this.client = undefined; void client?.stop().catch(() => undefined); }, 60000);
    this.idle.unref();
  }
  async prepare() {
    if (this.idle) clearTimeout(this.idle);
    if (this.current()) { this.scheduleClose(); return; }
    if (this.opening) return this.opening;
    this.opening = this.connect().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async connect() {
    const base = this.ordinary.status();
    if (this.closed || base.state !== 'ready') throw new Fault(503, 'speech_connection', 'Connect the Assistant before using its reading voice.');
    if (this.client) await this.client.stop();
    if (this.closed) throw new Fault(503, 'speech_connection', 'The reading voice connection is closed.');
    const client = this.factory(); this.client = client;
    try {
      client.start();
      const deadline = Date.now() + 6000;
      while (!this.closed && ['unconfigured', 'connecting'].includes(client.status().state) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 80));
      if (!this.current() || this.ordinary.status().generation !== base.generation || this.ordinary.status().url !== base.url) throw new Fault(403, 'speech_permission', 'The reading voice connection is not authorized. You can use your device voice instead.');
      this.scheduleClose();
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await client.stop().catch(() => undefined);
      throw error;
    }
  }
  async request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    if (!['talk.catalog', 'talk.speak'].includes(method)) throw new Fault(403, 'speech_method', 'This connection is only for reading replies aloud.');
    await this.prepare();
    const client = this.client;
    if (!client || !this.current()) throw new Fault(409, 'speech_changed', 'The reading connection changed before playback could start.');
    this.requests++;
    if (this.idle) clearTimeout(this.idle);
    try {
      const result = await client.request<T>(method, params);
      if (this.client !== client || !this.current()) throw new Fault(409, 'speech_changed', 'The reading connection changed before its audio arrived.');
      return result;
    } finally { this.requests--; this.scheduleClose(); }
  }
  async close() {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    await this.opening?.catch(() => undefined);
    const client = this.client; this.client = undefined;
    await client?.stop();
  }
}
