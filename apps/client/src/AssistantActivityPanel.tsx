import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { AssistantOperation } from '../../../packages/domain/assistant';
import type { AssistantObservation } from '../../../packages/domain/assistant-observation';
import { request } from './api';
import { startPolling } from './polling';
import { Square } from './icons';
import './assistant-activity.css';

export function AssistantActivityPanel({ operation, open, show, close, stop, available, container }: { operation?: AssistantOperation; open: boolean; show: () => void; close: () => void; stop: () => Promise<void>; available: (value: boolean) => void; container?: HTMLElement | null }) {
  const [view, setView] = useState<AssistantObservation | null>(null), [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  const announced = useRef<string | null>(null), callbacks = useRef({ show, available }); callbacks.current = { show, available };
  const working = !!operation && !['completed', 'failed', 'cancelled'].includes(operation.state);
  const active = working && operation?.state !== 'unknown';
  const toolEvidence = operation?.tools?.map(tool => `${tool.id}:${tool.state}`).join('|');
  useEffect(() => {
    setView(null); setError(''); announced.current = null; callbacks.current.available(false);
  }, [operation?.id]);
  useEffect(() => {
    if (!operation) return;
    let alive = true, found = false;
    // The state response signals late images. Keep a bounded first-view fallback
    // for older hosts without that hint; a closed view never leaves an idle loop.
    const discoverUntil = !announced.current ? Date.now() + 6000 : 0;
    const abort = new AbortController();
    const end = startPolling({ read: async () => {
      try {
        const next = await request<AssistantObservation | null>(`assistant/observation/${operation.id}`, undefined, abort.signal);
        if (!alive) return;
        found = !!next;
        callbacks.current.available(!!next); setView(current => current?.id === next?.id ? current : next); setError('');
        if (next && !announced.current) { announced.current = next.id; callbacks.current.show(); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'View updates paused.'); return false; }
    }, interval: () => open && active ? 1000 : !found && Date.now() < discoverUntil ? 1500 : null, hiddenInterval: null });
    return () => { alive = false; end(); abort.abort(); };
  }, [operation?.id, operation?.state, operation?.observationId, toolEvidence, open, active]);
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
