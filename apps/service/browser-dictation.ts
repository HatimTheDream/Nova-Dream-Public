import { z } from 'zod';
import type { AssistantTransport } from './gateway.js';
import { Fault } from './store.js';
import type { DictationAttempt } from '../../packages/domain/dictation.js';

/** Browser-owned audio; this route never forwards captions or tool calls as chat. */
export class BrowserDictation {
  private sessions = new Map<string, { secret?: string; offerUrl: string; generation: string; abort: AbortController }>();
  constructor(private gateway: AssistantTransport, private exchange: typeof fetch = fetch) {}
  async prepare(a: DictationAttempt, catalog: any, capture?: (identity: Pick<DictationAttempt, 'route' | 'nativeId' | 'nativeKey' | 'browserNativeId'>) => void): Promise<Pick<DictationAttempt, 'route' | 'nativeId' | 'nativeKey' | 'browserNativeId'>> {
    const provider = catalog.realtime?.providers?.find((p: any) => p.id === 'openai' && p.configured && p.supportsBrowserSession && p.transports?.includes('webrtc'));
    const model = provider?.models?.find((m: string) => /^gpt-realtime-2(?:\.1(?:-mini)?)?$/.test(m));
    if (!model) throw new Fault(409, 'dictation_unconfigured', 'Connect ChatGPT voice in Settings to use dictation.');
    const session = await this.gateway.request<{ key: string; sessionId: string }>('sessions.create', { key: `e3:dictation:${a.id}`, idempotencyKey: a.id, permissionMode: 'read-only', emitCommandHooks: false });
    const identity = { route: 'browser' as const, nativeId: a.id, nativeKey: session.key, browserNativeId: session.sessionId };
    if (!session.key.endsWith(`e3:dictation:${a.id}`) || !session.sessionId) throw new Error('Unexpected dictation session identity.');
    capture?.(identity);
    try {
      const result = z.object({ provider: z.literal('openai'), transport: z.literal('webrtc'), voiceSessionId: z.literal(a.id), clientSecret: z.string().min(1).max(8192), offerUrl: z.literal('/plugins/openai/realtime/calls'), clientControl: z.unknown().optional() }).parse(await this.gateway.request('talk.client.create', { sessionKey: session.key, voiceSessionId: a.id, provider: 'openai', model, mode: 'realtime', transport: 'webrtc', brain: 'agent-consult', capabilities: ['voice-transcript'] }));
      if (result.clientControl) throw Error('Dictation needs the browser-owned audio route.');
      const status = this.gateway.status(); if (status.generation !== a.generation || !status.url) throw Error('Dictation connection changed.');
      const gatewayUrl = new URL(status.url); gatewayUrl.protocol = gatewayUrl.protocol === 'wss:' ? 'https:' : 'http:';
      this.sessions.set(a.id, { secret: result.clientSecret, offerUrl: new URL(result.offerUrl, gatewayUrl.origin).href, generation: a.generation, abort: new AbortController() });
      return identity;
    } catch (error) { await this.close({ ...a, ...identity }); throw error; }
  }
  async offer(a: DictationAttempt, sdp: string) {
    const session = this.sessions.get(a.id);
    if (!session?.secret || session.generation !== this.gateway.status().generation) throw new Fault(409, 'dictation_offer_expired', 'This microphone connection expired. Start dictation again.');
    const secret = session.secret; session.secret = undefined;
    const response = await this.exchange(session.offerUrl, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' }, body: sdp, redirect: 'error', signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(30000)]) });
    if (!response.ok || !response.body) throw new Fault(409, 'dictation_offer_failed', 'The microphone connection was rejected. Try dictation again.');
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 262144) throw Error('Invalid audio answer'); parts.push(part.value); } } finally { await reader.cancel().catch(() => undefined); }
    const answer = Buffer.concat(parts).toString(); if (!answer.startsWith('v=0')) throw Error('Invalid audio answer');
    if (session.generation !== this.gateway.status().generation || session.abort.signal.aborted) throw Error('Dictation connection changed');
    return { sdp: answer };
  }
  async close(a: DictationAttempt) {
    this.sessions.get(a.id)?.abort.abort(); this.sessions.delete(a.id);
    if (this.gateway.status().generation !== a.generation || !a.nativeKey?.endsWith(`e3:dictation:${a.id}`)) return false;
    if (!a.browserNativeId) return false;
    const current = () => this.gateway.status().generation === a.generation;
    try {
      const result = await this.gateway.request<{ session: { key: string; sessionId: string; hasActiveRun?: boolean; activeRunIds?: string[] } | null }>('sessions.describe', { key: a.nativeKey });
      if (!current()) return false;
      if (result.session === null) return true; // A lost delete acknowledgement is already settled.
      const session = result.session;
      if (!session || session.key !== a.nativeKey || session.sessionId !== a.browserNativeId || session.hasActiveRun || session.activeRunIds?.length) return false;
      await this.gateway.request('talk.client.close', { sessionKey: a.nativeKey, voiceSessionId: a.id });
      if (!current()) return false;
      // Ordinary write authority permits deletion of archived sessions. Archive
      // only this exact empty backing session, preserving replacement identities.
      await this.gateway.request('sessions.patch', { key: a.nativeKey, expectedSessionId: a.browserNativeId, archived: true });
      if (!current()) return false;
      const removed = await this.gateway.request<{ ok: boolean; key: string; deleted: boolean }>('sessions.delete', { key: a.nativeKey, expectedSessionId: a.browserNativeId, archivedOnly: true, deleteTranscript: true });
      return current() && removed.ok === true && removed.key === a.nativeKey && removed.deleted === true;
    } catch { return false; }
  }
}
