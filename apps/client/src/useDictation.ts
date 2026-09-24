import type { BrowserDictation } from './browser-dictation';
import { useEffect, useRef, useState } from 'react';
import type { DictationAttempt } from '../../../packages/domain/dictation';
import { readLocal, request, saveLocal } from './api';

/** Nova's microphone relay, bounded and owned by the original draft. */
export function encodeDictation(values: Float32Array, encoding: 'mulaw' | 'pcm16') {
  const bytes = new Uint8Array(values.length * (encoding === 'pcm16' ? 2 : 1)), view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    let sample = Math.round(Math.max(-1, Math.min(1, values[i] ?? 0)) * 32767);
    if (encoding === 'pcm16') { view.setInt16(i * 2, sample, true); continue; }
    const sign = sample < 0 ? 128 : 0; sample = Math.min(32635, Math.abs(sample)) + 132;
    let exponent = 7; for (let mask = 0x4000; exponent > 0 && !(sample & mask); exponent--, mask >>= 1) { /* μ-law segment */ }
    bytes[i] = ~(sign | exponent << 4 | sample >> exponent + 3 & 15) & 255;
  }
  return btoa(String.fromCharCode(...bytes));
}

export function useDictation(epoch: string, draftId: string, update: (text: string, attemptId: string) => boolean) {
  const key = `e3:dictation:${epoch}:${draftId}`;
  const [preview, setPreview] = useState(() => readLocal<{ text: string }>(key)?.text ?? ''), [phase, setPhase] = useState<'idle' | 'connecting' | 'listening' | 'finishing'>('idle'), [error, setError] = useState('');
  const alive = useRef(true), attempt = useRef<DictationAttempt | undefined>(undefined), latest = useRef(preview), updateRef = useRef(update); updateRef.current = update;
  const recovery = useRef(preview), canInsertRecovery = useRef(!preview), identity = useRef(''), delivered = useRef<string | undefined>(undefined), projectionError = useRef<Error | undefined>(undefined);
  const media = useRef<MediaStream | undefined>(undefined), audio = useRef<AudioContext | undefined>(undefined), processor = useRef<ScriptProcessorNode | undefined>(undefined), timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const chain = useRef(Promise.resolve()), queued = useRef(0), stopping = useRef(false), sequence = useRef(0);
  const browser = useRef<BrowserDictation | undefined>(undefined);
  const ticket = useRef(0), failed = useRef(false), draining = useRef<number | undefined>(undefined);
  const acquiring = useRef<(() => void) | undefined>(undefined), pendingStart = useRef<Promise<DictationAttempt> | undefined>(undefined), starting = useRef(false);
  const current = (expectedTicket: number) => alive.current && expectedTicket === ticket.current;
  const release = () => { acquiring.current?.(); browser.current?.close(); processor.current?.disconnect(); processor.current = undefined; media.current?.getTracks().forEach(t => t.stop()); media.current = undefined; void audio.current?.close().catch(() => undefined); audio.current = undefined; clearInterval(timer.current); };
  const retire = (a: DictationAttempt) => {
    if (['ended', 'failed'].includes(a.state) && readLocal<{ requestId: string }>(`${key}:start`)?.requestId === a.requestId) localStorage.removeItem(`${key}:start`);
  };
  const publish = (text: string, id: string, retry = false) => {
    latest.current = text; identity.current = id;
    if (!text.trim() || text === delivered.current) return;
    const saved = saveLocal(key, { text, attemptId: id }); let retained = false;
    if (alive.current && (!projectionError.current || retry)) {
      try { retained = updateRef.current(text, id); }
      catch (e) {
        canInsertRecovery.current = false;
        projectionError.current = e instanceof Error ? e : Error('Dictated words could not be added.');
        setError(projectionError.current.message);
        if (!stopping.current && attempt.current) fail(projectionError.current);
      }
    }
    recovery.current = retained ? '' : text;
    if (retained) { delivered.current = text; localStorage.removeItem(key); }
    else if (!saved && alive.current) setError('Dictated words could not be saved. Keep this chat open and free browser storage.');
    if (alive.current) setPreview(recovery.current);
  };
  const keep = (a: DictationAttempt, expectedTicket = ticket.current) => {
    if (expectedTicket !== ticket.current && expectedTicket !== draining.current) return;
    if (a.epoch !== epoch || a.draftId !== draftId || attempt.current && a.id !== attempt.current.id) return;
    retire(a); attempt.current = a; publish(a.route === 'browser' && browser.current ? latest.current : a.text || latest.current, a.id);
  };
  const end = async (a: DictationAttempt, expectedTicket?: number) => { const ended = await request<DictationAttempt>('assistant/dictation/end', { requestId: crypto.randomUUID(), epoch, attemptId: a.id }, undefined, 35000); retire(ended); if (expectedTicket !== undefined) keep(ended, expectedTicket); return ended; };
  const finished = () => { browser.current = undefined; attempt.current = undefined; starting.current = false; stopping.current = false; if (!recovery.current) { latest.current = ''; delivered.current = undefined; } if (alive.current) setPhase('idle'); };
  const cancel = async () => {
    if (stopping.current) return;
    stopping.current = true; draining.current = undefined; const cancelledTicket = ++ticket.current, known = attempt.current, pending = pendingStart.current;
    release();
    if (alive.current) setPhase(known || pending ? 'finishing' : 'idle');
    try { const a = known ?? await pending; if (a) { keep(a, cancelledTicket); await end(a, cancelledTicket); } }
    catch (e) { if (current(cancelledTicket)) setError(e instanceof Error ? e.message : 'Dictation stopped. Its connection could not be confirmed.'); }
    finally { if (cancelledTicket === ticket.current) finished(); }
  };
  const stop = async () => {
    if (stopping.current) return; stopping.current = true; if (alive.current) setPhase('finishing');
    let ended = false;
    try { if (browser.current) await browser.current.finish(); draining.current = ticket.current; ticket.current++; release(); await chain.current; draining.current = undefined; if (failed.current) throw Error('Dictation was interrupted. Available text is kept.'); if (attempt.current) { const result = await end(attempt.current, ticket.current); ended = true; if (result.state === 'failed' || result.error) throw Error(result.error ?? 'Dictation could not finish.'); } if (!latest.current.trim() && alive.current) setError('No speech was detected. Try again and speak clearly into the microphone.'); }
    catch (e) { if (alive.current) setError((projectionError.current ?? (e instanceof Error ? e : Error('Dictation ended. Available text is kept.'))).message); }
    finally { draining.current = undefined; const endingTicket = ++ticket.current; release(); if (!ended && attempt.current) await end(attempt.current, endingTicket).catch(() => undefined); finished(); }
  };
  const fail = (reason: unknown, expectedTicket = ticket.current) => {
    if (!current(expectedTicket) || failed.current) return;
    failed.current = true; stopping.current = true; draining.current = undefined; const endingTicket = ++ticket.current; release();
    if (alive.current) { setError(reason instanceof Error ? reason.message : 'Dictation stopped.'); setPhase(attempt.current ? 'finishing' : 'idle'); }
    if (attempt.current) void end(attempt.current, endingTicket).catch(() => undefined).finally(() => { if (endingTicket === ticket.current) finished(); });
    else finished();
  };
  const watch = (a: DictationAttempt, capturedTicket: number) => {
    let reading = false;
    timer.current = setInterval(() => {
      if (reading || !current(capturedTicket)) return;
      reading = true;
      void request<DictationAttempt>(`assistant/dictation/${a.id}`).then(next => {
        if (!current(capturedTicket)) return;
        if (a.route !== 'browser') keep(next, capturedTicket);
        if (next.state !== 'listening') fail(Error(next.error ?? 'Dictation ended.'), capturedTicket);
      }).catch(e => fail(e, capturedTicket)).finally(() => { reading = false; });
    }, a.route === 'browser' ? 2000 : 650);
  };
  const start = async () => {
    if (phase !== 'idle' || starting.current || stopping.current || recovery.current.trim()) return;
    const capturedTicket = ++ticket.current; failed.current = false; draining.current = undefined; starting.current = true;
    setPhase('connecting'); setError(''); latest.current = ''; delivered.current = undefined; projectionError.current = undefined; canInsertRecovery.current = true; setPreview(''); attempt.current = undefined; sequence.current = 0; queued.current = 0; chain.current = Promise.resolve();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Microphone access is unavailable in this browser.');
      const stream = await new Promise<MediaStream>((resolve, reject) => {
        let settled = false;
        const finish = (reason: Error) => { if (settled) return; settled = true; clearTimeout(timeout); acquiring.current = undefined; reject(reason); };
        const timeout = setTimeout(() => finish(Error('Microphone access timed out. Allow the microphone in your browser, then try again.')), 20000);
        acquiring.current = () => finish(Error('Dictation cancelled.'));
        void navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(value => {
          if (settled || !current(capturedTicket)) { value.getTracks().forEach(t => t.stop()); return; }
          settled = true; clearTimeout(timeout); acquiring.current = undefined; resolve(value);
        }, reason => finish(Error(reason?.name === 'NotAllowedError' || reason?.name === 'SecurityError' ? 'Allow microphone access in your browser, then try again.' : reason?.name === 'NotFoundError' ? 'No microphone was found. Connect one and try again.' : reason?.name === 'NotReadableError' || reason?.name === 'AbortError' ? 'The microphone is unavailable. Check whether another app is using it, then try again.' : reason instanceof Error ? reason.message : 'Microphone access was not allowed.')));
      });
      if (!current(capturedTicket) || stopping.current) { stream.getTracks().forEach(t => t.stop()); return; } media.current = stream;
      const intentKey = `${key}:start`, input = readLocal<object>(intentKey) ?? { requestId: crypto.randomUUID(), epoch, draftId };
      if (!saveLocal(intentKey, input)) throw Error('Free browser storage before dictating.');
      const preparing = request<DictationAttempt>('assistant/dictation/start', input); pendingStart.current = preparing;
      let a: DictationAttempt;
      try { a = await preparing; } finally { if (pendingStart.current === preparing) pendingStart.current = undefined; }
      keep(a, capturedTicket);
      for (let n = 0; a.state === 'preparing' && current(capturedTicket) && !stopping.current && n < 40; n++) { await new Promise(r => setTimeout(r, 250)); if (!current(capturedTicket) || stopping.current) break; a = await request<DictationAttempt>(`assistant/dictation/${a.id}`); keep(a, capturedTicket); }
      if (!current(capturedTicket) || stopping.current) { if (!stopping.current) { const endingTicket = ticket.current; if (!alive.current) keep(a, endingTicket); const result = await end(a); if (!alive.current) keep(result, endingTicket); } return; }
      if (a.state === 'listening' && a.route === 'browser') {
        localStorage.removeItem(intentKey);
        watch(a, capturedTicket);
        const { BrowserDictation } = await import('./browser-dictation');
        if (!current(capturedTicket) || stopping.current) return;
        const live = new BrowserDictation(epoch, a, text => { if (capturedTicket === ticket.current) publish(text, a.id); }, e => fail(e, capturedTicket)); browser.current = live;
        await live.start(stream);
        if (!current(capturedTicket) || stopping.current) return;
        starting.current = false; setPhase('listening'); return;
      }
      if (a.state !== 'listening' || !a.sampleRate || !a.encoding) throw Error(a.error ?? 'Dictation did not become ready.');
      localStorage.removeItem(intentKey);
      const context = new AudioContext({ sampleRate: a.sampleRate }); audio.current = context; await context.resume();
      if (!current(capturedTicket) || stopping.current) return;
      if (context.sampleRate !== a.sampleRate) throw Error('The microphone sample rate is unsupported.');
      const source = context.createMediaStreamSource(stream), node = context.createScriptProcessor(4096, 1, 1); processor.current = node;
      node.onaudioprocess = e => {
        if (!current(capturedTicket)) return;
        if (queued.current >= 8) { fail(Error('Dictation could not keep up with the connection. Available text is kept.'), capturedTicket); return; }
        const payload = { requestId: crypto.randomUUID(), epoch, attemptId: a.id, sequence: sequence.current++, audio: encodeDictation(e.inputBuffer.getChannelData(0), a.encoding!) }; queued.current++;
        const ownsQueue = () => current(capturedTicket) || draining.current === capturedTicket;
        chain.current = chain.current.then(async () => { if (failed.current || !alive.current || !ownsQueue()) return; const next = await request<DictationAttempt>('assistant/dictation/audio', payload); keep(next, capturedTicket); }).catch(e => { if (draining.current === capturedTicket) failed.current = true; else fail(e, capturedTicket); }).finally(() => { if (ownsQueue()) queued.current--; });
      };
      source.connect(node); node.connect(context.destination); starting.current = false; setPhase('listening');
      watch(a, capturedTicket);
    } catch (e) { fail(e, capturedTicket); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; draining.current = undefined; const endingTicket = ++ticket.current; release(); if (attempt.current) void end(attempt.current, endingTicket).catch(() => undefined); }; }, []);
  const discard = () => { latest.current = ''; recovery.current = ''; delivered.current = undefined; canInsertRecovery.current = true; setPreview(''); setError(''); localStorage.removeItem(key); };
  const useText = () => { if (!canInsertRecovery.current) return; publish(recovery.current, identity.current, true); if (!recovery.current) { projectionError.current = undefined; setError(''); } };
  return { phase, preview, error, start, stop, cancel, useText, discard, canInsertRecovery: canInsertRecovery.current };
}
