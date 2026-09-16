import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventFrame } from '@openclaw/gateway-protocol/frame-guards';
import { canonical } from '../../packages/domain/contracts.js';
import { voiceActionSchema, voiceConsultSchema, voiceFinalsSchema, voiceOfferSchema, voiceStartSchema, type VoiceAttempt, type VoiceConsult, type VoiceTarget } from '../../packages/domain/voice.js';
import { AssistantService } from './assistant.js';
import type { AssistantTransport } from './gateway.js';
import { Fault, Store } from './store.js';
import { VoiceSetup } from './voice.js';
import { captureVoiceSources, voiceSourceContext, voiceCallContext, stageVoiceSources } from './voice-sources.js';

const key = (id: string) => `voice:attempt:${id}`;
const liveStates = new Set(['preparing', 'ready', 'connecting', 'active', 'ending', 'interrupted']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const browserSession = z.object({ provider: z.literal('openai'), transport: z.literal('webrtc'), voiceSessionId: z.string(), clientSecret: z.string().min(1).max(8192), offerUrl: z.literal('/plugins/openai/realtime/calls'), clientControl: z.unknown().optional() });
type Live = { secret?: string; offerUrl?: string; touched: number; checkedAt?: number; dispatched: boolean; creating?: Promise<void>; offering?: Promise<string>; draining?: Promise<void>; ending?: Promise<void>; abort: AbortController };
const messageText = (value: any): string => typeof value?.content === 'string' ? value.content : Array.isArray(value?.content) ? value.content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n') : '';

/** One owned audio attempt. Credentials and SDP are never written to the store. */
export class VoiceCalls {
  private live = new Map<string, Live>();
  private early = new Map<string, EventFrame[]>();
  private closed = false;
  private stopListening: () => void;
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: Store, private gateway: AssistantTransport, private assistant: AssistantService, private setup: VoiceSetup, private exchange: typeof fetch = fetch) {
    for (const attempt of this.all()) if (liveStates.has(attempt.state)) this.save({ ...attempt, state: 'interrupted', message: 'The service restarted. Audio is stopped; close this original call before starting another.' });
    assistant.setVoiceGuard(id => this.all().some(a => a.target.conversation.id === id && liveStates.has(a.state)));
    this.stopListening = gateway.subscribe(event => this.event(event));
    this.timer = setInterval(() => {
      for (const [id, state] of this.live) if (Date.now() - state.touched > 30000) void this.endOwned(id).catch(() => undefined);
    }, 5000);
    this.timer.unref();
  }
  private all() { return this.store.internalList<VoiceAttempt>('voice:attempt:'); }
  private save(value: VoiceAttempt) { if (this.closed || this.assistant.removals.removed(value.target.conversation.id)) return value; return this.store.internalWrite(key(value.id), value); }
  private get(id: string) { const value = this.store.internalRead<VoiceAttempt>(key(id)); if (!value) throw new Fault(404, 'voice_missing', 'This voice call is unavailable.'); return value; }
  read(device: string, id: string) { const value = this.get(id); if (value.deviceId !== device) throw new Fault(403, 'voice_owner', 'This voice call belongs to another device.'); return value; }
  recover(device: string, requestId: string) { return { attempt: this.all().find(a => a.deviceId === device && a.requestId === requestId) ?? null }; }
  private connection(attempt: VoiceAttempt) {
    const status = this.gateway.status();
    if (this.closed || attempt.epoch !== this.store.epoch || status.state !== 'ready' || status.generation !== attempt.target.conversation.connectionGeneration) throw new Fault(409, 'voice_connection_changed', 'Voice lost its original workspace connection. Audio must stop.');
    return status;
  }
  private currentTarget(attempt: VoiceAttempt) {
    this.connection(attempt);
    const original = attempt.target, c = original.conversation;
    const current = this.assistant.captureVoiceTarget(c.id, c.revision, original.project?.revision ?? 0);
    // Saved memory is captured at call start; edits apply to the next call.
    const { memory: currentMemory, ...currentScope } = current, { memory: originalMemory, ...originalScope } = original;
    if (canonical(currentScope) !== canonical(originalScope)) throw new Fault(409, 'voice_context_changed', 'The conversation or Project changed. End this call and review its context.');
  }
  private async preflight(attempt: VoiceAttempt, idle = true) {
    this.currentTarget(attempt);
    await this.assistant.prepareApprovalReview(attempt.target.conversation.id);
    const history = await this.assistant.history(attempt.target.conversation.id);
    this.currentTarget(attempt);
    if (history.nativeId !== attempt.target.conversation.nativeId || history.nativeSettings?.archived === true || (attempt.target.conversation.model && history.nativeSettings?.model !== attempt.target.conversation.model) || (idle && (history.activeRunIds === null || history.activeRunIds.length > 0))) throw new Fault(409, 'voice_session_changed', 'The original conversation is busy or changed. Check its history before starting voice.');
  }
  start(device: string, raw: unknown) {
    const input = voiceStartSchema.parse(raw);
    const receipt = this.store.admit(device, input, { type: 'voice.start', ...input }, () => {
      if (this.all().some(a => liveStates.has(a.state))) throw new Fault(409, 'voice_busy', 'A voice call is already open. End it on its original device first.');
      const target: VoiceTarget = this.assistant.captureVoiceTarget(input.conversationId, input.conversationRevision, input.projectRevision);
      const sources = captureVoiceSources(this.store, target, this.gateway.status().methods.includes('e3.sources.stage'));
      const context = voiceCallContext(target, sources);
      const attempt: VoiceAttempt = { id: randomUUID(), requestId: input.requestId, epoch: input.epoch, deviceId: device, createdAt: new Date().toISOString(), target, context, contextDigest: hash(context), state: 'preparing', message: 'Preparing voice for this conversation…', entries: [], consults: [], sources };
      return this.save(attempt);
    });
    if (receipt.fresh) {
      const state: Live = { touched: Date.now(), dispatched: false, abort: new AbortController() };
      this.live.set(receipt.value.id, state);
      state.creating = this.prepare(receipt.value, state, input.model, input.voice);
    }
    return this.read(device, receipt.value.id);
  }
  private async prepare(attempt: VoiceAttempt, state: Live, chosenModel?: string, chosenVoice?: string) {
    try {
      await this.preflight(attempt);
      const catalog = await this.setup.read();
      const provider = catalog.providers.find(p => p.id === 'openai' && p.configured && p.browserSupported);
      const model = chosenModel ?? provider?.models.find(m => m === 'gpt-realtime-2.1');
      if (catalog.state !== 'available' || !provider || !model || !/^gpt-realtime-2(?:\.1(?:-mini)?)?$/.test(model) || !provider.models.includes(model)) throw new Fault(409, 'voice_model', 'Connect a supported OpenAI realtime voice model in Settings.');
      const voices = provider.voicesByModel[model] ?? provider.voices;
      const voice = chosenVoice ?? (voices.includes('marin') ? 'marin' : voices[0]);
      if (!voice || !voices.includes(voice)) throw new Fault(409, 'voice_choice', 'Choose a voice supported by this model.');
      this.currentTarget(attempt);
      if (this.get(attempt.id).state !== 'preparing') return;
      const prepared = await stageVoiceSources(this.store, this.gateway, attempt.epoch, attempt.target, attempt.sources ?? [], () => {
        this.currentTarget(attempt);
        if (this.get(attempt.id).state !== 'preparing') throw new Fault(409, 'voice_ended', 'The call ended before source preparation completed.');
      });
      this.currentTarget(attempt);
      if (this.get(attempt.id).state !== 'preparing') return;
      const context = voiceCallContext(attempt.target, prepared.sources);
      attempt = this.save({ ...this.get(attempt.id), sources: prepared.sources, context, contextDigest: hash(context) });
      state.dispatched = true;
      const result = browserSession.parse(await this.gateway.request('talk.client.create', { sessionKey: attempt.target.conversation.nativeKey, voiceSessionId: attempt.id, provider: 'openai', model, voice, mode: 'realtime', transport: 'webrtc', brain: 'agent-consult', capabilities: ['voice-transcript'], silenceDurationMs: 450, prefixPaddingMs: 300 }));
      if (result.voiceSessionId !== attempt.id || result.clientControl) throw new Fault(409, 'voice_transport', 'The provider returned a different voice transport.');
      const status = this.connection(attempt);
      const gatewayUrl = new URL(status.url!);
      gatewayUrl.protocol = gatewayUrl.protocol === 'wss:' ? 'https:' : 'http:';
      state.secret = result.clientSecret;
      state.offerUrl = new URL(result.offerUrl, gatewayUrl.origin).href;
      if (this.get(attempt.id).state !== 'preparing') return;
      this.currentTarget(attempt);
      this.save({ ...this.get(attempt.id), state: 'ready', model, voice, message: 'Connecting your audio…' });
    } catch (error) {
      if (!this.closed && this.get(attempt.id).state === 'preparing') this.save({ ...this.get(attempt.id), state: state.dispatched ? 'interrupted' : 'failed', message: error instanceof Fault ? error.message : 'Voice setup could not be confirmed. Your ChatGPT account stays connected.' });
      if (state.dispatched) queueMicrotask(() => { void this.endOwned(attempt.id).catch(() => undefined); });
      else this.live.delete(attempt.id);
    }
  }
  async offer(device: string, raw: unknown) {
    const input = voiceOfferSchema.parse(raw), attempt = this.read(device, input.attemptId), state = this.live.get(attempt.id);
    const receipt = this.store.admit(device, input, { type: 'voice.offer', ...input }, () => {
      this.currentTarget(attempt);
      if (attempt.state !== 'ready' || !state?.secret || !state.offerUrl) throw new Fault(409, 'voice_offer_expired', 'This audio connection is no longer available. End the call before trying again.');
      this.save({ ...attempt, state: 'connecting' });
      return { attemptId: attempt.id }; // Receipt contains neither SDP nor credentials.
    });
    if (!receipt.fresh) throw new Fault(409, 'voice_offer_unknown', 'This one-use audio connection was already attempted. It will not be sent again.');
    const exchange = (async () => {
      await this.preflight(attempt);
      if (this.get(attempt.id).state !== 'connecting') throw new Fault(409, 'voice_ended', 'The call ended before audio connected.');
      const secret = state!.secret!; state!.secret = undefined;
      const response = await this.exchange(state!.offerUrl!, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' }, body: input.sdp, redirect: 'error', signal: AbortSignal.any([state!.abort.signal, AbortSignal.timeout(30000)]) });
      if (!response.ok || !response.body) throw new Error('Voice offer rejected');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 262144) throw new Error('Voice answer too large'); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => undefined); }
      const answer = Buffer.concat(chunks).toString();
      if (!answer.startsWith('v=0')) throw new Error('Voice answer invalid');
      this.currentTarget(attempt);
      if (this.get(attempt.id).state !== 'connecting') throw new Error('Voice ended during exchange');
      return answer;
    })();
    state!.offering = exchange;
    try { return { sdp: await exchange }; }
    catch { void this.endOwned(attempt.id).catch(() => undefined); throw new Fault(409, 'voice_offer_failed', 'Audio did not connect. The one-use connection will not be replayed. Your conversation is kept.'); }
    finally { state!.offering = undefined; }
  }
  async pulse(device: string, raw: unknown) {
    const input = voiceActionSchema.extend({ contextDigest: z.string().length(64).optional() }).parse(raw), attempt = this.read(device, input.attemptId);
    if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. End this call.');
    if (!liveStates.has(attempt.state)) return attempt;
    try {
      this.currentTarget(attempt);
      const state = this.live.get(attempt.id);
      if (!state || ['ending', 'interrupted'].includes(attempt.state)) throw new Error('No owned audio call');
      state.touched = Date.now();
      if (attempt.state === 'active' && Date.now() - (state.checkedAt ?? 0) >= 5000) {
        state.checkedAt = Date.now();
        await this.preflight(attempt, false);
        for (const consult of this.get(attempt.id).consults.filter(c => c.state === 'running' && c.runId)) {
          if (!this.gateway.status().methods.includes('agent.wait')) continue;
          const receipt = await this.gateway.request<Record<string, any>>('agent.wait', { runId: consult.runId, timeoutMs: 0 });
          this.connection(attempt);
          const proof = receipt.terminalReceipt;
          if (receipt.runId === consult.runId && proof?.runId === consult.runId && proof.sessionId === attempt.target.conversation.nativeId && ['ok', 'error'].includes(receipt.status)) this.saveConsult(attempt.id, { ...consult, state: receipt.status === 'ok' ? 'completed' : 'failed', text: typeof receipt.terminalReply?.text === 'string' ? receipt.terminalReply.text.slice(0, 60000) : 'The Assistant finished without a spoken answer. Open the original conversation.' });
        }
        if (this.get(attempt.id).state !== 'active') throw new Error('Call ended during its status check');
      }
      if (input.contextDigest !== undefined) {
        if (input.contextDigest !== attempt.contextDigest || !['connecting', 'active'].includes(attempt.state)) throw new Error('Voice context was not confirmed');
        return this.save({ ...attempt, state: 'active', message: 'Voice connected to this conversation.' });
      }
      return this.get(attempt.id);
    } catch { void this.endOwned(attempt.id).catch(() => undefined); throw new Fault(409, 'voice_context_changed', 'Voice lost its original conversation context. Audio has been stopped.'); }
  }
  async finals(device: string, raw: unknown) {
    const input = voiceFinalsSchema.parse(raw), original = this.read(device, input.attemptId);
    this.store.admit(device, input, { type: 'voice.finals', ...input }, () => {
      const entries = [...original.entries];
      for (const entry of input.entries) {
        const prior = entries.find(e => e.entryId === entry.entryId || e.ordinal === entry.ordinal);
        if (prior && canonical({ ...prior, saved: undefined }) !== canonical({ ...entry, saved: undefined })) throw new Fault(409, 'voice_final_changed', 'A final caption changed identity. Its original text is kept.');
        if (!prior) entries.push({ ...entry, saved: false });
      }
      if (entries.length > 1000) throw new Fault(413, 'voice_turn_limit', 'End this call before recording more turns.');
      return this.save({ ...original, entries: entries.sort((a, b) => a.ordinal - b.ordinal) });
    });
    await this.drain(original.id);
    return this.read(device, original.id);
  }
  private async drain(id: string) {
    const state = this.live.get(id);
    if (state?.draining) return state.draining;
    const work = (async () => {
      let ordinal = 0;
      for (const entry of this.get(id).entries) {
        if (entry.ordinal !== ordinal++) break;
        if (entry.saved) continue;
        if (!entry.text.trim()) { // A silent/cancelled item must not block later final captions or fabricate a message.
          this.save({ ...this.get(id), entries: this.get(id).entries.map(e => e.entryId === entry.entryId ? { ...e, saved: true } : e) });
          continue;
        }
        const attempt = this.get(id); this.connection(attempt);
        // Final captions remain attached to the captured incarnation, even after End.
        const history = await this.assistant.history(attempt.target.conversation.id);
        if (history.nativeId !== attempt.target.conversation.nativeId) throw new Fault(409, 'voice_session_changed', 'Captions are kept locally because their original conversation was replaced.');
        await this.gateway.request('talk.client.transcript', { sessionKey: attempt.target.conversation.nativeKey, voiceSessionId: id, entryId: entry.entryId, role: entry.role, text: entry.text, timestamp: entry.timestamp });
        this.connection(attempt);
        this.save({ ...this.get(id), entries: this.get(id).entries.map(e => e.entryId === entry.entryId ? { ...e, saved: true } : e) });
      }
    })();
    if (state) state.draining = work;
    try { await work; } finally { if (state) state.draining = undefined; }
  }
  async consult(device: string, raw: unknown) {
    const input = voiceConsultSchema.parse(raw), original = this.read(device, input.attemptId);
    const intentKey = `voice:consult-intent:${original.id}:${input.callId}`, digest = hash(canonical({ name: input.name, args: input.args }));
    const receipt = this.store.admit(device, input, { type: 'voice.consult', ...input }, () => {
      this.currentTarget(original);
      if (original.state !== 'active') throw new Fault(409, 'voice_ended', 'This call is no longer accepting Assistant work.');
      const prior = this.store.internalRead<string>(intentKey);
      if (prior && prior !== digest) throw new Fault(409, 'voice_tool_changed', 'This voice request changed after it was admitted.');
      if (prior) return { fresh: false };
      if (original.consults.length >= 100 || original.consults.some(c => ['dispatching', 'running', 'unknown'].includes(c.state))) throw new Fault(409, 'voice_consult_busy', 'The previous voice request is still running or awaiting confirmation.');
      this.store.internalWrite(intentKey, digest);
      this.save({ ...original, consults: [...original.consults, { callId: input.callId, state: 'dispatching' }] });
      return { fresh: true };
    });
    if (receipt.fresh && receipt.value.fresh) {
      let dispatched = false;
      try {
        await this.preflight(original);
        if (this.get(original.id).state !== 'active') throw new Error('Call ended');
        const prepared = await stageVoiceSources(this.store, this.gateway, original.epoch, original.target, original.sources ?? [], () => {
          this.currentTarget(original);
          if (this.get(original.id).state !== 'active') throw new Fault(409, 'voice_ended', 'The call ended before its files were ready.');
        });
        this.currentTarget(original);
        if (this.get(original.id).state !== 'active') throw new Fault(409, 'voice_ended', 'The call ended before its files were ready.');
        const params = { sessionKey: original.target.conversation.nativeKey, voiceSessionId: original.id, callId: input.callId, name: input.name, args: { ...input.args, context: `${original.context}\n\nVoice conversation context:\n${input.args.context ?? ''}${voiceSourceContext(this.store, prepared.sources, prepared.references)}` } };
        const ceiling = this.gateway.attachmentPolicy().maxPayload;
        if (ceiling && Buffer.byteLength(JSON.stringify(params)) + 1024 > ceiling) throw new Fault(413, 'voice_context_limit', 'These sources exceed the current voice connection limit. Use text chat for this request.');
        dispatched = true;
        const result = z.object({ runId: z.string().min(1), agentSessionKey: z.string().min(1) }).parse(await this.gateway.request('talk.client.toolCall', params));
        this.connection(original);
        if (result.agentSessionKey !== original.target.conversation.nativeKey) throw new Error('Consult target changed');
        this.saveConsult(original.id, { callId: input.callId, state: 'running', runId: result.runId, sessionKey: result.agentSessionKey });
        const early = this.early.get(result.runId) ?? []; this.early.delete(result.runId); for (const event of early) this.event(event);
      } catch (error) { this.saveConsult(original.id, { callId: input.callId, state: dispatched ? 'unknown' : 'failed', text: dispatched ? 'The Assistant request could not be confirmed. Check the original conversation; it will not be sent again.' : error instanceof Fault ? error.message : 'This voice request was not sent because the call changed. End the call and review the conversation.' }); }
    }
    return this.read(device, original.id);
  }
  private saveConsult(id: string, consult: VoiceConsult) { const attempt = this.get(id); this.save({ ...attempt, consults: attempt.consults.map(c => c.callId === consult.callId ? { ...c, ...consult } : c) }); }
  private event(event: EventFrame) {
    if (this.closed) return;
    if (event.event === 'e3.connected' || event.event === 'e3.history-gap') {
      for (const attempt of this.all().filter(a => ['ready', 'connecting', 'active'].includes(a.state))) void this.endOwned(attempt.id).catch(() => undefined);
      return;
    }
    if (event.event !== 'chat') return;
    const data = event.payload as any;
    if (!data || typeof data.runId !== 'string' || !['final', 'error', 'aborted'].includes(data.state)) return;
    const attempts = this.all();
    const attempt = attempts.find(a => a.consults.some(c => c.runId === data.runId));
    if (!attempt) {
      if (attempts.some(a => a.consults.some(c => c.state === 'dispatching'))) { const events = this.early.get(data.runId) ?? []; if (events.length < 5) this.early.set(data.runId, [...events, event]); if (this.early.size > 20) this.early.delete(this.early.keys().next().value!); }
      return;
    }
    const consult = attempt.consults.find(c => c.runId === data.runId)!;
    if (attempt.epoch !== this.store.epoch || attempt.target.conversation.connectionGeneration !== this.gateway.status().generation || data.sessionKey !== consult.sessionKey || consult.state !== 'running') return;
    const text = messageText(data.message).slice(0, 60000);
    this.saveConsult(attempt.id, { ...consult, state: data.state === 'final' && text ? 'completed' : 'failed', text: text || 'The backing Assistant did not return a completed answer. Check this conversation.' });
  }
  async end(device: string, raw: unknown) {
    const input = voiceActionSchema.parse(raw), attempt = this.read(device, input.attemptId);
    this.store.admit(device, input, { type: 'voice.end', ...input }, () => ({ attemptId: attempt.id }));
    await this.endOwned(attempt.id);
    return this.read(device, attempt.id);
  }
  private async endOwned(id: string) {
    const original = this.get(id);
    if (['ended', 'failed'].includes(original.state)) return;
    const state = this.live.get(id);
    if (state?.ending) return state.ending;
    this.save({ ...original, state: 'ending', message: 'Audio stopped. Keeping final captions…' });
    state?.abort.abort();
    const work = (async () => {
      try {
        await state?.creating; await state?.offering?.catch(() => undefined);
        await this.drain(id).catch(() => undefined);
        this.connection(original);
        if (!state || state.dispatched) await this.gateway.request('talk.client.close', { sessionKey: original.target.conversation.nativeKey, voiceSessionId: id });
        this.save({ ...this.get(id), state: 'ended', message: this.get(id).entries.some(e => !e.saved) ? 'Call ended. Some captions are kept here but not yet confirmed in conversation history.' : 'Call ended. Final captions are saved.' });
        this.live.delete(id);
      } catch { this.save({ ...this.get(id), state: 'interrupted', message: 'Audio stopped. OpenClaw has not confirmed closing this original call. Try closing it again after reconnecting.' }); }
      finally { if (state) { state.secret = undefined; state.offerUrl = undefined; state.ending = undefined; } }
    })();
    if (state) state.ending = work;
    return work;
  }
  async close() {
    clearInterval(this.timer);
    await Promise.allSettled(this.all().filter(a => liveStates.has(a.state)).map(a => this.endOwned(a.id)));
    this.closed = true; this.stopListening(); this.live.clear(); this.early.clear();
  }
}
