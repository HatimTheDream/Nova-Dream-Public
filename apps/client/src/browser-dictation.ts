import { request } from './api';
import type { DictationAttempt, DictationTurn } from '../../../packages/domain/dictation';
import { orderDictationTurns } from '../../../packages/domain/dictation-order';

/** Live input transcription over the existing ChatGPT voice transport.
 * The microphone stays muted until the provider confirms no tools or responses. */
export class BrowserDictation {
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stream?: MediaStream;
  private turns = new Map<string, DictationTurn>();
  private pending = new Set<string>();
  private committed = false;
  private seen = new Set<string>();
  private saveError?: Error;
  private duration?: ReturnType<typeof setTimeout>;
  private closed = false;
  private resolveReady?: () => void;
  private rejectReady?: (reason: Error) => void;
  private chain = Promise.resolve();
  constructor(private epoch: string, private attempt: DictationAttempt, private update: (text: string) => void, private failed: (error: Error) => void, private api: typeof request = request, private createPeer = () => new RTCPeerConnection()) {}
  private send(value: unknown) { if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(value)); }
  async start(stream: MediaStream) {
    this.stream = stream; stream.getAudioTracks().forEach(t => { t.enabled = false; });
    const peer = this.createPeer(); this.peer = peer; for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const channel = peer.createDataChannel('oai-events'); this.channel = channel;
    const ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Attach rejection handling immediately while SDP is exchanged.
    void ready.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    channel.onmessage = event => { try { if (typeof event.data !== 'string' || event.data.length > 300000) throw Error('Oversized transcript event'); this.event(JSON.parse(event.data)); } catch { this.fail(Error('Dictation could not read the voice connection.')); } };
    peer.onconnectionstatechange = () => { if (!this.closed && ['disconnected', 'failed', 'closed'].includes(peer.connectionState)) this.fail(Error('Dictation lost its microphone connection. Available words are kept.')); };
    try {
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      const answer = await this.api<{ sdp: string }>('assistant/dictation/offer', { requestId: crypto.randomUUID(), epoch: this.epoch, attemptId: this.attempt.id, sdp: offer.sdp }, undefined, 35000);
      if (this.closed) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      // The provider cannot acknowledge settings until the SDP exchange finishes.
      timer = setTimeout(() => this.rejectReady?.(Error('Dictation did not confirm its microphone settings.')), 15000); await ready;
      if (!this.closed) { stream.getAudioTracks().forEach(t => { t.enabled = true; }); this.duration = setTimeout(() => this.fail(Error('Recording reached two minutes. Available words are kept.')), 120000); }
    } finally { clearTimeout(timer); }
  }
  private turn(id: string) {
    if (!id || id.length > 256 || this.turns.size >= 500 && !this.turns.has(id)) { this.fail(Error('Recording reached its limit. Available words are kept.')); return; }
    let turn = this.turns.get(id);
    if (!turn) { turn = { id, text: '', final: false, order: this.turns.size }; this.turns.set(id, turn); }
    return turn;
  }
  private text() { return orderDictationTurns([...this.turns.values()]).map(t => t.text).filter(Boolean).join('\n'); }
  private save(turn: DictationTurn) {
    const { id: turnId, text, order, previousTurnId } = turn;
    this.chain = this.chain.then(() => this.api('assistant/dictation/caption', { requestId: crypto.randomUUID(), epoch: this.epoch, attemptId: this.attempt.id, turnId, text, final: true, order, ...(previousTurnId !== undefined ? { previousTurnId } : {}) }).then(() => undefined)).catch(() => { this.saveError = Error('The dictated words are kept in this window; their save was not confirmed.'); });
  }
  private event(event: any) {
    if (this.closed) return;
    if (typeof event.event_id === 'string') { if (this.seen.has(event.event_id)) return; if (this.seen.size >= 10000) { this.fail(Error('Recording reached its limit. Available words are kept.')); return; } this.seen.add(event.event_id); }
    if (event.type === 'session.created') {
      this.send({ type: 'session.update', session: { type: 'realtime', tools: [], tool_choice: 'none', instructions: 'Transcribe the microphone input only. Never respond, speak, or call tools.', audio: { input: { transcription: { model: 'gpt-live-transcribe' }, turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false } } } } }); return;
    }
    if (event.type === 'session.updated') {
      const session = event.session;
      if (session?.audio?.input?.transcription?.model === 'gpt-live-transcribe' && session.audio.input.turn_detection?.create_response === false && session.tool_choice === 'none' && Array.isArray(session.tools) && !session.tools.length) this.resolveReady?.();
      return;
    }
    if (event.type === 'response.created' || event.type === 'response.function_call_arguments.done') { this.send({ type: 'response.cancel' }); this.fail(Error('Dictation received an unexpected response. The microphone was stopped.')); return; }
    if (event.type === 'input_audio_buffer.speech_started' && typeof event.item_id === 'string') { const turn = this.turn(event.item_id); if (turn && !turn.final) this.pending.add(turn.id); }
    if (event.type === 'input_audio_buffer.committed') {
      this.committed = true;
      if (typeof event.item_id === 'string') {
        if (typeof event.previous_item_id === 'string' && !this.turn(event.previous_item_id)) return;
        const turn = this.turn(event.item_id); if (!turn) return;
        if ((event.previous_item_id === null || typeof event.previous_item_id === 'string') && event.previous_item_id !== turn.id && turn.previousTurnId === undefined) {
          turn.previousTurnId = event.previous_item_id; this.update(this.text()); if (turn.final) this.save(turn);
        }
        if (!turn.final) this.pending.add(turn.id);
      }
    }
    if (event.type === 'error') { if (event.error?.code === 'input_audio_buffer_commit_empty') { this.committed = true; return; } this.fail(Error('The voice connection could not transcribe this recording. Available words are kept.')); return; }
    if (event.type === 'conversation.item.input_audio_transcription.failed') { this.fail(Error('A spoken phrase could not be transcribed. Available words are kept.')); return; }
    const final = event.type === 'conversation.item.input_audio_transcription.completed';
    if (!final && event.type !== 'conversation.item.input_audio_transcription.delta' || typeof event.item_id !== 'string') return;
    const prior = this.turn(event.item_id); if (!prior || prior.final) return;
    if (final && typeof event.transcript === 'string' && !event.transcript.trim() && prior.text.trim()) { this.fail(Error('The last spoken phrase was not confirmed. Available words are kept.')); return; }
    const text = final ? event.transcript : prior.text + (event.delta ?? ''); if (typeof text !== 'string') return;
    if (!final) this.pending.add(event.item_id);
    if ([...this.turns].reduce((length, [id, turn]) => length + (id === event.item_id ? 0 : turn.text.length + 1), text.length) > 100000) { this.fail(Error('Recording reached its limit. Available words are kept.')); return; }
    const turn = { ...prior, text, final }; this.turns.set(event.item_id, turn); this.update(this.text());
    if (final) {
      this.pending.delete(event.item_id);
      this.save(turn);
    }
  }
  async finish() {
    this.stream?.getAudioTracks().forEach(t => { t.enabled = false; });
    this.committed = false; this.send({ type: 'input_audio_buffer.commit' });
    const until = Date.now() + 5000;
    while (!this.closed && (!this.committed || this.pending.size) && Date.now() < until) await new Promise(r => setTimeout(r, 80));
    await this.chain;
    if (this.saveError) throw this.saveError;
    if (this.closed || !this.committed || this.pending.size) throw Error('The last words did not finish transcribing. Available text is kept.');
  }
  private fail(error: Error) { this.rejectReady?.(error); this.close(); this.failed(error); }
  close() { if (this.closed) return; this.closed = true; clearTimeout(this.duration); this.rejectReady?.(Error('Dictation stopped.'));  this.stream?.getTracks().forEach(t => t.stop()); this.peer?.close(); this.channel?.close(); }
}
