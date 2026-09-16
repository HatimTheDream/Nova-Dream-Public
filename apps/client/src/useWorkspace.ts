import { useCallback, useEffect, useRef, useState } from 'react';
import { canonical, type Command, type Entity, type Kind, type Snapshot } from '../../../packages/domain/contracts';
import type { AccessContext } from '../../../packages/domain/phone';
import { ApiError, commit, fetchSnapshot, readLocal, request, saveLocal } from './api';
import type { StartupPhase } from './startup-progress';

export function useWorkspace() {
  const [startupPhase, setStartupPhase] = useState<StartupPhase>('connecting');
  const [access, setAccess] = useState<AccessContext>();
  const gated = useRef(false);
  const denyPhone = useCallback(() => { gated.current = true; setAccess({ surface: 'phone', requiresPairing: true }); current.current = undefined; setSnapshot(undefined); setOnline(false); saveLocal('e3:snapshot', null); }, []);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const current = useRef<Snapshot | undefined>(undefined);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [updateRequired, setUpdateRequired] = useState(false);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current || gated.current) return;
    refreshing.current = true;
    try {
      const next = await fetchSnapshot();
      if (gated.current) return;
      if (current.current && next.epoch !== current.current.epoch) {
        // The selected workspace can change without this tab navigating. Update
        // access/recovery mode before mounting the new workspace's controls.
        const context = await request<AccessContext>('access/context');
        if (context.requiresPairing) { denyPhone(); return; }
        if (context.workspaceEpoch && context.workspaceEpoch !== next.epoch) return;
        setAccess(context); saveLocal('e3:access', context);
      }
      if (!current.current || next.epoch !== current.current.epoch || next.cursor >= current.current.cursor) {
        current.current = next; setSnapshot(next); saveLocal('e3:snapshot', next);
      }
      setOnline(true); setError('');
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'phone_pair_required') { denyPhone(); return; }
      setOnline(false); setError(reason instanceof ApiError ? reason.message : 'Host unavailable. Your device keeps unsaved drafts.');
    } finally { refreshing.current = false; }
  }, [denyPhone]);
  useEffect(() => {
    let alive = true;
    const denied = () => { if (alive) denyPhone(); };
    window.addEventListener('e3:pair-required', denied);
    const outdated = () => { if (alive) { setUpdateRequired(true); setOnline(false); } };
    window.addEventListener('e3:update-required', outdated);
    void request<AccessContext>('access/context').then(async context => {
      if (!alive) return;
      setAccess(context); saveLocal('e3:access', context);
      if (context.requiresPairing) { denyPhone(); return; }
      setStartupPhase('session');
      await request('session', {}); if (alive && !gated.current) { setStartupPhase('workspace'); await refresh(); }
    }).catch(reason => {
      if (!alive) return;
      if (reason instanceof ApiError && reason.code === 'phone_pair_required') { denyPhone(); return; }
      // Only a known local desktop may display an offline shared snapshot.
      const context = readLocal<AccessContext>('e3:access');
      if (context?.surface === 'desktop' && location.protocol === 'http:') {
        const cached = readLocal<Snapshot>('e3:snapshot');
        if (cached) { current.current = cached; setSnapshot(cached); }
      }
      setError('Host unavailable. Start the Nova Dream service, then reconnect.');
    });
    const timer = setInterval(() => { void refresh(); }, 2500);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('e3:pair-required', denied); window.removeEventListener('e3:update-required', outdated); };
  }, [refresh, denyPhone]);
  const reconnect = async () => { try {
    setError(''); setStartupPhase('connecting');
    const context = await request<AccessContext>('access/context'); setAccess(context);
    if (context.requiresPairing) { denyPhone(); return; }
    setStartupPhase('session');
    await request('session', {}); setStartupPhase('workspace'); gated.current = false; await refresh();
  } catch (reason) { if (reason instanceof ApiError && reason.code === 'phone_pair_required') denyPhone(); else setError('The host is still unavailable. Your draft is kept.'); } };
  return { snapshot, online, error, refresh, reconnect, access, updateRequired, startupPhase };

}

type Journal<T> = { value: T; revision: number; epoch: string; dirty: boolean; pending?: Command; conflict?: { code: string; message: string; current?: Entity<T> } };
// Each window keeps its own durable proposal. A shared-cookie window must not replace it.
const tabId = (() => { try { const id = sessionStorage.getItem('e3:tab') ?? crypto.randomUUID(); sessionStorage.setItem('e3:tab', id); return id; } catch { return crypto.randomUUID(); } })();
export const retainedWindowId = tabId;
/** Durable local proposal + immutable retry envelope. Server acknowledgment is a separate state. */
export function useRetained<T>(kind: Kind, id: string, initial: T, entity: Entity<T> | undefined, snapshot: Snapshot, refresh: () => Promise<void>, options: { autoSave?: boolean } = {}) {
  const autoSave = options.autoSave !== false;
  const removedRevision = kind === 'draft' ? snapshot.draftRemovals?.find(item => item.draftId === id)?.revision ?? 0 : 0;
  const removal = useRef(removedRevision); removal.current = removedRevision;
  const key = `e3:journal:${snapshot.deviceId}:${id}:${tabId}`;
  const [journal, setJournal] = useState<Journal<T>>(() => {
    const kept = readLocal<Journal<T>>(key);
    if (kept && (kept.dirty || kept.pending || kept.revision >= removedRevision)) return kept;
    return { value: entity?.value ?? initial, revision: entity?.revision ?? removedRevision, epoch: snapshot.epoch, dirty: false };
  });
  const ref = useRef(journal);
  const [storageError, setStorageError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const inFlight = useRef(false);
  const persist = useCallback((next: Journal<T>) => {
    ref.current = next; setJournal(next); const saved = saveLocal(key, next); setStorageError(!saved); return saved;
  }, [key]);
  const change = useCallback((update: T | ((current: T) => T)) => {
    const value = typeof update === 'function' ? (update as (v: T) => T)(ref.current.value) : update;
    return persist({ ...ref.current, value, dirty: true });
  }, [persist]);
  useEffect(() => {
    const local = ref.current;
    if (local.epoch !== snapshot.epoch && local.dirty) {
      if (!local.conflict) persist({ ...local, conflict: { code: 'epoch_changed', message: 'The host has changed. Review this kept proposal before saving it to the recovered host.' } });
    } else if (removedRevision > local.revision && (local.dirty || local.pending)) {
      if (local.conflict?.code !== 'draft_removed') persist({ ...local, conflict: { code: 'draft_removed', message: 'This saved draft was removed. Your unsent writing is kept here. Review it before keeping it as a new draft.' } });
    } else if (!local.dirty && (!local.pending) && ((entity?.revision ?? removedRevision) > local.revision || local.epoch !== snapshot.epoch)) {
      persist({ value: entity?.value ?? initial, revision: entity?.revision ?? removedRevision, epoch: snapshot.epoch, dirty: false });
    }
  }, [entity, snapshot.epoch, removedRevision, initial, persist]);
  const flush = useCallback(async () => {
    const local = ref.current;
    if (!local.dirty || local.conflict || inFlight.current) return;
    const command = local.pending ?? { kind, entityId: id, requestId: crypto.randomUUID(), epoch: local.epoch, expectedRevision: local.revision, payload: local.value };
    if (!persist({ ...local, pending: command })) return;
    inFlight.current = true; setSaving(true);
    try {
      const result = await commit<T>(command);
      const latest = ref.current;
      // A response admitted before removal must never restore the removed draft.
      if (result.revision < removal.current) { await refresh(); return; }
      persist({ ...latest, revision: result.revision, pending: undefined, dirty: canonical(latest.value) !== canonical(command.payload), conflict: undefined });
      setNetworkError(false); await refresh(); return result;
    } catch (error) {
      if (error instanceof ApiError && ['revision_conflict', 'draft_removed', 'conversation_removed', 'conversation_removing', 'conversation_changed', 'epoch_changed', 'request_reused', 'validation', 'missing_project', 'attachment_changed', 'draft_branch', 'invalid_target', 'record_missing', 'record_quota', 'missing_agent', 'agent_changed', 'source_changed', 'contact_merged'].includes(error.code)) {
        persist({ ...ref.current, conflict: { code: error.code, message: error.message, current: error.current as Entity<T> | undefined } });
        if (error.code === 'draft_removed' || error.code === 'conversation_removed') await refresh();
      } else setNetworkError(true);
    } finally { inFlight.current = false; setSaving(false); }
  }, [id, kind, persist, refresh]);
  useEffect(() => { if (!autoSave) return; const timer = setTimeout(() => { void flush(); }, 600); return () => clearTimeout(timer); }, [journal.value, flush, autoSave]);
  useEffect(() => { if (!autoSave) return; const timer = setInterval(() => { void flush(); }, 4000); return () => clearInterval(timer); }, [flush, autoSave]);
  // Another tab sharing the cookie is another editor, never a silent overwrite.
  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key !== key || !event.newValue || event.newValue === JSON.stringify(ref.current)) return;
      const other = JSON.parse(event.newValue) as Journal<T>;
      if (other.revision < removal.current) return;
      if (!ref.current.dirty) { ref.current = other; setJournal(other); }
      else if (canonical(other.value) !== canonical(ref.current.value)) {
        setJournal(current => ({ ...current, conflict: { code: 'local_editor', message: 'Another window is editing this same device draft. Both versions are kept in their windows.' } }));
        ref.current = { ...ref.current, conflict: { code: 'local_editor', message: 'Another window is editing this same device draft. Review before saving.' } };
      }
    };
    window.addEventListener('storage', listener); return () => window.removeEventListener('storage', listener);
  }, [key]);
  const reviewedRevision = () => Math.max(entity?.revision ?? 0, removedRevision, ref.current.conflict?.code === 'revision_conflict' ? ref.current.conflict.current?.revision ?? 0 : 0);
  const reapply = () => { persist({ ...ref.current, revision: reviewedRevision(), epoch: snapshot.epoch, pending: undefined, conflict: undefined, dirty: true }); void flush(); };
  const editProposal = () => {
    if (!ref.current.conflict) return;
    persist({ ...ref.current, revision: reviewedRevision(), epoch: snapshot.epoch, pending: undefined, conflict: undefined, dirty: true });
  };
  const discard = () => {
    const conflictVersion = ref.current.conflict?.code === 'revision_conflict' ? ref.current.conflict.current : undefined;
    const host = conflictVersion && conflictVersion.revision > (entity?.revision ?? 0) ? conflictVersion : entity;
    return persist({ value: host?.value ?? initial, revision: host?.revision ?? removedRevision, epoch: snapshot.epoch, dirty: false });
  };
  const status = storageError ? 'Kept in this window · browser storage is full' : journal.conflict ? 'Review needed · your changes are kept' : saving ? 'Saving to host…' : journal.dirty ? networkError ? 'On this device · waiting for host' : autoSave ? 'On this device · saving soon' : 'Edits kept on this device · save when ready' : journal.revision ? 'Saved on host' : 'Ready for a draft';
  return { value: journal.value, revision: journal.revision, epoch: journal.epoch, pending: journal.pending, change, status, saving, dirty: journal.dirty, conflict: journal.conflict, reapply, editProposal, discard, flush, storageError, networkError };
}
