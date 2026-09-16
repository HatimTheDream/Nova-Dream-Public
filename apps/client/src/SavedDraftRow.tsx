import { useState } from 'react';
import type { Draft, DraftOrganization, DraftRemoval, Entity, Snapshot } from '../../../packages/domain/contracts';
import { readLocal, request, saveLocal, ApiError } from './api';
import { SidebarRow } from './SidebarRow';
import { Archive, File, Trash2 } from './icons';
import { formatSaved } from './ui';

export function SavedDraftRow({ item, snapshot, open, refresh }: { item: Entity<Draft>; snapshot: Snapshot; open: () => void; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const removalKey = `e3:draft-remove:${item.id}`;
  type RemovalIntent = { requestId: string; epoch: string; draftId: string; draftRevision: number; expectedRevision: number };
  const [pendingRemoval, setPendingRemoval] = useState(() => readLocal<RemovalIntent>(removalKey));
  const stored = snapshot.draftOrganization?.find(row => row.draftId === item.id);
  const organization = stored?.draftRevision === item.revision ? stored : undefined;
  const change = async (action: 'pin' | 'unpin' | 'archive' | 'delete' | 'restore', close: () => void) => {
    const key = `e3:draft-organization:${item.id}`;
    type Intent = { requestId: string; epoch: string; draftId: string; draftRevision: number; expectedRevision: number; action: typeof action };
    let kept = readLocal<Intent>(key);
    if (kept && stored && stored.revision > kept.expectedRevision) { localStorage.removeItem(key); kept = undefined; }
    const intent = kept ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, draftId: item.id, draftRevision: item.revision, expectedRevision: stored?.revision ?? 0, action };
    if (!saveLocal(key, intent)) { setError('Free browser storage before organizing this draft.'); return; }
    setBusy(true); setError('');
    try { await request<DraftOrganization>('assistant/draft/organize', intent); localStorage.removeItem(key); await refresh(); close(); }
    catch (e) { if (e instanceof ApiError && ['draft_changed', 'epoch_changed'].includes(e.code)) { localStorage.removeItem(key); await refresh(); } setError(e instanceof Error ? e.message : 'Change not confirmed. Try again.'); }
    finally { setBusy(false); }
  };
  const remove = async (close: () => void) => {
    const intent = pendingRemoval ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, draftId: item.id, draftRevision: item.revision, expectedRevision: stored?.revision ?? 0 };
    if (!saveLocal(removalKey, intent)) { setError('Free browser storage before removing this draft.'); return; }
    setPendingRemoval(intent); setBusy(true); setError('');
    try { await request<DraftRemoval>('assistant/draft/remove', intent); localStorage.removeItem(removalKey); setPendingRemoval(undefined); await refresh(); close(); }
    catch (e) {
      if (e instanceof ApiError && ['draft_changed', 'epoch_changed', 'request_reused'].includes(e.code)) { localStorage.removeItem(removalKey); setPendingRemoval(undefined); await refresh(); }
      setError(e instanceof Error ? e.message : 'Removal is not confirmed. Check again to finish the same request.');
    } finally { setBusy(false); }
  };
  return <SidebarRow title={item.value.title} icon={<File size={16}/>} pinned={organization?.pinned} secondary={`Draft · ${formatSaved(item.updatedAt)}`} open={open} kind={confirm ? 'dialog' : 'menu'} onClose={() => { setConfirm(false); setError(''); }}>
    {close => confirm ? <div className="chat-action-form">
      <strong>Remove this draft permanently?</strong>
      <p>This removes the saved draft from this workspace. You cannot restore it here.</p>
      <p className="metadata">Sent messages, files and saved outputs stay separate. Offline and recovery copies may remain.</p>
      <div className="button-row"><button disabled={busy} onClick={close}>Keep draft</button><button className="chat-delete-action" disabled={busy} onClick={() => void remove(close)}>{busy ? 'Checking…' : pendingRemoval ? 'Check removal' : 'Remove permanently'}</button></div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div> : <>
      <button role="menuitem" disabled={busy || !!pendingRemoval} onClick={() => void change(organization?.pinned ? 'unpin' : 'pin', close)}>{organization?.pinned ? 'Unpin' : 'Pin'}</button>
      <button role="menuitem" disabled={busy || !!pendingRemoval} onClick={() => void change(organization?.folder && organization.folder !== 'active' ? 'restore' : 'archive', close)}><Archive size={17}/>{organization?.folder && organization.folder !== 'active' ? 'Restore' : 'Archive'}</button>
      {organization?.folder !== 'deleted' && <button role="menuitem" className="chat-delete-action" disabled={busy || !!pendingRemoval} onClick={() => void change('delete', close)}><Trash2 size={17}/>Delete</button>}
      {(organization?.folder === 'deleted' || pendingRemoval) && <button role="menuitem" className="chat-delete-action" disabled={busy} onClick={() => setConfirm(true)}><Trash2 size={17}/>{pendingRemoval ? 'Check removal' : 'Remove permanently'}</button>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </>}
  </SidebarRow>;
}
