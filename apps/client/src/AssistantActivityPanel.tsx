import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { AssistantOperation } from '../../../packages/domain/assistant';
import type { AssistantObservation } from '../../../packages/domain/assistant-observation';
import { request } from './api';
import { Square } from './icons';
import './assistant-activity.css';

export function AssistantActivityPanel({ operation, open, show, close, stop, available, container }: { operation?: AssistantOperation; open: boolean; show: () => void; close: () => void; stop: () => Promise<void>; available: (value: boolean) => void; container?: HTMLElement | null }) {
  const [view, setView] = useState<AssistantObservation | null>(null), [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  const announced = useRef<string | null>(null), callbacks = useRef({ show, available }); callbacks.current = { show, available };
  const working = !!operation && !['completed', 'failed', 'cancelled'].includes(operation.state);
  const workingRef = useRef(working); workingRef.current = working;
  useEffect(() => {
    setView(null); setError(''); announced.current = null; callbacks.current.available(false);
    if (!operation) return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const next = await request<AssistantObservation | null>(`assistant/observation/${operation.id}`, undefined, abort.signal);
        if (!alive) return;
        callbacks.current.available(!!next); setView(current => current?.id === next?.id ? current : next); setError('');
        if (next && !announced.current) { announced.current = next.id; callbacks.current.show(); }
      } catch (e) { if (alive) { callbacks.current.available(false); setView(null); setError(e instanceof Error ? e.message : 'View updates paused.'); } }
      if (alive) timer = setTimeout(() => void poll(), workingRef.current ? 1000 : 5000);
    };
    void poll(); return () => { alive = false; abort.abort(); clearTimeout(timer); };
  }, [operation?.id]);
  if (!open) return null;
  const content = <section className="assistant-activity-panel" aria-label="Live tool view">
    <p className={working && operation?.state !== 'unknown' ? 'activity-live' : 'metadata'}>{operation?.state === 'unknown' ? 'Last reported · Outcome unconfirmed' : operation?.cancelRequested ? 'Stopping…' : working ? 'Live' : operation?.state === 'completed' ? 'Finished' : operation?.state === 'cancelled' ? 'Stopped' : 'Latest run'}</p>
    <div className="assistant-activity-body">
      {view && <figure><img key={view.id} src={`/api/assistant/observation/${view.operationId}/${view.id}`} width={view.width} height={view.height} alt="Latest view returned by the Assistant’s tool" onError={() => setError('This view was replaced. Waiting for the latest capture…')}/><figcaption>Latest tool view · {new Date(view.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</figcaption></figure>}
      {!view && <p className="metadata">{error || 'This tool view is no longer available.'}</p>}
      {view && error && <p className="field-error" role="status">{error}</p>}
    </div>
    {working && <footer><button disabled={stopping || !operation.nativeRunId || operation.cancelRequested} onClick={async () => { setStopping(true); try { await stop(); } catch (e) { setError(e instanceof Error ? e.message : 'Stop is not confirmed.'); } finally { setStopping(false); } }}><Square size={15}/>{stopping || operation.cancelRequested ? 'Stopping…' : 'Stop work'}</button></footer>}
  </section>;
  return container ? createPortal(content, container) : null;
}
