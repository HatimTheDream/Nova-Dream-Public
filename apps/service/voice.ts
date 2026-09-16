import { z } from 'zod';
import type { VoiceCatalog } from '../../packages/domain/voice.js';
import type { AssistantTransport } from './gateway.js';

const choices = z.array(z.string().min(1).max(256)).max(500).default([]);
const provider = z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(200), configured: z.boolean(), models: choices, voices: choices, voicesByModel: z.record(z.string().max(256), choices).default({}), modes: choices, transports: choices, brains: choices, supportsBrowserSession: z.boolean().optional() });
const catalog = z.object({ realtime: z.object({ ready: z.boolean().optional(), providers: z.array(provider).max(100) }) });

/** Advertised provider readiness is distinct from a successfully measured call. */
export function projectVoiceCatalog(raw: unknown): VoiceCatalog {
  const result = catalog.safeParse(raw);
  if (!result.success) return { state: 'unverified', message: 'OpenClaw returned voice information this build cannot verify.', providers: [] };
  const { realtime } = result.data;
  const providers = realtime.providers.map(p => ({ id: p.id, label: p.label, configured: p.configured, models: p.models, voices: p.voices, voicesByModel: p.voicesByModel, browserSupported: p.supportsBrowserSession === true && p.transports.includes('webrtc') && p.brains.includes('agent-consult') && p.modes.includes('realtime') }));
  if (realtime.ready === undefined) return { state: 'unverified', message: 'This OpenClaw version has not confirmed voice account readiness.', providers };
  if (!realtime.ready) return { state: 'unconfigured', message: 'OpenClaw has no configured browser voice connection. Connect ChatGPT on this host.', providers };
  if (!providers.some(p => p.configured && p.browserSupported)) return { state: 'unverified', message: 'OpenClaw has voice access, but has not advertised a browser route supported by this build.', providers };
  return { state: 'available', message: 'OpenClaw recognizes a configured browser voice connection. An actual call still needs to connect.', providers };
}

export class VoiceSetup {
  private cached?: { generation: string | undefined; expiresAt: number; value: VoiceCatalog };
  private pending?: Promise<VoiceCatalog>;
  constructor(private gateway: AssistantTransport) {}
  async read(): Promise<VoiceCatalog> {
    const connection = this.gateway.status();
    if (connection.state !== 'ready') {
      this.cached = undefined;
      return { state: 'disconnected', message: 'Connect the Assistant before checking voice access.', providers: [] };
    }
    if (this.cached && this.cached.generation === connection.generation && this.cached.expiresAt > Date.now()) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const raw = await this.gateway.request('talk.catalog', {});
        const current = this.gateway.status();
        if (current.generation !== connection.generation || current.state !== 'ready') return { state: 'disconnected' as const, message: 'The Assistant connection changed. Check voice access again.', providers: [] };
        const value = projectVoiceCatalog(raw);
        this.cached = { generation: connection.generation, expiresAt: Date.now() + 5000, value };
        return value;
      } catch {
        return { state: 'unverified' as const, message: 'OpenClaw could not confirm voice access. Your ChatGPT sign-in is kept.', providers: [] };
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
