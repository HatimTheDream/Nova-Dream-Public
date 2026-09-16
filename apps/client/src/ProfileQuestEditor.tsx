import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { questDraftSchema, type PersonalQuest, type QuestDraft } from '../../../packages/domain/profile-progression';
import { ApiError, readLocal, request, saveLocal } from './api';
import { retainedWindowId } from './useWorkspace';
import { Plus, X } from './icons';

export const questJournalKey = (device: string, id: string) => `e3:profile-quest:${device}:${retainedWindowId}:${id}`;
type Journal = { draft: QuestDraft; revision: number; epoch: string; pending?: Record<string, unknown>; dirty: boolean };
export function questDraft(quest: PersonalQuest, snapshot: Snapshot): QuestDraft {
  return { id: quest.id, title: quest.title, description: quest.description, projectId: quest.projectId, due: quest.due, steps: quest.steps.map(s => ({ ...s, title: [...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].find(t => t.id === s.taskId)?.value.title ?? 'Task unavailable' })) };
}
export function ProfileQuestEditor({ id, quest, snapshot, saved, discard }: { id: string; quest?: PersonalQuest; snapshot: Snapshot; saved: () => Promise<void>; discard: () => void }) {
  const key = questJournalKey(snapshot.deviceId, id);
  const [journal, setJournal] = useState<Journal>(() => {
    const kept = readLocal<Journal>(key);
    return kept && (kept.dirty || kept.pending) ? kept : { draft: quest ? questDraft(quest, snapshot) : { id, title: '', description: '', projectId: null, due: '', steps: [{ id: crypto.randomUUID(), taskId: null, title: '' }] }, revision: quest?.revision ?? 0, epoch: snapshot.epoch, dirty: false };
  });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), flight = useRef(false);
  const [conflict, setConflict] = useState(false);
  const changed = journal.epoch !== snapshot.epoch || journal.revision !== (quest?.revision ?? 0);
  const keep = (next: Journal) => { if (!saveLocal(key, next)) { setError('Browser storage is full. Free space before continuing; your current edits are still open.'); return false; } setJournal(next); return true; };
  useEffect(() => {
    if (!journal.dirty && !journal.pending && quest && quest.revision !== journal.revision) keep({ draft: questDraft(quest, snapshot), revision: quest.revision, epoch: snapshot.epoch, dirty: false });
  }, [quest?.revision]);
  const change = (draft: QuestDraft) => keep({ ...journal, draft, dirty: true });
  const submit = async () => {
    if (flight.current) return;
    if (!journal.pending && (changed || conflict)) { setError('Review the current quest before saving your kept edits.'); return; }
    if (!journal.pending) { const parsed = questDraftSchema.safeParse(journal.draft); if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(' ')); return; } }
    const pending = journal.pending ?? { action: 'save', quest: journal.draft, expectedRevision: journal.revision, epoch: journal.epoch, requestId: crypto.randomUUID() };
    if (!keep({ ...journal, pending })) return;
    flight.current = true; setBusy(true); setError('');
    let result: PersonalQuest | undefined;
    try {
      result = await request<PersonalQuest>('profile/quests', pending);
      if (!keep({ draft: questDraft(result, snapshot), revision: result.revision, epoch: snapshot.epoch, dirty: false })) { setError('Saved on the host. Free browser storage, then check the saved quest to reconcile this window.'); return; }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The save is unconfirmed. Check the original request.');
      if (e instanceof ApiError && e.status && e.status < 500) {
        keep({ ...journal, pending: undefined });
        if (e.status === 409) setConflict(true);
      }
    } finally { flight.current = false; setBusy(false); }
    if (result) await saved();
  };
  const tasks = snapshot.tasks.filter(t => !journal.draft.steps.some(s => s.taskId === t.id)).sort((a, b) => a.value.title.localeCompare(b.value.title));
  return <form className="profile-quest-editor" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <p className="metadata">Every step is a Task. New steps are created in Tasks when you save; linked Tasks keep their existing dates and progress.</p>
    <fieldset disabled={busy || !!journal.pending || !!quest?.archived}>
      <label>Quest name<input autoFocus maxLength={160} value={journal.draft.title} onChange={e => change({ ...journal.draft, title: e.target.value })} placeholder="What do you want to accomplish?"/></label>
      <label>Why it matters<textarea rows={3} maxLength={4000} value={journal.draft.description} onChange={e => change({ ...journal.draft, description: e.target.value })}/></label>
      <div className="record-field-grid"><label>Project<select value={journal.draft.projectId ?? ''} onChange={e => change({ ...journal.draft, projectId: e.target.value || null })}><option value="">No Project</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label><label>Target date · optional<input type="date" value={journal.draft.due} onChange={e => change({ ...journal.draft, due: e.target.value })}/></label></div>
      <h3>Steps</h3><ol className="quest-edit-steps">{journal.draft.steps.map((step, i) => <li key={step.id}>
        <span className="quest-step-number" aria-hidden="true">{i + 1}</span>
        <div>{step.taskId ? <><strong>{[...snapshot.tasks, ...(snapshot.trashedTasks ?? [])].find(t => t.id === step.taskId)?.value.title ?? step.title}</strong><span className="metadata">Linked Task · edit its details in Tasks</span></> : <label>Step {i + 1}<input maxLength={300} value={step.title} placeholder="A clear next action" onChange={e => change({ ...journal.draft, steps: journal.draft.steps.map(s => s.id === step.id ? { ...s, title: e.target.value } : s) })}/></label>}</div>
        <button type="button" className="icon-button" aria-label={`Remove step ${i + 1}`} onClick={() => change({ ...journal.draft, steps: journal.draft.steps.filter(s => s.id !== step.id) })}><X size={16}/></button>
      </li>)}</ol>
      <div className="button-row"><button type="button" disabled={journal.draft.steps.length >= 30} onClick={() => change({ ...journal.draft, steps: [...journal.draft.steps, { id: crypto.randomUUID(), taskId: null, title: '' }] })}><Plus size={16}/>New Task step</button><label className="quest-link-select"><span className="sr-only">Link an existing Task</span><select aria-label="Link an existing Task" value="" disabled={journal.draft.steps.length >= 30} onChange={e => { const task = tasks.find(t => t.id === e.target.value); if (task) change({ ...journal.draft, steps: [...journal.draft.steps, { id: crypto.randomUUID(), taskId: task.id, title: task.value.title }] }); }}><option value="">Link an existing Task…</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.value.title}{t.value.status === 'done' ? ' · Completed' : ''}</option>)}</select></label></div>
      <p className="metadata">Removing a step or archiving a quest keeps its Tasks. The target date is for the quest; it does not reschedule linked Tasks.</p>
    </fieldset>
    {(changed || conflict) && !journal.pending && <div className="notice warning"><div><strong>Review your kept edits</strong><p>{quest ? `The saved quest is “${quest.title}”, version ${quest.revision}. Your writing is still in the editor.` : 'The workspace changed. Your writing is kept; review the current Tasks before saving.'}</p>{quest && <details><summary>Current saved quest</summary><p>{quest.description}</p><ol>{quest.steps.map(s => <li key={s.id}>{snapshot.tasks.find(t => t.id === s.taskId)?.value.title ?? 'Task in Trash or unavailable'}</li>)}</ol></details>}<button type="button" onClick={() => { if (keep({ ...journal, epoch: snapshot.epoch, revision: quest?.revision ?? 0 })) { setConflict(false); setError(''); } }}>Keep my edits for this version</button></div></div>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="record-editor-footer"><span className="metadata">{journal.pending ? 'Save awaiting confirmation' : journal.dirty ? 'Edits kept in this browser' : 'New steps earn XP when completed'}</span><div className="button-row"><button type="button" disabled={busy || !!journal.pending} onClick={() => { if (saveLocal(key, null)) discard(); else setError('Free browser storage before discarding this draft.'); }}>Discard edits</button><button className="primary" disabled={busy || !journal.pending && (changed || conflict || !!quest?.archived)}>{busy ? 'Saving…' : journal.pending ? 'Check saved quest' : 'Save quest'}</button></div></div>
  </form>;
}
