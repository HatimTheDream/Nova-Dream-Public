import { useEffect, useRef, useState } from 'react';
import type { Command, Entity, Snapshot } from '../../../packages/domain/contracts';
import { contentPlanningCommand, type ContentPlanningPatch } from '../../../packages/domain/content-planning';
import type { Content } from '../../../packages/domain/workspace-records';
import { ApiError, commit, readLocal, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
type Move = { command: Command; title: string; patch: ContentPlanningPatch; state: 'pending' | 'rejected'; error?: string };
export function useContentPlanning(snapshot: Snapshot, refresh: () => Promise<void>, open: (id: string) => void) {
  const key = `e3:content-planning:${snapshot.deviceId}:${snapshot.epoch}:${retainedWindowId}`;
  const [moves, setMoves] = useState<Record<string, Move>>(() => readLocal(key) ?? {}), [error, setError] = useState('');
  const live = useRef(true), flights = useRef(new Set<string>()), [busy, setBusy] = useState<string[]>([]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const stored = () => readLocal<Record<string, Move>>(key) ?? {};
  useEffect(() => { const changed = (event: Event) => { if ((event as CustomEvent).detail === key) setMoves(stored()); }; window.addEventListener('e3:content-planning-changed', changed); return () => window.removeEventListener('e3:content-planning-changed', changed); }, [key]);
  const keep = (next: Record<string, Move>) => { if (!saveLocal(key, next)) throw new Error('Free browser storage before moving Content. Its original request must be kept first.'); if (live.current) setMoves(next); window.dispatchEvent(new CustomEvent('e3:content-planning-changed', { detail: key })); };
  const update = (id: string, move?: Move) => { const next = stored(); if (move) next[id] = move; else delete next[id]; keep(next); };
  const send = async (move: Move) => {
    const id = move.command.requestId;
    if (flights.current.has(id)) return;
    try { update(id, move); } catch (e) { if (live.current) setError(e instanceof Error ? e.message : 'This move could not be kept.'); return; }
    flights.current.add(id); setBusy([...flights.current]);
    try { await commit<Content>(move.command); update(id); if (live.current) { setError(''); await refresh(); } }
    catch (e) {
      const rejected = e instanceof ApiError && [400, 401, 403, 409, 507].includes(e.status ?? 0);
      // A rejected move may carry a newer saved version. Refresh before exposing
      // its review action so the editor opens that version, not the old card.
      if (rejected && live.current) await refresh();
      try { update(id, { ...move, state: rejected ? 'rejected' : 'pending', error: e instanceof Error ? e.message : 'The move is unconfirmed. Check its original request.' }); } catch (storage) { if (live.current) setError(storage instanceof Error ? storage.message : 'The original request remains kept.'); }
    } finally { flights.current.delete(id); if (live.current) setBusy([...flights.current]); }
  };
  const move = (record: Entity<Content>, patch: ContentPlanningPatch) => {
    try {
      const existing = stored();
      if (Object.values(existing).some(m => m.command.entityId === record.id)) throw new Error('Review this record’s retained move before making another planning change.');
      if (Object.keys(existing).length >= 32) throw new Error('Resolve the retained Content moves before starting more.');
      const journal = readLocal<{ dirty: boolean; pending?: unknown; conflict?: unknown }>(`e3:journal:${snapshot.deviceId}:${record.id}:${retainedWindowId}`);
      if (journal?.dirty || journal?.pending || journal?.conflict) { open(record.id); throw new Error(`Your kept writing is open. Change ${patch.stage ? `its stage to ${patch.stage}` : 'its planned date'} there and save before moving the saved record.`); }
      const command = contentPlanningCommand(record, patch, snapshot.epoch, crypto.randomUUID());
      setError(''); void send({ command, title: record.value.title, patch, state: 'pending' });
    } catch (e) { setError(e instanceof Error ? e.message : 'This move could not be prepared.'); }
  };
  const dismiss = (id: string) => { if (stored()[id]?.state !== 'rejected') return; try { update(id); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'This record is still retained.'); } };
  return { moves, busy, error, move, check: send, dismiss };
}
