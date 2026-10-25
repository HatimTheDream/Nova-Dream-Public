import { useEffect, useRef, useState } from 'react';
import type { AssistantGroup } from '../../../packages/domain/assistant-groups';
import { Dialog } from './ui';
import { request } from './api';
import { draftBrowserStorage as storage } from './draft-browser-storage';
import { checkGroupWritingCopy, copyGroupWriting, discoverGroupWriting, groupWritingTarget,
  type GroupRecoveryScope, type GroupWritingCopy, type GroupWritingEntry } from './group-writing-recovery';
import type { GroupViewTarget } from './assistant-group-view';

export function GroupWritingRecovery({ scope, groups, canOpen, open, close }: {
  scope: GroupRecoveryScope; groups: readonly AssistantGroup[]; canOpen: boolean;
  open(target: NonNullable<GroupViewTarget>): boolean; close(): void;
}) {
  const [list, setList] = useState(() => discoverGroupWriting(storage, scope, groups));
  const [selected, setSelected] = useState<GroupWritingEntry>(), [copied, setCopied] = useState<GroupWritingCopy>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), checking = useRef(false), identity = JSON.stringify(scope), latest = useRef({ identity, canOpen });
  latest.current = { identity, canOpen };
  const current = () => alive.current && latest.current.identity === identity && latest.current.canOpen;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = () => {
    if (checking.current) return;
    setList(discoverGroupWriting(storage, scope, groups)); setSelected(undefined); setCopied(undefined); setError('');
  };
  const recover = async () => {
    if (!canOpen || checking.current || !selected || !current()) return;
    checking.current = true; setBusy(true); setError('');
    try {
      if (copied) checkGroupWritingCopy(storage, copied, scope);
      const source = copied ? { ...selected, key: copied.key, raw: copied.raw } : selected;
      const target = await groupWritingTarget(source, scope, url => request(url), current);
      if (!current()) return;
      const kept = copied ? { ...copied, target } : copyGroupWriting(storage, selected, scope, target);
      setCopied(kept);
      checkGroupWritingCopy(storage, kept, scope);
      if (!open(target)) { setError('Your copy is kept. Finish the current edit or free browser storage, then choose Open Kept Copy.'); return; }
      close();
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : 'The original Group writing is kept. Recovery could not be confirmed.');
    } finally { checking.current = false; if (alive.current && latest.current.identity === identity) setBusy(false); }
  };
  return <Dialog title="Recover Group Writing" close={close}>
    <p>Review Group names and member selections kept by this browser, including closed tabs. Opening a copy keeps the original and sends no Group change.</p>
    <button className="text-button" disabled={busy} onClick={refresh}>Refresh List</button>
    {list.notice && <p role="status">{list.notice}</p>}
    {!list.entries.length && <p>No unfinished Group writing was found for this device.</p>}
    <div className="record-draft-tray" aria-label="Kept Group Writing">{list.entries.map(item =>
      <button className="card record-list-item" key={item.key} disabled={busy} aria-pressed={selected?.key === item.key}
        onClick={() => { setSelected(item); setCopied(undefined); setError(''); }}>
        <span><strong className="preserve-case">{item.title}</strong><small>{item.scope.windowId === scope.windowId ? 'This Window' : 'Another Or Closed Tab'}{item.problem ? ' · Review Needed' : ''}</small></span>
      </button>)}</div>
    {selected && <section aria-label="Group Writing Preview">
      <h3 className="preserve-case">{selected.title}</h3>
      {selected.journal && <><p>{selected.journal.draft.members.length} Member Selections Kept</p>
        {selected.journal.pending && <p>{selected.journal.pending.receipt ? 'The original change is confirmed.' : selected.journal.pending.rejection ? 'The original change was rejected before saving.' : selected.journal.pending.dispatched ? 'The original change is unconfirmed. Check its original status in the Group editor.' : 'The original change has not been sent.'} Its exact request and your newer writing stay together.</p>}
      </>}
      {selected.problem && <p role="status">{selected.problem}</p>}
      <button className="primary" disabled={busy || !canOpen || !!selected.problem} onClick={() => void recover()}>
        {busy ? 'Checking Saved Group…' : copied ? 'Open Kept Copy' : selected.scope.windowId === scope.windowId ? 'Open This Window’s Writing' : 'Copy Into This Window'}
      </button>
    </section>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </Dialog>;
}
