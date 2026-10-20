import { useState } from 'react';
import { Dialog } from './ui';
import { checkKeptCopy, copyRecordDraft, discoverRecordDrafts, type KeptCopy, type RecoveryEntry, type RecoveryScope } from './record-draft-recovery';
import { draftBrowserStorage as storage } from './draft-browser-storage';

export function RecordDraftRecovery({ scope, canOpen, open, close }: { scope: RecoveryScope; canOpen: boolean; open(id: string): boolean; close(): void }) {
  const [list, setList] = useState(() => discoverRecordDrafts(storage, scope));
  const [selected, setSelected] = useState<RecoveryEntry>();
  const [copied, setCopied] = useState<KeptCopy>();
  const [error, setError] = useState('');
  const refresh = () => { setList(discoverRecordDrafts(storage, scope)); setSelected(undefined); setCopied(undefined); setError(''); };
  const recover = () => {
    if (!canOpen) { setError('Close the current editor before opening retained writing.'); return; }
    try {
      if (!selected && !copied) return;
      const kept = copied ?? copyRecordDraft(storage, selected!, scope);
      setCopied(kept);
      checkKeptCopy(storage, kept, scope);
      if (!open(kept.id)) { setError('Your copy is kept in this window, but its editor could not be opened. Free browser storage, then choose Open Kept Copy. The original is unchanged.'); return; }
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Browser storage refused the copy. Your original writing is unchanged.'); }
  };
  return <Dialog title={`Recover ${scope.kind === 'contact' ? 'Contact' : 'Content'} Writing`} close={close}>
    <p>Review writing kept by this browser, including other windows. Copying keeps the original and does not save anything to the host.</p>
    <div className="compact-actions"><button className="compact-action" onClick={refresh}>Refresh List</button></div>
    {list.notice && <p role="status">{list.notice}</p>}
    {!list.entries.length && <p>No unfinished writing was found for this device.</p>}
    <div className="record-draft-tray" aria-label="Retained writing">{list.entries.map(item => <button className="card record-list-item" key={item.key} aria-pressed={selected?.key === item.key} onClick={() => { setSelected(item); setCopied(undefined); setError(''); }}>
      <span><strong className="preserve-case">{item.title}</strong><small>{item.windowId === scope.windowId ? 'This window' : `Other window · ${item.windowId.slice(0, 8)}`}{item.journal ? ` · ${item.journal.revision ? `saved base v${item.journal.revision}` : 'unsaved record'}` : ''}</small>{item.problem && <small>Review needed · original kept</small>}</span>
    </button>)}</div>
    {selected && <section aria-label="Recovery preview">
      <h3 className="preserve-case">{selected.title}</h3>
      <p className="metadata">{selected.id}</p>
      {selected.preview && <label>Writing preview<textarea readOnly value={selected.preview} rows={6}/></label>}
      {selected.journal?.pending && <p>This original save is unconfirmed. Its exact request is kept. Use the editor’s existing Save or Reconcile control to check it; opening this writing sends no command.</p>}
      {selected.problem && <p role="status">{selected.problem}</p>}
      <button className="primary" disabled={!!selected.problem || !canOpen} onClick={recover}>{copied ? 'Open Kept Copy' : selected.windowId === scope.windowId ? 'Open This Window’s Writing' : 'Copy Into This Window'}</button>
    </section>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </Dialog>;
}
