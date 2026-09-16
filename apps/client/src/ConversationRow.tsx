import { assistantSpace } from '../../../packages/domain/assistant-space';
import { useState } from 'react';
import type { Conversation, ConversationChanges } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { AssistantController } from './useAssistant';
import { SidebarRow } from './SidebarRow';
import { Archive, Folder, MessageSquare, Trash2 } from './icons';
import { ArrowLeft } from './icons';
import { formatSaved } from './ui';

export function ConversationRow({ conversation, controller, snapshot, selected, hasDraft, updatedAt, open, refreshWorkspace }: { conversation: Conversation; controller: AssistantController; snapshot: Snapshot; selected: boolean; hasDraft: boolean; updatedAt: string; open: () => void; refreshWorkspace: () => Promise<void> }) {
  const [view, setView] = useState<'actions' | 'rename' | 'project' | 'remove'>('actions');
  const [title, setTitle] = useState(conversation.title), [projectId, setProjectId] = useState(conversation.projectId ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = controller.operations.some(op => op.conversationId === conversation.id && !['completed', 'failed', 'cancelled'].includes(op.state));
  const removal = controller.removals?.find(item => item.conversationId === conversation.id && ['prepared', 'unknown'].includes(item.state));
  const blocked = !!removal || !conversation.nativeId || busy || active || !!conversation.pendingSettings || controller.connection.state !== 'ready';
  const localDeleteBlocked = !!removal || busy || active || !!conversation.pendingSettings || conversation.state === 'creating';
  const deleteBlocked = conversation.nativeId ? blocked : localDeleteBlocked;
  const save = async (changes: ConversationChanges, close: () => void) => {
    setBusy(true); setError('');
    try { await controller.edit(conversation, changes); close(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Change not confirmed.'); }
    finally { setBusy(false); }
  };
  const remove = async (close: () => void) => {
    setBusy(true); setError('');
    try { await controller.remove(conversation); await refreshWorkspace(); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Removal was not confirmed.'); }
    finally { setBusy(false); }
  };
  return <SidebarRow title={conversation.title} icon={<MessageSquare size={16}/>} pinned={conversation.pinned} unread={conversation.unread} selected={selected} secondary={<>{hasDraft ? 'Draft · ' : ''}{conversation.state === 'ready' ? formatSaved(updatedAt) : 'Needs status check'}</>} open={open} kind={view === 'actions' ? 'menu' : 'dialog'} onClose={() => { setView('actions'); setError(''); }}>
      {close => view === 'actions' ? <>
        {conversation.nativeId && <><button role="menuitem" disabled={blocked} onClick={() => void save({ pinned: !conversation.pinned }, close)}>{conversation.pinned ? 'Unpin' : 'Pin'}</button>
        <button role="menuitem" disabled={blocked} onClick={() => { setTitle(conversation.title); setView('rename'); }}>Rename</button>
        {assistantSpace(conversation) === 'chat' && <button role="menuitem" disabled={blocked} onClick={() => { setProjectId(conversation.projectId ?? ''); setView('project'); }}><Folder size={17}/>Move to Project</button>}
        <button role="menuitem" disabled={blocked} onClick={() => void save({ unread: !conversation.unread }, close)}>{conversation.unread ? 'Mark read' : 'Mark unread'}</button></>}
        {(conversation.nativeId || conversation.deleted) && <button role="menuitem" disabled={conversation.deleted ? deleteBlocked : blocked} onClick={() => void save(conversation.deleted ? { deleted: false } : { archived: !conversation.archived }, close)}><Archive size={17}/>{conversation.archived ? 'Restore' : 'Archive'}</button>}
        {conversation.deleted && <button role="menuitem" className="chat-delete-action" disabled={busy || active || !!conversation.pendingSettings} onClick={() => setView('remove')}><Trash2 size={17}/>{removal ? 'Check removal' : 'Remove permanently'}</button>}
        {!conversation.deleted && <button role="menuitem" className="chat-delete-action" disabled={deleteBlocked} onClick={() => void save({ deleted: true }, close)}><Trash2 size={17}/>Delete</button>}
        {(active || conversation.pendingSettings) && <p className="metadata">{active ? 'Finish the current reply to change this chat.' : 'Waiting for confirmation.'}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </> : view === 'remove' ? <div className="chat-action-form">
        <strong>Remove this chat permanently?</strong>
        <p>This removes the chat and its saved drafts from this workspace. You cannot restore it here.</p>
        <p className="metadata">Saved outputs, files and memories stay separate. Native recovery, provider and offline copies may remain.</p>
        <div className="button-row"><button disabled={busy} onClick={close}>Keep chat</button><button className="chat-delete-action" disabled={busy || active} onClick={() => void remove(close)}>{busy ? 'Checking…' : removal ? 'Check removal' : 'Remove permanently'}</button></div>
        {error && <p className="field-error" role="alert">{error}</p>}
      </div> : <form className="chat-action-form" onSubmit={event => { event.preventDefault(); void save(view === 'rename' ? { title: title.trim() } : { projectId: projectId || null }, close); }}>
        <button type="button" className="text-button" onClick={() => setView('actions')}><ArrowLeft size={17}/>Back</button>
        {view === 'rename' ? <label>Chat name<input autoFocus required maxLength={150} value={title} onChange={event => setTitle(event.target.value)}/></label> : <label>Project<select aria-label="Move chat to Project" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">No Project</option>{snapshot.projects.filter(project => assistantSpace(project.value) === assistantSpace(conversation)).map(project => <option key={project.id} value={project.id}>{project.value.name}</option>)}</select></label>}
        <button className="primary" disabled={blocked || view === 'rename' && !title.trim()}>{busy ? 'Saving…' : view === 'rename' ? 'Save name' : 'Move chat'}</button>
        {error && <p className="field-error" role="alert">{error}</p>}
      </form>}
  </SidebarRow>;
}
