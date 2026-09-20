import { apiFailure, clientHeaders } from './api';
import type { Conversation } from '../../../packages/domain/assistant';
import type { VoiceAttempt, VoiceFinal } from '../../../packages/domain/voice';
import { confirmsLiveTranscription, confirmsLiveTurnDetection, liveTranscription, liveTurnDetection, mapRealtimeAssistantItem, mapRealtimeTranscript, reconcileTranscript, type TranscriptTurn } from '../../../packages/adapters/voice-transcript';
import { readLocal, request, saveLocal } from './api';
import { VoiceAudioMeter, silentVoiceLevels, type VoiceLevels } from './voice-audio-meter';

export type VoiceView = {
  phase: 'idle' | 'permission' | 'preparing' | 'connecting' | 'connected' | 'ending' | 'ended' | 'error';
  muted: boolean; speaking: boolean; listening: boolean; processing: boolean; soundBlocked: boolean;
  message: string; attempt?: VoiceAttempt; turns: TranscriptTurn[]; unsaved: number;
};
type Journal = { start: { requestId: string; epoch: string; conversationId: string; conversationRevision: number; projectRevision: number }; attempt?: VoiceAttempt; entries: VoiceFinal[]; turns: TranscriptTurn[] };
type Resources = { stream?: MediaStream; peer?: RTCPeerConnection; channel?: RTCDataChannel; audio?: HTMLAudioElement; playback?: number; context?: AudioContext; meter?: VoiceAudioMeter; timer?: ReturnType<typeof setInterval> };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const active = (view: VoiceView) => ['permission', 'preparing', 'connecting', 'connected', 'ending'].includes(view.phase);

/** Workspace-owned media lifetime. Routing and draft editors never own the call. */
export class VoiceController {
  private view: VoiceView = { phase: 'idle', muted: readLocal<boolean>('e3:voice-muted') ?? false, speaking: false, listening: false, processing: false, soundBlocked: false, message: '', turns: [], unsaved: 0 };
  private listeners = new Set<() => void>();
  private levels: VoiceLevels = silentVoiceLevels;
  private levelListeners = new Set<() => void>();
  private resources: Resources = {};
  private generation = 0;
  private sequence = 0;
  private journal?: Journal;
  private journalKey: string;
  private order: string[] = [];
  private pendingFinals = new Map<string, TranscriptTurn>();
  private seenTools = new Set<string>();
  private deliveredTools = new Set<string>();
  private flushing?: Promise<void>;
  private polling = false;
  private admitting = false;
  private contextInstructions?: string;
  private interrupted = false;
  private responseId?: string;
  private awaitingInputId?: string;
  private cancelledResponses = new Set<string>();
  constructor(deviceId: string) {
    this.journalKey = `e3:voice-call:${deviceId}`;
    this.journal = readLocal<Journal>(this.journalKey);
    if (this.journal) this.view = { ...this.view, phase: 'ended', attempt: this.journal.attempt, turns: this.journal.turns, unsaved: this.journal.entries.filter(e => !e.saved).length, message: 'The previous call is kept. Audio is off. Check its final saves before starting another.' };
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getLevelsSnapshot = () => this.levels;
  subscribeLevels = (listener: () => void) => { this.levelListeners.add(listener); return () => { this.levelListeners.delete(listener); }; };
  private updateLevels(levels: VoiceLevels) {
    if (levels.input === this.levels.input && levels.output === this.levels.output) return;
    this.levels = levels; this.levelListeners.forEach(fn => fn());
  }
  private update(value: Partial<VoiceView>) { this.view = { ...this.view, ...value }; this.listeners.forEach(fn => fn()); }
  private keep() {
    if (!this.journal) return;
    this.journal.turns = this.view.turns;
    if (!saveLocal(this.journalKey, this.journal)) throw new Error('Browser storage is full. Audio is stopped; keep this page open to retain your captions.');
    this.update({ unsaved: this.journal.entries.filter(e => !e.saved).length });
  }
  private send(value: object) {
    if (this.resources.channel?.readyState !== 'open') return;
    try { this.resources.channel.send(JSON.stringify(value)); }
    catch { queueMicrotask(() => { if (active(this.view)) void this.fail('The voice controls disconnected. Audio is stopped.'); }); }
  }
  private action() { if (!this.journal?.attempt) throw new Error('Voice has no confirmed conversation.'); return { requestId: crypto.randomUUID(), epoch: this.journal.start.epoch, attemptId: this.journal.attempt.id }; }
  async start(conversation: Conversation, epoch: string, projectRevision: number) {
    if (active(this.view) || this.journal) return;
    const generation = ++this.generation;
    const resources: Resources = {}; this.resources = resources;
    this.order = []; this.pendingFinals.clear(); this.seenTools.clear(); this.deliveredTools.clear(); this.sequence = 0; this.contextInstructions = undefined; this.interrupted = false;
    this.responseId = undefined; this.awaitingInputId = undefined; this.cancelledResponses.clear(); this.admitting = false;
    this.update({ phase: 'permission', message: 'Allow the microphone to start your call.', turns: [], speaking: false, listening: false, processing: false, soundBlocked: false, attempt: undefined });
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') throw new Error('This browser needs a secure microphone connection before voice can start.');
      resources.context = new AudioContext(); void resources.context.resume().catch(() => undefined);
      // No provider session is spent while a person considers the microphone prompt.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      stream.getTracks().forEach(track => { track.enabled = false; });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      resources.stream = stream;
      resources.meter = new VoiceAudioMeter(resources.context, () => ({
        input: generation === this.generation && this.view.phase === 'connected' && !this.view.muted && stream.getAudioTracks().some(track => track.enabled && track.readyState === 'live'),
        output: generation === this.generation && this.view.phase === 'connected' && !this.view.soundBlocked && !!resources.audio && !resources.audio.muted && !resources.audio.paused,
      }), (levels, speaking) => {
        if (generation !== this.generation) return;
        this.updateLevels(levels);
        if (speaking !== this.view.speaking) this.update({ speaking });
      });
      resources.meter.setInput(stream);
      stream.getAudioTracks().forEach(track => { track.onended = () => { if (generation === this.generation) void this.fail('The microphone disconnected. Audio is stopped; your conversation is kept.'); }; });
      this.journal = { start: { requestId: crypto.randomUUID(), epoch, conversationId: conversation.id, conversationRevision: conversation.revision, projectRevision }, entries: [], turns: [] };
      this.keep(); this.update({ phase: 'preparing', message: 'Preparing voice for this conversation…' });
      let attempt = await request<VoiceAttempt>('assistant/voice/start', this.journal.start);
      this.journal.attempt = attempt; this.keep();
      if (generation !== this.generation) { await this.recover(); return; }
      this.update({ attempt });
      resources.timer = setInterval(() => { void this.poll(generation); }, 2000);
      const deadline = Date.now() + 60000;
      while (attempt.state === 'preparing' && generation === this.generation && Date.now() < deadline) { await pause(400); attempt = await request<VoiceAttempt>(`assistant/voice/${attempt.id}`); }
      if (generation !== this.generation) return;
      if (attempt.state !== 'ready') throw new Error(attempt.message || 'Voice setup did not finish.');
      this.journal.attempt = attempt; this.keep(); this.update({ attempt, phase: 'connecting', message: 'Connecting audio and Project context…' });
      const peer = new RTCPeerConnection(); resources.peer = peer;
      const audio = new Audio(); audio.autoplay = true; audio.muted = true; resources.audio = audio;
      audio.onpause = () => { if (generation === this.generation) { resources.meter?.refresh(); this.update({ speaking: false }); } };
      peer.ontrack = event => {
        if (generation !== this.generation) { event.track.stop(); return; }
        const remote = event.streams[0] ?? new MediaStream([event.track]); audio.srcObject = remote;
        resources.meter?.setOutput(remote);
        const playback = resources.playback = (resources.playback ?? 0) + 1;
        const current = () => generation === this.generation && playback === resources.playback && audio.srcObject === remote;
        void audio.play().then(() => {
          if (!current()) return;
          if (this.view.soundBlocked) this.update({ soundBlocked: false, message: 'Sound enabled' });
          resources.meter?.refresh();
        }, () => {
          if (!current()) return;
          this.update({ soundBlocked: true, message: 'Tap Enable sound to hear the Assistant.' }); resources.meter?.refresh();
        });
      };
      peer.onconnectionstatechange = () => { if (generation === this.generation && ['failed', 'disconnected', 'closed'].includes(peer.connectionState)) void this.fail('The audio connection was interrupted. Your microphone is off; saved captions stay with this conversation.'); };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = peer.createDataChannel('oai-events'); resources.channel = channel;
      channel.onmessage = event => this.receive(event.data, generation);
      channel.onclose = () => { if (generation === this.generation) void this.fail('The voice controls disconnected. Audio is stopped.'); };
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      if (generation !== this.generation) return;
      // Only SDP travels to the app service. OAuth and broker credentials stay there.
      const response = await fetch('/api/assistant/voice/offer', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...clientHeaders() }, body: JSON.stringify({ ...this.action(), sdp: offer.sdp }), signal: AbortSignal.timeout(35000) });
      const answer = await response.json();
      if (!response.ok) throw apiFailure(answer, response.status);
      if (generation !== this.generation) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      const contextDeadline = Date.now() + 20000;
      while (generation === this.generation && this.view.phase === 'connecting' && Date.now() < contextDeadline) await pause(100);
      if (generation === this.generation && this.view.phase === 'connecting') throw new Error('Voice did not confirm Project context and live captions. Audio stayed muted.');
    } catch (error) { if (generation === this.generation) await this.fail(error instanceof Error ? error.message : 'Voice could not start. Your conversation is kept.'); }
  }
  private receive(raw: unknown, generation: number) {
    if (generation !== this.generation) return;
    void this.providerEvent(raw, generation).catch(error => {
      if (generation === this.generation) return this.fail(error instanceof Error ? error.message : 'Voice could not continue.');
    });
  }
  private async providerEvent(raw: unknown, generation: number) {
    if (typeof raw !== 'string' || raw.length > 300000) throw new Error('The voice provider returned an unsupported event.');
    const event = JSON.parse(raw);
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    if (event.type === 'session.created' && !this.contextInstructions) {
      if (typeof event.session?.instructions !== 'string') throw new Error('Voice did not supply its conversation instructions. Audio stayed muted.');
      this.contextInstructions = `${event.session.instructions}\n\n${this.journal!.attempt!.context}`;
      this.send({ type: 'session.update', session: { type: 'realtime', instructions: this.contextInstructions, audio: { input: { transcription: liveTranscription, turn_detection: liveTurnDetection } } } });
      return;
    }
    if (event.type === 'session.updated' && this.view.phase === 'connecting') {
      if (!this.contextInstructions || event.session?.instructions !== this.contextInstructions) return;
      if (!confirmsLiveTranscription(event.session?.audio?.input?.transcription) || !confirmsLiveTurnDetection(event.session?.audio?.input?.turn_detection) || this.admitting) return;
      const journal = this.journal!;
      this.admitting = true;
      try {
        const attempt = await request<VoiceAttempt>('assistant/voice/pulse', { ...this.action(), contextDigest: journal.attempt!.contextDigest });
        if (generation !== this.generation || this.journal !== journal || this.view.phase !== 'connecting') return;
        if (attempt.id !== journal.attempt!.id || attempt.state !== 'active') throw new Error('The call ended before audio was ready. Your microphone stayed off.');
        this.acceptAttempt(attempt);
        this.update({ phase: 'connected', message: this.view.muted ? 'Microphone muted' : 'Voice connected. Speak when you’re ready.' });
        this.resources.stream?.getAudioTracks().forEach(track => { track.enabled = !this.view.muted; });
      } finally { if (generation === this.generation) this.admitting = false; }
      return;
    }
    if (event.type === 'error') {
      // A cancelled/already-ended response is an expected race during local interruption.
      if (['response_cancel_not_active', 'input_audio_buffer_commit_empty'].includes(event.error?.code)) return;
      throw new Error('The voice provider could not continue this call. Your captions are kept.');
    }
    if (this.view.phase !== 'connected') return;
    if (event.type === 'input_audio_buffer.speech_started') {
      if (!this.view.muted) { this.interrupt(); this.awaitingInputId = typeof event.item_id === 'string' ? event.item_id : undefined; this.update({ listening: true, processing: false }); }
    }
    if (event.type === 'input_audio_buffer.speech_stopped') this.update({ listening: false, processing: true });
    if (event.type === 'input_audio_buffer.committed' && typeof event.item_id === 'string') {
      // Speech onset alone must not release a cancelled response's late audio.
      if (!this.view.muted && event.item_id === this.awaitingInputId) { this.interrupted = false; this.awaitingInputId = undefined; }
      this.rememberItem(event.item_id);
    }
    if (event.type === 'response.created' && typeof event.response?.id === 'string') {
      if (this.interrupted) this.cancelledResponses.add(event.response.id);
      else if (!this.cancelledResponses.has(event.response.id)) { this.responseId = event.response.id; this.update({ processing: true }); }
    }
    // WebRTC audio may outlive response.done. Release the local playback fence
    // only for the current response's actual output stream, never text events.
    if (event.type === 'output_audio_buffer.started' && typeof event.response_id === 'string' && event.response_id === this.responseId && !this.interrupted && !this.cancelledResponses.has(event.response_id)) {
      if (this.resources.audio) this.resources.audio.muted = false;
    }
    if (event.type === 'response.done' && event.response?.id === this.responseId) this.update({ processing: false });
    if ((event.type === 'output_audio_buffer.stopped' || event.type === 'output_audio_buffer.cleared') && event.response_id === this.responseId) this.update({ speaking: false });
    // New committed input and response items define call order. Replayed initial
    // history items must never reserve a caption ordinal in this new call.
    if (event.type === 'response.output_item.added' && event.item?.role === 'assistant' && event.item?.type === 'message') this.rememberItem(event.item.id);
    const mapped = mapRealtimeTranscript(this.journal!.attempt!.id, ++this.sequence, event)
      ?? mapRealtimeAssistantItem(this.journal!.attempt!.id, this.sequence, event);
    if (mapped) {
      const current = this.view.turns.find(t => t.turnId === mapped.turnId);
      const next = reconcileTranscript(current, mapped);
      // Live input deltas precede the commit that assigns their history ordinal.
      // Keep provisional new speech after earlier turns without reserving an
      // ordinal that an interrupted, never-committed input could leave empty.
      const position = (id: string) => this.order.includes(id) ? this.order.indexOf(id) : Number.MAX_SAFE_INTEGER;
      this.update({ turns: [...this.view.turns.filter(t => t.turnId !== next.turnId), next].sort((a, b) => position(a.turnId) - position(b.turnId)) });
      if (next.final) { this.pendingFinals.set(next.turnId, next); this.collectFinals(); }
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') throw new Error('A spoken turn could not be transcribed. Audio is stopped so the missing words are not silently lost.');
    if (event.type === 'response.function_call_arguments.done') {
      if (this.interrupted || this.cancelledResponses.has(event.response_id)) return;
      if (typeof event.call_id !== 'string' || typeof event.arguments !== 'string' || this.seenTools.has(event.call_id)) return;
      this.seenTools.add(event.call_id);
      if (event.name !== 'openclaw_agent_consult') {
        this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ error: 'This voice client supports Assistant consultation only.' }) } });
        this.send({ type: 'response.create' }); return;
      }
      const attempt = await request<VoiceAttempt>('assistant/voice/consult', { ...this.action(), callId: event.call_id, name: event.name, args: JSON.parse(event.arguments) });
      if (generation === this.generation) this.acceptAttempt(attempt);
    }
  }
  private rememberItem(id: unknown) { if (typeof id === 'string' && !this.order.includes(id)) { this.order.push(id); this.collectFinals(); } }
  private collectFinals() {
    if (!this.journal) return;
    for (const [id, turn] of this.pendingFinals) {
      const ordinal = this.order.indexOf(id);
      if (ordinal < 0) continue;
      if (!this.journal.entries.some(e => e.entryId === id)) this.journal.entries.push({ entryId: id, ordinal, role: turn.role, text: turn.original, timestamp: Date.now(), saved: false });
      this.pendingFinals.delete(id);
    }
    this.keep(); void this.flush().catch(() => { this.update({ message: 'Captions are kept on this device. Their history save will retry.' }); });
  }
  private acceptAttempt(attempt: VoiceAttempt) {
    if (!this.journal || attempt.id !== this.journal.attempt?.id) return;
    this.journal.attempt = attempt;
    this.journal.entries = this.journal.entries.map(e => ({ ...e, saved: e.saved || attempt.entries.some(saved => saved.entryId === e.entryId && saved.saved) }));
    this.keep(); this.update({ attempt });
    if (this.view.phase !== 'connected') return;
    for (const consult of attempt.consults) if (['completed', 'failed', 'unknown'].includes(consult.state) && !this.deliveredTools.has(consult.callId)) {
      this.deliveredTools.add(consult.callId);
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: consult.callId, output: JSON.stringify({ status: consult.state, text: consult.text }) } });
      this.send({ type: 'response.create' });
    }
  }
  private async flush() {
    if (this.flushing) return this.flushing;
    if (!this.journal?.attempt) return;
    const journal = this.journal;
    const work = (async () => {
      const submitted = new Set<string>();
      while (this.journal === journal) {
        const entries = journal.entries.filter(e => !e.saved && !submitted.has(e.entryId)).slice(0, 100).map(({ saved, ...entry }) => entry);
        if (!entries.length) return;
        entries.forEach(entry => submitted.add(entry.entryId));
        const result = await request<VoiceAttempt>('assistant/voice/finals', { ...this.action(), entries });
        if (this.journal === journal) this.acceptAttempt(result);
      }
    })();
    this.flushing = work;
    try { await work; } finally { this.flushing = undefined; }
  }
  private async poll(generation: number) {
    if (this.polling || generation !== this.generation || !this.journal?.attempt) return;
    this.polling = true;
    try {
      const attempt = await request<VoiceAttempt>('assistant/voice/pulse', this.action());
      if (generation !== this.generation) return;
      if (['ending', 'ended', 'interrupted', 'failed'].includes(attempt.state)) throw new Error(attempt.message);
      this.acceptAttempt(attempt); await this.flush();
    } catch (error) { if (generation === this.generation) await this.fail(error instanceof Error ? error.message : 'The workspace connection was interrupted. Audio is stopped.'); }
    finally { this.polling = false; }
  }
  mute = () => {
    const muted = !this.view.muted;
    this.resources.stream?.getAudioTracks().forEach(track => { track.enabled = !muted && this.view.phase === 'connected'; });
    if (muted) { this.resources.meter?.refresh(); this.updateLevels({ ...this.levels, input: 0 }); }
    if (muted) { this.awaitingInputId = undefined; this.send({ type: 'input_audio_buffer.clear' }); }
    saveLocal('e3:voice-muted', muted);
    this.update({ muted, listening: false, message: muted ? 'Microphone muted' : 'Microphone on' });
  };
  interrupt = () => {
    if (this.resources.audio) this.resources.audio.muted = true;
    this.resources.meter?.refresh(); this.updateLevels({ ...this.levels, output: 0 });
    if (this.responseId) this.cancelledResponses.add(this.responseId);
    this.awaitingInputId = undefined;
    this.interrupted = true; this.update({ speaking: false });
    this.send({ type: 'response.cancel' }); this.send({ type: 'output_audio_buffer.clear' });
  };
  enableSound = async () => {
    const generation = this.generation, resources = this.resources, playback = resources.playback = (resources.playback ?? 0) + 1;
    const current = () => generation === this.generation && playback === resources.playback;
    try {
      await resources.context?.resume(); if (!current()) return;
      await resources.audio?.play(); if (!current()) return;
      this.update({ soundBlocked: false, message: 'Sound enabled' }); resources.meter?.refresh();
    } catch { if (current()) { this.update({ soundBlocked: true }); resources.meter?.refresh(); } }
  };
  private release() {
    ++this.generation;
    const resources = this.resources; this.resources = {};
    resources.meter?.dispose(); this.updateLevels(silentVoiceLevels);
    resources.stream?.getTracks().forEach(track => { track.enabled = false; track.onended = null; track.stop(); });
    if (resources.audio) { resources.audio.pause(); resources.audio.srcObject = null; }
    clearInterval(resources.timer); resources.channel?.close(); resources.peer?.close(); void resources.context?.close().catch(() => undefined);
    this.update({ listening: false, speaking: false, processing: false });
  }
  private async fail(message: string) { this.release(); this.update({ phase: 'error', message }); await this.finishRemote(); }
  private hasUnconfirmedTurns() {
    return this.pendingFinals.size > 0 || this.view.turns.some(turn => turn.text.trim()
      && (!turn.final || turn.unconfirmed || !this.journal?.entries.some(entry => entry.entryId === turn.turnId && entry.saved)));
  }
  private dismissSavedCall(automatic = false) {
    const journal = this.journal, attempt = journal?.attempt;
    if (!journal || !attempt || !(automatic ? attempt.state === 'ended' : ['ended', 'failed'].includes(attempt.state))
      || journal.entries.some(entry => !entry.saved) || attempt.entries.some(entry => !entry.saved)
      || automatic && this.hasUnconfirmedTurns()) return false;
    localStorage.removeItem(this.journalKey); this.journal = undefined;
    this.update({ phase: 'idle', message: 'Call saved. You can start another when ready.', unsaved: 0 });
    return true;
  }
  end = async () => {
    this.release(); this.update({ phase: 'ending', message: 'Audio stopped. Keeping your captions…' });
    const confirmed = await this.finishRemote();
    if (this.view.phase !== 'ending') return;
    if (!this.journal) { this.update({ phase: 'idle', message: 'Audio is off.' }); return; }
    try { if (confirmed && this.dismissSavedCall(true)) return; }
    catch { this.update({ phase: 'ended', message: 'Audio is off. Your saved call could not be cleared from this browser yet.' }); return; }
    this.update({ phase: 'ended', message: this.hasUnconfirmedTurns()
      ? 'Audio is off. Some captions are still unconfirmed. They are kept here for review.'
      : confirmed ? this.journal.attempt?.message ?? 'Call ended. Audio is off.'
      : this.journal.attempt ? this.view.message : 'Audio is off. The original call still needs confirmation.' });
  };
  private async finishRemote() {
    const journal = this.journal;
    if (!journal?.attempt) return false;
    const action = this.action();
    try { this.keep(); await this.flush(); } catch { /* The local journal keeps the exact unsaved finals. */ }
    if (this.journal !== journal) return false;
    try {
      const result = await request<VoiceAttempt>('assistant/voice/end', action);
      if (this.journal !== journal) return false;
      this.acceptAttempt(result); return result.id === action.attemptId;
    } catch { if (this.journal === journal) this.update({ message: 'Audio is off. Close and save still need confirmation; the original call is kept.' }); return false; }
  }
  recover = async () => {
    if (active(this.view)) return;
    try {
      if (!this.journal) { this.update({ phase: 'idle', message: 'Audio is off. You can start a call when ready.' }); return; }
      if (this.journal && !this.journal.attempt) { const result = await request<{ attempt: VoiceAttempt | null }>(`assistant/voice/recover/${this.journal.start.requestId}`); if (result.attempt) this.journal.attempt = result.attempt; else { this.journal = undefined; localStorage.removeItem(this.journalKey); this.update({ phase: 'idle', message: 'No admitted voice call was found. Audio is off.' }); return; } }
      await this.finishRemote();
      this.dismissSavedCall();
    } catch (error) { this.update({ message: error instanceof Error ? error.message : 'The original call could not be checked. Audio is off.' }); }
  };
  dispose = () => { this.release(); void this.finishRemote(); };
}
