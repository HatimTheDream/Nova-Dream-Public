import { BrowserDictation } from './browser-dictation';
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

export function useDictation(epoch: string, draftId: string, append: (text: string) => void) {
  const key = `e3:dictation:${epoch}:${draftId}`;
  const [preview, setPreview] = useState(() => readLocal<{ text: string }>(key)?.text ?? ''), [phase, setPhase] = useState<'idle' | 'connecting' | 'listening' | 'finishing'>('idle'), [error, setError] = useState('');
  const alive = useRef(true), attempt = useRef<DictationAttempt | undefined>(undefined), latest = useRef(preview), appendRef = useRef(append); appendRef.current = append;
  const media = useRef<MediaStream | undefined>(undefined), audio = useRef<AudioContext | undefined>(undefined), processor = useRef<ScriptProcessorNode | undefined>(undefined), timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const chain = useRef(Promise.resolve()), queued = useRef(0), capturing = useRef(false), stopping = useRef(false), sequence = useRef(0);
  const browser = useRef<BrowserDictation | undefined>(undefined);
  const ticket = useRef(0), failed = useRef(false);
  const release = () => { browser.current?.close(); capturing.current = false; processor.current?.disconnect(); processor.current = undefined; media.current?.getTracks().forEach(t => t.stop()); media.current = undefined; void audio.current?.close(); audio.current = undefined; clearInterval(timer.current); };
  const keep = (a: DictationAttempt, expectedTicket = ticket.current) => {
    if (expectedTicket !== ticket.current) return;
    if (a.epoch !== epoch || a.draftId !== draftId || attempt.current && a.id !== attempt.current.id) return;
    attempt.current = a; if (a.route !== 'browser' || !browser.current) latest.current = a.text;
    saveLocal(key, { text: latest.current, attemptId: a.id });
    if (alive.current) setPreview(latest.current);
  };
  const end = async (a: DictationAttempt) => request<DictationAttempt>('assistant/dictation/end', { requestId: crypto.randomUUID(), epoch, attemptId: a.id }, undefined, 35000);
  const stop = async (insert = true) => {
    if (stopping.current) return; stopping.current = true; if (alive.current) setPhase('finishing');
    try { if (browser.current) await browser.current.finish(); ticket.current++; release(); await chain.current; if (failed.current) throw Error('Dictation was interrupted. Available text is kept.'); if (attempt.current) { const result = await end(attempt.current); keep(result); if (result.state === 'failed') throw Error(result.error ?? 'Dictation could not finish.'); } if (insert && alive.current && latest.current.trim()) { appendRef.current(latest.current.trim()); localStorage.removeItem(key); latest.current = ''; setPreview(''); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Dictation ended. Available text is kept.'); }
    finally { ticket.current++; release(); if (attempt.current?.route === 'browser') void end(attempt.current).catch(() => undefined); browser.current = undefined; stopping.current = false; if (alive.current) setPhase('idle'); }
  };
  const fail = (reason: unknown, expectedTicket = ticket.current) => {
    if (expectedTicket !== ticket.current || failed.current) return;
    failed.current = true; const endingTicket = ++ticket.current; release();
    if (alive.current) { setError(reason instanceof Error ? reason.message : 'Dictation stopped.'); setPhase(attempt.current ? 'finishing' : 'idle'); }
    if (attempt.current) void end(attempt.current).then(a => { keep(a, endingTicket); if (endingTicket === ticket.current) localStorage.removeItem(`${key}:start`); }).catch(() => undefined).finally(() => { if (alive.current && endingTicket === ticket.current) setPhase('idle'); });
  };
  const start = async () => {
    if (phase !== 'idle' || stopping.current || latest.current.trim()) return;
    const capturedTicket = ++ticket.current; failed.current = false;
    setPhase('connecting'); setError(''); latest.current = ''; setPreview(''); attempt.current = undefined; sequence.current = 0; queued.current = 0; chain.current = Promise.resolve();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Microphone access is unavailable in this browser.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!alive.current || stopping.current || capturedTicket !== ticket.current) { stream.getTracks().forEach(t => t.stop()); return; } media.current = stream;
      const intentKey = `${key}:start`, input = readLocal<object>(intentKey) ?? { requestId: crypto.randomUUID(), epoch, draftId };
      if (!saveLocal(intentKey, input)) throw Error('Free browser storage before dictating.');
      let a = await request<DictationAttempt>('assistant/dictation/start', input); keep(a, capturedTicket);
      for (let n = 0; a.state === 'preparing' && alive.current && !stopping.current && capturedTicket === ticket.current && n < 40; n++) { await new Promise(r => setTimeout(r, 250)); a = await request<DictationAttempt>(`assistant/dictation/${a.id}`); keep(a, capturedTicket); }
      if (!alive.current || stopping.current || capturedTicket !== ticket.current) { release(); await end(a); return; }
      if (a.state === 'listening' && a.route === 'browser') {
        localStorage.removeItem(intentKey);
        const live = new BrowserDictation(epoch, a, text => { if (capturedTicket !== ticket.current) return; latest.current = text; saveLocal(key, { text, attemptId: a.id }); if (alive.current) setPreview(text); }, e => fail(e, capturedTicket)); browser.current = live;
        await live.start(stream);
        if (!alive.current || stopping.current || capturedTicket !== ticket.current) { release(); await end(a); return; }
        setPhase('listening'); timer.current = setInterval(() => { void request<DictationAttempt>(`assistant/dictation/${a.id}`).then(next => { if (next.state !== 'listening') fail(Error(next.error ?? 'Dictation ended.'), capturedTicket); }).catch(e => fail(e, capturedTicket)); }, 2000); return;
      }
      if (a.state !== 'listening' || !a.sampleRate || !a.encoding) throw Error(a.error ?? 'Dictation did not become ready.');
      localStorage.removeItem(intentKey);
      const context = new AudioContext({ sampleRate: a.sampleRate }); audio.current = context; await context.resume();
      if (!alive.current || stopping.current || capturedTicket !== ticket.current) { release(); await end(a); return; }
      if (context.sampleRate !== a.sampleRate) throw Error('The microphone sample rate is unsupported.');
      const source = context.createMediaStreamSource(stream), node = context.createScriptProcessor(4096, 1, 1); processor.current = node; capturing.current = true;
      node.onaudioprocess = e => {
        if (!capturing.current) return;
        if (queued.current >= 8) { fail(Error('Dictation could not keep up with the connection. Available text is kept.')); return; }
        const payload = { requestId: crypto.randomUUID(), epoch, attemptId: a.id, sequence: sequence.current++, audio: encodeDictation(e.inputBuffer.getChannelData(0), a.encoding!) }; queued.current++;
        chain.current = chain.current.then(async () => { if (failed.current || !alive.current) return; const next = await request<DictationAttempt>('assistant/dictation/audio', payload); keep(next, capturedTicket); }).catch(e => fail(e, capturedTicket)).finally(() => { queued.current--; });
      };
      source.connect(node); node.connect(context.destination); setPhase('listening');
      let reading = false;
      timer.current = setInterval(() => { if (reading || !capturing.current) return; reading = true; void request<DictationAttempt>(`assistant/dictation/${a.id}`).then(next => { if (capturedTicket !== ticket.current) return; keep(next, capturedTicket); if (next.state !== 'listening') fail(Error(next.error ?? 'Dictation ended. Use the available text below.')); }).catch(fail).finally(() => { reading = false; }); }, 650);
    } catch (e) { fail(e, capturedTicket); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; release(); if (attempt.current) void end(attempt.current).then(keep).catch(() => undefined); }; }, []);
  const useText = () => { if (latest.current.trim()) appendRef.current(latest.current.trim()); localStorage.removeItem(key); latest.current = ''; setPreview(''); setError(''); };
  return { phase, preview, error, start, stop, useText, discard: () => { latest.current = ''; setPreview(''); setError(''); localStorage.removeItem(key); } };
}
