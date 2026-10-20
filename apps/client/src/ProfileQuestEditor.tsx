import { ProjectOptions } from './ProjectOptions';
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { type PersonalQuest } from '../../../packages/domain/profile-progression';
import { request } from './api';
import { QuestEditor, questWriting } from './profile-quest-client';
import { registerRecordDraftNavigation } from './record-draft-navigation';
import { retainedWindowId } from './useWorkspace';
import { Plus, X } from './icons';

export const questJournalKey = (device: string, id: string) => `e3:profile-quest:${device}:${retainedWindowId}:${id}`;
export const questDraft = questWriting;
const browserStorage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
export function ProfileQuestEditor({ id, quest, snapshot, saved, discard }: { id: string; quest?: PersonalQuest; snapshot: Snapshot; saved: () => Promise<void>; discard: () => void }) {
  const key = questJournalKey(snapshot.deviceId, id), scope = `${snapshot.epoch}:${snapshot.deviceId}:${id}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [, redraw] = useState(0);
  const [editor] = useState(() => new QuestEditor(browserStorage, key, { id, epoch: snapshot.epoch, device: snapshot.deviceId }, {
    draft: quest ? questDraft(quest, snapshot) : { id, title: '', description: '', projectId: null, due: '', steps: [{ id: crypto.randomUUID(), taskId: null, title: '' }] },
    revision: quest?.revision ?? 0, epoch: snapshot.epoch, dirty: false,
  }, command => request<PersonalQuest>('profile/quests', command), () => redraw(value => value + 1), () => currentScope.current === scope));
  useEffect(() => {
    editor.active = true;
    const retain = () => editor.retain(), unregister = registerRecordDraftNavigation(retain);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!retain()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload); editor.retire(); };
  }, [editor]);
  useEffect(() => { editor.sync(quest, snapshot); }, [quest?.revision, snapshot.epoch, editor]);
  const journal = editor.journal, error = editor.error, busy = editor.busy, conflict = editor.conflict, changed = editor.changed(quest);
  const change = (draft: typeof journal.draft) => editor.change(draft);
  const submit = async () => {
    const result = await editor.save(quest);
    if (result && editor.active && currentScope.current === scope) {
      try { await saved(); } catch (reason) { if (editor.active && currentScope.current === scope) { editor.error = reason instanceof Error ? reason.message : 'The quest is saved. Refresh its current details when available.'; redraw(value => value + 1); } }
    }
  };
  const tasks = snapshot.tasks.filter(t => !journal.draft.steps.some(s => s.taskId === t.id)).sort((a, b) => a.value.title.localeCompare(b.value.title));
  return <form className="profile-quest-editor" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="metadata">Every step is a Task. New steps are created in Tasks when you save; linked Tasks keep their existing dates and progress.</p>
    <fieldset disabled={editor.slot.invalid || journal.epoch !== snapshot.epoch || busy || !!journal.pending || !!quest?.archived}>
      <label>Quest name<input autoFocus maxLength={160} value={journal.draft.title} onChange={e => change({ ...journal.draft, title: e.target.value })} placeholder="What do you want to accomplish?"/></label>
      <label>Why it matters<textarea rows={3} maxLength={4000} value={journal.draft.description} onChange={e => change({ ...journal.draft, description: e.target.value })}/></label>
      <div className="record-field-grid"><label>Project<select value={journal.draft.projectId ?? ''} onChange={e => change({ ...journal.draft, projectId: e.target.value || null })}><option value="">No Project</option><ProjectOptions snapshot={snapshot} selected={journal.draft.projectId}/></select></label><label>Target date · optional<input type="date" value={journal.draft.due} onChange={e => change({ ...journal.draft, due: e.target.value })}/></label></div>
      <h3>Steps</h3><ol className="quest-edit-steps">{journal.draft.steps.map((step, i) => <li key={step.id}>
        <span className="quest-step-number" aria-hidden="true">{i + 1}</span>
        <div>{step.taskId ? <><strong>{[...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].find(t => t.id === step.taskId)?.value.title ?? step.title}</strong><span className="metadata">Linked Task · edit its details in Tasks</span></> : <label>Step {i + 1}<input maxLength={300} value={step.title} placeholder="A clear next action" onChange={e => change({ ...journal.draft, steps: journal.draft.steps.map(s => s.id === step.id ? { ...s, title: e.target.value } : s) })}/></label>}</div>
        <button type="button" className="icon-button" aria-label={`Remove step ${i + 1}`} onClick={() => change({ ...journal.draft, steps: journal.draft.steps.filter(s => s.id !== step.id) })}><X size={16}/></button>
      </li>)}</ol>
      <div className="button-row"><button type="button" disabled={journal.draft.steps.length >= 30} onClick={() => change({ ...journal.draft, steps: [...journal.draft.steps, { id: crypto.randomUUID(), taskId: null, title: '' }] })}><Plus size={16}/>New Task step</button><label className="quest-link-select"><span className="sr-only">Link an existing Task</span><select aria-label="Link an existing Task" value="" disabled={journal.draft.steps.length >= 30} onChange={e => { const task = tasks.find(t => t.id === e.target.value); if (task) change({ ...journal.draft, steps: [...journal.draft.steps, { id: crypto.randomUUID(), taskId: task.id, title: task.value.title }] }); }}><option value="">Link an existing Task…</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.value.title}{t.value.status === 'done' ? ' · Completed' : ''}</option>)}</select></label></div>
      <p className="metadata">Removing a step or archiving a quest keeps its Tasks. The target date is for the quest; it does not reschedule linked Tasks.</p>
    </fieldset>
    {(changed || conflict) && !journal.pending && <div className="notice warning"><div><strong>Review your kept edits</strong><p>{quest ? `The saved quest is “${quest.title}”, version ${quest.revision}. Your writing is still in the editor.` : 'The workspace changed. Your writing is kept; review the current Tasks before saving.'}</p>{quest && <details><summary>Current saved quest</summary><p>{quest.description}</p><ol>{quest.steps.map(s => <li key={s.id}>{snapshot.tasks.find(t => t.id === s.taskId)?.value.title ?? 'Task in Trash or unavailable'}</li>)}</ol></details>}<button type="button" disabled={journal.epoch !== snapshot.epoch || editor.slot.invalid || !!quest?.archived || !quest && journal.revision > 0} onClick={() => editor.review(quest)}>Keep my edits for this version</button></div></div>}
    {editor.slot.invalid && editor.slot.original && <details><summary>Original kept quest writing</summary><pre>{editor.slot.original}</pre></details>}
    {error && <div className="field-error" role="alert"><p>{error}</p>{!editor.slot.invalid && <button type="button" disabled={busy} onClick={() => editor.retain()}>Retry Keeping Writing</button>}</div>}
    <div className="record-editor-footer"><span className="metadata">{journal.pending ? 'Save awaiting confirmation' : journal.dirty ? (editor.kept ? 'Edits kept in this browser' : 'Edits are still open in this window') : 'New steps earn XP when completed'}</span><div className="button-row"><button type="button" disabled={editor.slot.invalid || busy || !!journal.pending} onClick={() => { if (editor.discard()) discard(); }}>Discard edits</button><button className="primary" disabled={editor.slot.invalid || journal.epoch !== snapshot.epoch || busy || !journal.pending && (changed || conflict || !!quest?.archived)}>{busy ? 'Saving…' : journal.pending ? 'Check saved quest' : 'Save quest'}</button></div></div>
  </form>;
}
