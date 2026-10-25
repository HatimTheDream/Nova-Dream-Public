import { useEffect, useRef, useState } from 'react';
import type { GroupDraftScope } from '../../../packages/domain/assistant-group-turns';
import { draftBrowserStorage as storage } from './draft-browser-storage';
import { Dialog } from './ui';
import { request } from './api';
import { GroupMessageJournal } from './group-message-journal';
import { preparationUrl } from './group-message-reader';
import { applyGroupMessageCopy, discoverGroupMessages, planGroupMessageCopy,
  type MessageRecoveryScope, type MessageWritingEntry, type MessageWritingCopy } from './group-message-recovery';

export function GroupMessageRecovery({ scope, prepare, opened, close }: {
  scope: MessageRecoveryScope; prepare(): boolean; opened(scope: GroupDraftScope): boolean; close(): void;
}) {
  const [list, setList] = useState(() => discoverGroupMessages(storage, scope));
  const [selected, setSelected] = useState<MessageWritingEntry>(), [copy, setCopy] = useState<MessageWritingCopy>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const alive = useRef(true), working = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = () => {
    if (working.current) return;
    setList(discoverGroupMessages(storage, scope)); setSelected(undefined); setCopy(undefined); setError('');
  };
  const original = async () => {
    if (!selected?.value || working.current || selected.problem) return;
    working.current = true; setBusy(true); setError('');
    try {
      if (storage.getItem(selected.key) !== selected.raw) throw Error('The original writing changed. Refresh the list.');
      const journal = new GroupMessageJournal(storage, selected.scope, () => alive.current);
      if (journal.invalid) throw Error(journal.error);
      if (journal.canContinue) await journal.continueOriginal(command => request('assistant/group-preparations', command));
      else await journal.observe(command => request(preparationUrl(command.groupId, { view: 'request', requestId: command.requestId })));
      if (!alive.current) return;
      const next = discoverGroupMessages(storage, scope);
      setList(next); setSelected(next.entries.find(row => row.key === selected.key)); setCopy(undefined); setError(journal.error);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'The original request is kept.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const recover = () => {
    if (!selected || working.current || selected.problem || !copy && !prepare()) return;
    try {
      const plan = copy ?? planGroupMessageCopy(storage, selected, scope);
      setCopy(plan); // Keep this exact plan through an unconfirmed readback.
      const target = applyGroupMessageCopy(storage, plan, scope);
      if (!opened(target)) throw Error('The copy is kept. Check the same kept copy before opening it.');
      close();
    } catch (e) { setError(e instanceof Error ? e.message : 'The original writing is kept.'); }
  };
  const pending = selected?.value?.pending, unresolved = pending && !pending.receipt && !pending.rejection;
  return <Dialog title="Recover Group Messages" close={close}>
    <p>Review full writing kept by this browser, including closed tabs. Copying creates an unsaved draft for the same captured recipients and keeps the original.</p>
    <button disabled={busy} onClick={refresh}>Refresh Drafts</button>
    {list.notice && <p role="status">{list.notice}</p>}
    {!list.entries.length && <p>No kept message drafts were found for this Group.</p>}
    <div className="record-draft-tray" aria-label="Kept Group Messages">{list.entries.map(item => <button key={item.key}
      className="card record-list-item" disabled={busy} aria-pressed={selected?.key === item.key}
      onClick={() => { setSelected(item); setCopy(undefined); setError(''); setCopied(false); }}>
      <span><strong className="preserve-case">{item.value?.writing.text.slice(0, 100) || 'Kept Message'}</strong>
        <small>{item.scope.windowId === scope.windowId ? 'This Window' : 'Another Or Closed Tab'} · {item.scope.recipients.length} {item.scope.recipients.length === 1 ? 'Recipient' : 'Recipients'}{item.problem ? ' · Review Needed' : ''}</small></span>
    </button>)}</div>
    {selected && <section aria-label="Original Message Preview">
      {selected.value && <><pre className="group-recovery-writing">{selected.value.writing.text}</pre>
        <p>{selected.value.writing.sources.length} {selected.value.writing.sources.length === 1 ? 'Source' : 'Sources'} · {selected.value.writing.history.length} {selected.value.writing.history.length === 1 ? 'Earlier Message' : 'Earlier Messages'} · {selected.value.writing.responses.length} {selected.value.writing.responses.length === 1 ? 'Reply' : 'Replies'}</p></>}
      {selected.problem && <p role="status">{selected.problem}</p>}
      {unresolved && <p role="status">The original {pending!.command.action === 'prepare' ? 'preparation' : 'save'} is {pending!.dispatched ? 'unconfirmed' : 'kept and not sent'}. Resolve that exact request before making a separate draft.</p>}
      <div className="button-row">
        {unresolved && <button disabled={busy || !!selected.problem} onClick={() => void original()}>
          {pending!.dispatched ? 'Check Original Request' : 'Continue Original Request'}</button>}
        <button className="primary" disabled={busy || !!selected.problem || !!unresolved} onClick={recover}>
          {copy ? 'Check And Open Kept Copy' : selected.scope.windowId === scope.windowId ? 'Open Original Draft' : 'Copy Into This Window'}</button>
        <button onClick={() => void navigator.clipboard.writeText(selected.value?.writing.text ?? selected.raw)
          .then(() => { if (alive.current) setCopied(true); }).catch(() => { if (alive.current) setError('Copy is unavailable. Your full writing remains visible here.'); })}>Copy Full Writing</button>
      </div>
      {copied && <span role="status">Full Writing Copied</span>}
    </section>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </Dialog>;
}
