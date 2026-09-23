import { createHash } from 'node:crypto';
import { z } from 'zod';
import { speechAudioLimit, speechTextLimit, type SpeechAudio, type SpeechCatalog } from '../../packages/domain/read-aloud.js';
import type { AssistantTransport } from './gateway.js';
import { Fault } from './store.js';

const provider = z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(200), configured: z.boolean(), aliases: z.array(z.string().max(200)).max(100).optional() });
const catalogSchema = z.object({ speech: z.object({ ready: z.boolean(), activeProvider: z.string().min(1).max(200), providers: z.array(provider).max(100) }) });
const inputSchema = z.object({ requestId: z.uuid(), epoch: z.string().min(1).max(200), text: z.string().trim().min(1).max(speechTextLimit), language: z.string().regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/).max(80).optional() }).strict();
const resultSchema = z.object({ audioBase64: z.string().min(4).max(Math.ceil(speechAudioLimit / 3) * 4), provider: z.string().min(1).max(200), mimeType: z.string().max(100).optional(), fileExtension: z.string().max(12).optional() });
const audioTypes = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac']);
const extensionTypes: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
type Attempt = { digest: string; expires: number; pending: boolean; result?: Promise<SpeechAudio> };

function hasAudioHeader(bytes: Buffer, mimeType: string): boolean {
  const starts = (value: string) => bytes.subarray(0, value.length).toString('ascii') === value;
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return bytes.length >= 12 && starts('RIFF') && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if (mimeType === 'audio/mpeg') return starts('ID3') || bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (mimeType === 'audio/aac') return starts('ADIF') || bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (mimeType === 'audio/ogg') return starts('OggS');
  if (mimeType === 'audio/flac') return starts('fLaC');
  if (mimeType === 'audio/mp4') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  return mimeType === 'audio/webm' && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

/** Speech uses the already configured provider and already granted scope. It never configures accounts. */
export class SpeechPlayback {
  private attempts = new Map<string, Attempt>();
  constructor(private gateway: AssistantTransport, private epoch: () => string, private now = Date.now, private prepare?: () => Promise<void>) {}
  async catalog(): Promise<SpeechCatalog> {
    const epoch = this.epoch();
    const unavailable = (message: string): SpeechCatalog => ({ state: 'unavailable', epoch, message });
    try { await this.prepare?.(); }
    catch { return unavailable('The host has not confirmed speech playback access. You can use your device voice instead.'); }
    if (epoch !== this.epoch()) return unavailable('The workspace changed. Start reading the current reply again.');
    const connection = this.gateway.status();
    if (connection.state !== 'ready') return unavailable('Connect the Assistant to check its reading voice. You can use your device voice instead.');
    if (!connection.methods.includes('talk.catalog') || !connection.methods.includes('talk.speak') || !connection.grantedScopes.includes('operator.talk')) return unavailable('This connection has not granted speech playback. You can use your device voice instead.');
    try {
      const raw = catalogSchema.safeParse(await this.gateway.request('talk.catalog', {}));
      const current = this.gateway.status();
      if (epoch !== this.epoch() || current.generation !== connection.generation || current.state !== 'ready' || !current.grantedScopes.includes('operator.talk')) return unavailable('The Assistant connection changed. Start reading again when it is ready.');
      if (!raw.success || !raw.data.speech.ready) return unavailable('A configured reading voice is not available. You can use your device voice instead.');
      const active = raw.data.speech.providers.find(p => p.configured && (p.id === raw.data.speech.activeProvider || p.aliases?.includes(raw.data.speech.activeProvider)));
      if (!active) return unavailable('The configured reading voice could not be verified. You can use your device voice instead.');
      return { state: 'available', epoch, message: 'A configured speech provider is available.', provider: active.id, providerLabel: active.label };
    } catch { return unavailable('Reading voice availability could not be confirmed. You can use your device voice instead.'); }
  }
  async speak(device: string, raw: unknown): Promise<SpeechAudio> {
    const input = inputSchema.parse(raw);
    if (input.epoch !== this.epoch()) throw new Fault(409, 'epoch_changed', 'The workspace changed. Start reading the current reply again.');
    const key = `${device}:${input.requestId}`, digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    for (const [id, item] of this.attempts) if (!item.pending && item.expires <= this.now()) this.attempts.delete(id);
    const existing = this.attempts.get(key);
    if (existing) {
      if (existing.digest !== digest) throw new Fault(409, 'request_reused', 'This reading request belongs to different text.');
      if (!existing.result) throw new Fault(409, 'speech_expired', 'This prepared audio is no longer retained. Start reading again to prepare a new copy.');
      return existing.result;
    }
    if (this.attempts.size >= 256 || [...this.attempts.values()].filter(item => item.pending).length >= 8) throw new Fault(429, 'speech_busy', 'The reader is busy. Try again shortly or use your device voice.');
    const result = this.synthesize(input);
    const attempt: Attempt = { digest, expires: this.now() + 120000, pending: true, result };
    this.attempts.set(key, attempt);
    const settled = () => {
      attempt.pending = false; attempt.expires = this.now() + 120000;
      // Keep only eight audio bodies but retain recent request identities. Long replies can
      // continue immediately, while retrying an evicted request never synthesizes it twice.
      const retained = [...this.attempts.values()].filter(item => !item.pending && item.result);
      for (const old of retained.slice(0, Math.max(0, retained.length - 8))) old.result = undefined;
    };
    void result.then(settled, settled);
    return result;
  }
  private async synthesize(input: z.infer<typeof inputSchema>): Promise<SpeechAudio> {
    const available = await this.catalog();
    if (available.state !== 'available') throw new Fault(409, 'speech_unavailable', available.message);
    const generation = this.gateway.status().generation;
    if (input.epoch !== this.epoch() || this.gateway.status().state !== 'ready' || !this.gateway.status().grantedScopes.includes('operator.talk')) throw new Fault(409, 'speech_changed', 'The reading connection changed. Start again when it is ready.');
    let raw: unknown;
    try { raw = await this.gateway.request('talk.speak', { text: input.text, ...(input.language ? { language: input.language } : {}) }); }
    catch { throw new Fault(502, 'speech_unconfirmed', 'The reading audio was not returned. You can use your device voice; no automatic speech request will be repeated.'); }
    if (input.epoch !== this.epoch() || generation !== this.gateway.status().generation || this.gateway.status().state !== 'ready' || !this.gateway.status().grantedScopes.includes('operator.talk')) throw new Fault(409, 'speech_changed', 'The reading connection changed before its audio arrived.');
    const result = resultSchema.safeParse(raw);
    if (!result.success) throw new Fault(502, 'speech_audio', 'The reading provider did not return supported audio.');
    const mimeType = result.data.mimeType?.toLowerCase().split(';')[0].trim() ?? extensionTypes[result.data.fileExtension?.replace(/^\./, '').toLowerCase() ?? ''];
    const encoded = result.data.audioBase64;
    if (!mimeType || !audioTypes.has(mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Fault(502, 'speech_audio', 'The reading provider returned an audio format this player cannot verify.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > speechAudioLimit || bytes.toString('base64') !== encoded || !hasAudioHeader(bytes, mimeType)) throw new Fault(502, 'speech_audio', 'The reading audio could not be verified.');
    return { audioBase64: encoded, mimeType, provider: result.data.provider };
  }
}
