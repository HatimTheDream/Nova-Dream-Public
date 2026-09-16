import { useState, type ReactNode } from 'react';
import type { Conversation, ConversationMessage } from '../../../packages/domain/assistant';
import { Copy, MoreHorizontal, VolumeUp, Pin } from './icons';
import { ComposerMenu } from './ComposerMenu';
import { Dialog } from './ui';
import { readLocal, saveLocal } from './api';

export function MessageActions({ message, previousUser, conversation, blocked, canFork, fork, extras, pinned, pin, readAloud, reading, remember, sources }: { message: ConversationMessage; previousUser?: ConversationMessage; conversation: Conversation; blocked: boolean; canFork: boolean; fork: (message: ConversationMessage, purpose: 'branch' | 'edit' | 'retry', text?: string) => Promise<void>; extras?: ReactNode; pinned: boolean; pin: () => Promise<void>; readAloud: () => void; reading: boolean; remember?: () => void; sources?: () => void }) {
  const key = `e3:message-revision:${conversation.nativeId}:${message.id}:${message.textHash}`;
  const [editing, setEditing] = useState(false), [text, setText] = useState(() => readLocal<string>(key) ?? message.authoredText ?? message.text), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const branch = async (source: ConversationMessage, purpose: 'branch' | 'edit' | 'retry', text?: string) => { setBusy(true); setNotice(''); try { await fork(source, purpose, text); localStorage.removeItem(key); setEditing(false); } catch (e) { setNotice(e instanceof Error ? e.message : 'The branch was not confirmed.'); } finally { setBusy(false); } };
  return <div className="message-actions"><button className="icon-button" aria-label="Copy message" title="Copy message" onClick={() => void navigator.clipboard.writeText(message.authoredText ?? message.text).then(() => setNotice('Copied')).catch(() => setNotice('Copy was unavailable. Select the text to copy it.'))}><Copy size={16}/></button>
    <ComposerMenu placement="below" label="Message actions" icon={<MoreHorizontal size={16}/>} >{close => <>
      {message.role === 'user' && <button disabled={blocked || busy || !canFork} onClick={() => { close(); setEditing(true); }}>Edit message</button>}
      {message.role === 'assistant' && previousUser && <button disabled={blocked || busy || !canFork} onClick={() => { close(); void branch(previousUser, 'retry'); }}>Try another response</button>}
      <button disabled={blocked || busy || !canFork} onClick={() => { close(); void branch(message, 'branch'); }}>Branch from here</button>
      <button disabled={busy} onClick={() => { close(); setBusy(true); void pin().then(() => setNotice(pinned ? 'Pin removed' : 'Message pinned')).catch(e => setNotice(e instanceof Error ? e.message : 'The pin was not confirmed.')).finally(() => setBusy(false)); }}><Pin size={16}/>{pinned ? 'Unpin message' : 'Pin message'}</button>
      {message.role === 'assistant' && <button disabled={blocked && !reading} onClick={() => { close(); readAloud(); }}><VolumeUp size={16}/>{reading ? 'Stop reading' : 'Read aloud'}</button>}
      {!canFork && <p className="metadata">Connect a runtime with conversation branching to revise messages.</p>}
      {sources && <button onClick={() => { close(); sources(); }}>Sources used</button>}
      {remember && <button disabled={busy} onClick={() => { close(); remember(); }}>Save to memory</button>}
      {extras}
    </>}</ComposerMenu>{notice && <span className="metadata" role="status">{notice}</span>}
    {editing && <Dialog title="Edit message" close={() => setEditing(false)}><form onSubmit={e => { e.preventDefault(); void branch(message, 'edit', text); }}><textarea autoFocus aria-label="Edited message" value={text} maxLength={100000} onChange={e => { setText(e.target.value); if (!saveLocal(key, e.target.value)) setNotice('This revision is only kept in this window.'); }}/><p className="metadata">The original response stays in its conversation. Your revision opens a new branch.</p><div className="dialog-footer"><button type="button" disabled={busy} onClick={() => setEditing(false)}>Keep for later</button><button className="primary" disabled={busy || !text.trim()}>{busy ? 'Opening revision…' : 'Save & resend'}</button></div>{notice && <p className="field-error" role="alert">{notice}</p>}</form></Dialog>}
  </div>;
}
