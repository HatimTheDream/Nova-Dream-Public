import { useState } from 'react';
import { assistantSpace } from '../../../packages/domain/assistant-space';
import type { Conversation, ConversationChanges } from '../../../packages/domain/assistant';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { AssistantController } from './useAssistant';
import { Archive, Trash2 } from './icons';
import { Dialog } from './ui';
import { ProjectOptions } from './ProjectOptions';
import { conversationVisibilityBlocked, conversationWritePending } from './conversation-visibility';

export function ConversationSettings({ snapshot, controller, conversation, close }: { snapshot: Snapshot; controller: AssistantController; conversation: Conversation; close: () => void }) {
  const [title, setTitle] = useState(conversation.title), [projectId, setProjectId] = useState(conversation.projectId ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const settingsBlocked = busy || conversationWritePending(conversation);
  const visibilityBlocked = (hiding: boolean) => conversationVisibilityBlocked(conversation, controller.operations, controller.removals, busy, hiding);
  const save = (changes: ConversationChanges) => {
    setBusy(true); setError('');
    void controller.edit(conversation, changes).then(close).catch(reason => setError(reason instanceof Error ? reason.message : 'Change not confirmed.')).finally(() => setBusy(false));
  };
  return <Dialog title="Conversation options" close={close}><form onSubmit={event => { event.preventDefault(); if (!settingsBlocked) save({ title, projectId: projectId || null }); }}>
    <fieldset disabled={settingsBlocked}>
      <label>Name<input required value={title} maxLength={150} onChange={event => setTitle(event.target.value)}/></label>
      <label>Project<select disabled={assistantSpace(conversation) === 'work'} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">No Project</option><ProjectOptions snapshot={snapshot} selected={conversation.projectId} space={assistantSpace(conversation)}/></select></label>
      <div className="button-row"><button type="button" onClick={() => save({ pinned: !conversation.pinned })}>{conversation.pinned ? 'Unpin' : 'Pin'}</button><button type="button" onClick={() => save({ unread: !conversation.unread })}>{conversation.unread ? 'Mark read' : 'Mark unread'}</button></div>
    </fieldset>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-footer">
      <button type="button" disabled={visibilityBlocked(!conversation.deleted && !conversation.archived)} onClick={() => save(conversation.deleted ? { deleted: false } : { archived: !conversation.archived })}><Archive size={17}/>{conversation.deleted || conversation.archived ? 'Restore chat' : 'Archive'}</button>
      {!conversation.deleted && <button type="button" disabled={visibilityBlocked(true)} onClick={() => save({ deleted: true })}><Trash2 size={17}/>Move to Deleted</button>}
      <button className="primary" disabled={settingsBlocked}>{busy ? 'Saving…' : 'Save changes'}</button>
    </div>
  </form></Dialog>;
}
