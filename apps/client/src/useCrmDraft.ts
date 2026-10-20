import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { CrmState } from '../../../packages/domain/crm';
import { request } from './api';
import { CrmDraft, crmDraftId, type CrmKind, type CrmRecord, type CrmValues } from './crm-draft-client';
import { registerRecordDraftNavigation } from './record-draft-navigation';

const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
export function useCrmDraft<K extends CrmKind>(key: string, kind: K, initial: CrmValues[K], current: CrmRecord<K> | undefined,
  snapshot: Snapshot, saved: () => Promise<void>, contactId?: string) {
  const [id] = useState(() => crmDraftId(storage, key, kind, current?.id));
  const scope = `${snapshot.epoch}:${snapshot.deviceId}:${kind}:${id}:${contactId ?? ''}`;
  const activeScope = useRef(scope); activeScope.current = scope;
  const [, redraw] = useState(0), [reviewed, setReviewed] = useState<{ record?: CrmRecord<K> }>();
  const [reviewing, setReviewing] = useState(false);
  const [editor] = useState(() => new CrmDraft(storage, key, { kind, id, epoch: snapshot.epoch, deviceId: snapshot.deviceId, contactId }, {
    format: 1, kind, id, epoch: snapshot.epoch, contactId, value: initial, revision: current?.revision ?? 0, dirty: false,
  }, command => request(`contacts/${kind}`, command, undefined, 30000), () => redraw(value => value + 1), () => activeScope.current === scope));
  useEffect(() => {
    editor.active = true;
    const retain = () => editor.retain(), unregister = registerRecordDraftNavigation(retain);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!retain()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload); editor.retire(); };
  }, [editor]);
  const submit = async (value?: CrmValues[K]) => {
    const result = await editor.save(current, value);
    if (result && editor.active && activeScope.current === scope) {
      try { await saved(); } catch (reason) {
        if (editor.active && activeScope.current === scope) { editor.error = reason instanceof Error ? reason.message : 'Saved. Refresh this view when available.'; redraw(value => value + 1); }
      }
    }
  };
  const review = async () => {
    if (reviewing || editor.busy || editor.invalid || editor.journal.epoch !== snapshot.epoch) return;
    setReviewing(true);
    try {
      const state = await request<CrmState>('contacts/crm', { epoch: snapshot.epoch, contactId });
      if (!editor.active || activeScope.current !== scope) return;
      const record = (kind === 'activity' ? state.activities : state.organizations).find(row => row.id === id) as CrmRecord<K> | undefined;
      setReviewed({ record });
    } catch (reason) { if (editor.active && activeScope.current === scope) { editor.error = reason instanceof Error ? reason.message : 'The saved version is unavailable. Your writing is kept.'; redraw(value => value + 1); } }
    finally { if (editor.active && activeScope.current === scope) setReviewing(false); }
  };
  return { id, editor, value: editor.journal.value, busy: editor.busy, error: editor.error, pending: !!editor.journal.pending,
    rejected: !!editor.journal.rejection, blocked: editor.blocked, legacy: editor.legacy, changed: editor.changed(current),
    original: editor.original, legacyOriginal: editor.journal.legacyOriginal, reviewing, reviewed,
    change: (value: CrmValues[K]) => editor.change(value), submit, retain: () => editor.retain(), review,
    adoptLegacy: () => editor.adoptLegacy(current),
    acceptReview: () => { if (reviewed && editor.review(reviewed.record)) setReviewed(undefined); },
  };
}
