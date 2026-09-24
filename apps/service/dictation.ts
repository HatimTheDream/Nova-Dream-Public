import { BrowserDictation } from './browser-dictation.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import { dictationActionSchema, dictationAudioSchema, dictationStartSchema, type DictationAttempt } from '../../packages/domain/dictation.js';
import { orderDictationTurns } from '../../packages/domain/dictation-order.js';
import type { AssistantTransport } from './gateway.js';
import { Fault, Store } from './store.js';

/** Adapts Nova's transcription-only relay. Audio is never stored or dispatched as chat. */
export class DictationService {
  private closed = false;
  private browser: BrowserDictation;
  private stopListening: () => void;
  private timer: ReturnType<typeof setInterval>;
  private ending = new Map<string, Promise<void>>();
  private preparing = new Map<string, Promise<void>>();
  private cleaning = new Map<string, Promise<void>>();
  get updateMaintenanceBusy() { return this.preparing.size + this.ending.size + this.cleaning.size; }
  constructor(private store: Store, private gateway: AssistantTransport) {
    this.browser = new BrowserDictation(gateway);
    for (const a of this.all()) if (!['ended', 'failed'].includes(a.state)) this.save({ ...a, state: 'failed', ...(a.route === 'browser' ? { cleanupPending: true } : {}), error: 'Dictation stopped when the app restarted. Available text is kept.' });
    this.stopListening = gateway.subscribe(event => this.event(event));
    this.timer = setInterval(() => { for (const a of this.all()) { if (['preparing', 'listening'].includes(a.state) && Date.now() - a.updatedAt > 15000) void this.finish(a.id); else if (a.cleanupPending) this.cleanup(a); } }, 5000); this.timer.unref();
  }
  private cleanup(a: DictationAttempt) {
    if (this.closed || this.cleaning.has(a.id) || this.gateway.status().state !== 'ready' || this.gateway.status().generation !== a.generation) return;
    const pending = this.browser.close(a).then(cleaned => { if (cleaned) this.save({ ...this.get(a.id), cleanupPending: false }); }).finally(() => this.cleaning.delete(a.id));
    this.cleaning.set(a.id, pending);
  }
  private all() { return this.store.internalList<DictationAttempt>('dictation:'); }
  private save(a: DictationAttempt) { return this.store.internalWrite(`dictation:${a.id}`, a); }
  private get(id: string) { const a = this.store.internalRead<DictationAttempt>(`dictation:${id}`); if (!a) throw new Fault(404, 'dictation_missing', 'This dictation attempt is unavailable.'); return a; }
  read(device: string, id: string) { const a = this.get(id); if (a.deviceId !== device) throw new Fault(403, 'dictation_owner', 'This dictation belongs to another device.'); if (a.route === 'browser' && a.state === 'listening') { this.connected(a); return this.save({ ...a, updatedAt: Date.now() }); } return a; }
  private connected(a?: DictationAttempt) { const s = this.gateway.status(); if (this.closed || s.state !== 'ready' || !s.grantedScopes.includes('operator.write') || a && (a.epoch !== this.store.epoch || a.generation !== s.generation)) throw new Fault(409, 'dictation_disconnected', 'Dictation lost its original connection. Available text is kept.'); return s; }
  start(device: string, raw: unknown) {
    this.store.assertUpdateAdmission();
    const input = dictationStartSchema.parse(raw), connection = this.connected();
    const receipt = this.store.admit(device, input, { type: 'dictation.start', ...input }, () => {
      const conversationId = input.draftId !== `draft:${device}:work` && input.draftId.startsWith(`draft:${device}:`) ? input.draftId.slice(`draft:${device}:`.length) : undefined;
      if (conversationId && (this.store.internalRead(`assistant:removed:${conversationId}`) || this.store.internalList<{ conversationId: string; state: string }>('assistant:removal:').some(a => a.conversationId === conversationId && ['prepared', 'unknown'].includes(a.state)))) throw new Fault(409, 'conversation_removed', 'This conversation is being removed. Dictate into a new chat.');
      if (this.all().some(a => a.deviceId === device && ['preparing', 'listening', 'ending'].includes(a.state))) throw new Fault(409, 'dictation_active', 'Finish the current dictation first.');
      return this.save({ id: randomUUID(), requestId: input.requestId, epoch: input.epoch, deviceId: device, draftId: input.draftId, generation: connection.generation!, state: 'preparing', text: '', final: false, sequence: -1, updatedAt: Date.now() });
    });
    if (receipt.fresh) { const id = receipt.value.id; this.preparing.set(id, this.prepare(id).finally(() => this.preparing.delete(id))); }
    return this.read(device, receipt.value.id);
  }
  private async prepare(id: string) {
    let nativeId: string | undefined;
    try {
      const original = this.get(id); this.connected(original);
      const catalog = await this.gateway.request<any>('talk.catalog', {});
      const providers = catalog.transcription?.providers ?? [];
      const provider = providers.find((p: any) => p.configured && p.id === catalog.transcription?.activeProvider) ?? providers.find((p: any) => p.configured);
      const browserReady = catalog.realtime?.providers?.some((p: any) => p.id === 'openai' && p.configured && p.supportsBrowserSession && p.transports?.includes('webrtc'));
      if (browserReady) {
        const prepared = await this.browser.prepare(original, catalog, identity => this.save({ ...this.get(id), ...identity }));
        this.save({ ...this.get(id), ...prepared }); this.connected(original);
        if (this.get(id).state !== 'preparing') { await this.browser.close({ ...original, ...prepared }); return; }
        this.save({ ...this.get(id), ...prepared, state: 'listening', updatedAt: Date.now() }); return;
      }
      if (!provider) throw new Fault(409, 'dictation_unconfigured', 'Connect ChatGPT voice in Settings to use dictation.');
      this.connected(original); if (this.get(id).state !== 'preparing') return;
      this.store.assertUpdateAdmission();
      const result = await this.gateway.request<any>('talk.session.create', { provider: provider.id, mode: 'transcription', transport: 'gateway-relay', brain: 'none', ttlMs: 120000 });
      nativeId = typeof result.sessionId === 'string' ? result.sessionId : undefined;
      if (result.mode !== 'transcription' || result.brain !== 'none' || result.transport !== 'gateway-relay' || !nativeId || typeof result.transcriptionSessionId !== 'string' || !['g711_ulaw', 'pcm16'].includes(result.audio?.inputEncoding) || ![8000, 16000, 24000, 48000].includes(result.audio?.inputSampleRateHz)) throw new Fault(409, 'dictation_format', 'The transcription audio format is not supported.');
      this.connected(original);
      if (this.get(id).state !== 'preparing') { await this.gateway.request('talk.session.close', { sessionId: nativeId }); return; }
      this.save({ ...this.get(id), nativeId, transcriptId: result.transcriptionSessionId, encoding: result.audio.inputEncoding === 'g711_ulaw' ? 'mulaw' : 'pcm16', sampleRate: result.audio.inputSampleRateHz, state: 'listening', updatedAt: Date.now() });
    } catch (e) {
      if (nativeId && this.gateway.status().generation === this.get(id).generation) await this.gateway.request('talk.session.close', { sessionId: nativeId }).catch(() => undefined);
      if (this.get(id).route === 'browser') { const cleaned = await this.browser.close(this.get(id)); this.save({ ...this.get(id), cleanupPending: !cleaned }); }
      if (!this.closed && this.get(id).state === 'preparing') this.save({ ...this.get(id), state: 'failed', error: e instanceof Fault ? e.message : 'Dictation could not connect. No message was sent.' });
    }
  }
  async offer(device: string, raw: unknown) {
    const input = dictationActionSchema.extend({ sdp: z.string().startsWith('v=0').max(262144) }).strict().parse(raw), a = this.read(device, input.attemptId); this.connected(a);
    if (input.epoch !== a.epoch || a.route !== 'browser' || a.state !== 'listening') throw new Fault(409, 'dictation_ended', 'Start dictation again to connect the microphone.');
    const admitted = this.store.admit(device, input, { type: 'dictation.offer', ...input }, () => ({ attemptId: a.id }));
    if (!admitted.fresh) throw new Fault(409, 'dictation_offer_unknown', 'This one-use connection was already attempted. Start dictation again.');
    return this.browser.offer(a, input.sdp);
  }
  caption(device: string, raw: unknown) {
    const input = dictationActionSchema.extend({ turnId: z.string().min(1).max(256), text: z.string().max(100000), final: z.literal(true), order: z.number().int().min(0).max(499).optional(), previousTurnId: z.string().min(1).max(256).nullable().optional() }).strict().refine(value => value.previousTurnId !== value.turnId).parse(raw), a = this.read(device, input.attemptId); this.connected(a);
    if (a.route !== 'browser' || input.epoch !== a.epoch || !['listening', 'ending'].includes(a.state)) throw new Fault(409, 'dictation_ended', 'These words belong to an ended dictation.');
    this.store.admit(device, input, { type: 'dictation.caption', ...input }, () => {
      const current = this.get(a.id), turns = [...current.turns ?? []], index = turns.findIndex(t => t.id === input.turnId), prior = turns[index];
      if (prior && (prior.text !== input.text || prior.order !== undefined && input.order !== undefined && prior.order !== input.order || prior.previousTurnId !== undefined && input.previousTurnId !== undefined && prior.previousTurnId !== input.previousTurnId)) throw new Fault(409, 'dictation_caption_changed', 'The original dictated words are kept.');
      const turn = { ...prior, id: input.turnId, text: input.text, final: true, ...(input.order !== undefined ? { order: input.order } : {}), ...(input.previousTurnId !== undefined ? { previousTurnId: input.previousTurnId } : {}) };
      if (prior) turns[index] = turn;
      else { if (turns.length >= 500) throw new Fault(409, 'dictation_limit', 'Recording reached its limit. Available words are kept.'); turns.push(turn); }
      const ordered = orderDictationTurns(turns), text = ordered.map(t => t.text).filter(Boolean).join('\n');
      if (text.length > 100000) throw new Fault(409, 'dictation_limit', 'Recording reached its limit. Available words are kept.');
      return this.save({ ...current, turns: ordered, text, final: true, updatedAt: Date.now() });
    }); return this.read(device, a.id);
  }
  async audio(device: string, raw: unknown) {
    const input = dictationAudioSchema.parse(raw), a = this.read(device, input.attemptId); this.connected(a);
    if (input.epoch !== a.epoch || a.state !== 'listening' || !a.transcriptId) throw new Fault(409, 'dictation_ended', 'Dictation has ended.');
    if (input.sequence <= a.sequence) return a;
    if (input.sequence !== a.sequence + 1) throw new Fault(409, 'dictation_audio_gap', 'Dictation audio was interrupted. Available text is kept.');
    this.save({ ...a, sequence: input.sequence, updatedAt: Date.now() });
    try { await this.gateway.request('talk.session.appendAudio', { sessionId: a.transcriptId, audioBase64: input.audio }); }
    catch { await this.finish(a.id); throw new Fault(409, 'dictation_audio_unknown', 'Dictation audio delivery was interrupted. Available text is kept.'); }
    return this.read(device, a.id);
  }
  async end(device: string, raw: unknown) { const input = dictationActionSchema.parse(raw), a = this.read(device, input.attemptId); if (input.epoch !== a.epoch) throw new Fault(409, 'epoch_changed', 'This dictation belongs to the previous workspace.'); await this.finish(a.id); return this.read(device, a.id); }
  private async finish(id: string) {
    if (this.ending.has(id)) return this.ending.get(id);
    const a = this.get(id); if (['ended', 'failed'].includes(a.state)) return;
    const work = (async () => {
      this.save({ ...a, state: 'ending' });
      if (a.route === 'browser') { const cleaned = await this.browser.close(a); this.save({ ...this.get(id), state: 'ended', cleanupPending: !cleaned, updatedAt: Date.now() }); return; }
      if (a.nativeId && this.gateway.status().generation === a.generation) await this.gateway.request('talk.session.close', { sessionId: a.nativeId }).catch(() => undefined);
      await new Promise(r => setTimeout(r, 350));
      this.save({ ...this.get(id), state: 'ended', updatedAt: Date.now() });
    })().finally(() => this.ending.delete(id));
    this.ending.set(id, work); return work;
  }
  private event(event: EventFrame) {
    if (this.closed) return;
    if (event.event === 'e3.connected') { for (const a of this.all().filter(a => a.cleanupPending)) this.cleanup(a); return; }
    if (event.event !== 'talk.event') return;
    const p = event.payload as any;
    const a = this.all().find(a => a.transcriptId && a.transcriptId === p?.transcriptionSessionId && ['listening', 'ending'].includes(a.state) && a.generation === this.gateway.status().generation);
    if (!a) return;
    if (['partial', 'transcript'].includes(p.type) && typeof p.text === 'string') {
      const id = typeof p.talkEvent?.turnId === 'string' ? p.talkEvent.turnId : 'stream';
      const turns = [...a.turns ?? []], index = turns.findIndex(t => t.id === id);
      if (index >= 0 && turns[index].final && p.final !== true) return;
      if (p.final === true && !p.text.trim() && turns[index]?.text.trim()) {
        if (!turns[index].final) { this.save({ ...a, final: false, error: 'The last spoken phrase was not confirmed. Available words are kept.' }); void this.finish(a.id); }
        return;
      }
      const turn = { id, text: p.text.slice(0, 100000), final: p.final === true };
      if (index >= 0) turns[index] = turn; else if (turns.length < 500) turns.push(turn);
      this.save({ ...a, turns, text: turns.map(t => t.text).join('\n').slice(0, 100000), final: turns.every(t => t.final) });
    }
    if (p.type === 'error') { this.save({ ...a, error: 'Transcription stopped unexpectedly. Available text is kept.' }); void this.finish(a.id); }
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.all(this.preparing.values()); await Promise.all(this.cleaning.values()); await Promise.all(this.all().filter(a => !['ended', 'failed'].includes(a.state)).map(a => this.finish(a.id))); this.stopListening(); }
}
