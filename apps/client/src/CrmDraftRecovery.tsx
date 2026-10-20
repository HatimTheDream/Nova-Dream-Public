import { useState } from 'react';
import { Dialog } from './ui';
import { checkCrmCopy, copyCrmDraft, discoverCrmDrafts, type CrmKeptCopy, type CrmRecoveryEntry, type CrmRecoveryScope } from './crm-draft-recovery';
import { mayLeaveRecordDrafts } from './record-draft-navigation';
import { draftBrowserStorage as storage } from './draft-browser-storage';

export function CrmDraftRecovery({ scope, canOpen, open, close }: { scope: CrmRecoveryScope; canOpen: boolean; open(slot: string): boolean; close(): void }) {
  const [list, setList] = useState(() => discoverCrmDrafts(storage, scope));
  const [selected, setSelected] = useState<CrmRecoveryEntry>(), [copied, setCopied] = useState<CrmKeptCopy>(), [error, setError] = useState('');
  const refresh = () => { setList(discoverCrmDrafts(storage, scope)); setSelected(undefined); setCopied(undefined); setError(''); };
  const recover = () => {
    if (!canOpen || !mayLeaveRecordDrafts()) { setError('Close the current editor after keeping its writing, then open the retained draft.'); return; }
    try {
      if (!selected && !copied) return;
      const kept = copied ?? copyCrmDraft(storage, selected!, scope); setCopied(kept);
      checkCrmCopy(storage, kept, scope);
      if (!open(kept.slot)) { setError('The copy is kept, but its editor could not be opened. Retry Open Kept Copy after browser storage is available. The original is unchanged.'); return; }
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The copy could not be confirmed. Your original writing is kept.'); }
  };
  return <Dialog title={`Recover ${scope.kind === 'activity' ? 'Activity' : 'Organization'} Writing`} close={close}>
    <p>Review writing kept by this browser, including other windows. Copying preserves the original and sends no save to the host.</p>
    <button className="compact-action" onClick={refresh}>Refresh List</button>
    {list.notice && <p role="status">{list.notice}</p>}
    {!list.entries.length && <p>No unfinished writing was found for this device.</p>}
    <div className="record-draft-tray" aria-label="Retained CRM writing">{list.entries.map(item => <button className="card record-list-item" key={item.key} aria-pressed={selected?.key === item.key} onClick={() => { setSelected(item); setCopied(undefined); setError(''); }}>
      <span><strong className="preserve-case">{item.title}</strong><small>{item.windowId === scope.windowId ? 'This window' : `Other window · ${item.windowId.slice(0, 8)}`}{item.legacy ? ' · earlier writing' : item.journal?.pending ? ' · original save unconfirmed' : ' · unfinished writing'}</small>{item.problem && <small>Review needed · original kept</small>}</span>
    </button>)}</div>
    {selected && <section aria-label="Recovery preview"><h3 className="preserve-case">{selected.title}</h3>
      <label>Writing preview<textarea readOnly value={selected.preview} rows={6}/></label>
      {selected.journal?.pending && <p>The exact original request will be kept. Opening it sends no command; Check Original Save in the editor checks that same request.</p>}
      {selected.legacy && <p>This earlier writing has no verified workspace identity. The editor requires an explicit choice before using it here.</p>}
      {selected.problem && <p role="status">{selected.problem}</p>}
      <button className="primary" disabled={!!selected.problem || !canOpen} onClick={recover}>{copied ? 'Open Kept Copy' : selected.windowId === scope.windowId ? 'Open This Window’s Writing' : 'Copy Into This Window'}</button>
    </section>}
    {error && <p role="alert" className="field-error">{error}</p>}
  </Dialog>;
}
