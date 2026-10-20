import { useEffect, useRef, useState } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import type { ProfileProgress } from '../../../packages/domain/profile-progression';
import { studioFocus, studioNextWork, studioStateSchema, type StudioState } from '../../../packages/domain/profile-studio';
import { StudioEditor } from './profile-studio-client';
import { request } from './api';
import { retainedWindowId } from './useWorkspace';
import { registerRecordDraftNavigation, mayLeaveRecordDrafts } from './record-draft-navigation';
import { Dialog, Empty } from './ui';

export function ProfileStudio({ snapshot, progress, focusedId, focus, openTask, reviewQuest, newQuest }: {
  snapshot: Snapshot; progress: ProfileProgress; focusedId: string | null; focus: (id: string) => boolean;
  openTask: (task: Entity<Task>) => void; reviewQuest: (id: string) => void; newQuest: () => void;
}) {
  const [state, setState] = useState<StudioState>(), [error, setError] = useState(''), [editing, setEditing] = useState(false);
  const alive = useRef(true), generation = useRef(0);
  const load = async () => {
    const own = ++generation.current;
    try { const next = studioStateSchema.parse(await request('profile/studio')); if (alive.current && own === generation.current && next.epoch === snapshot.epoch) { setState(next); setError(''); } }
    catch (problem) { if (alive.current && own === generation.current) setError(problem instanceof Error ? problem.message : 'Studio is unavailable. Your choices are kept.'); }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; generation.current++; }; }, [snapshot.epoch]);
  const selected = state ? studioFocus(progress.personalQuests, state, focusedId) : { featured: [], focused: null };
  const next = selected.focused ? studioNextWork(selected.focused, snapshot.tasks) : undefined;
  return <section className="profile-studio" aria-label="My Studio">
    <div className="section-heading"><div><h2>Make room for what matters.</h2><p className="metadata">Keep up to two quests here. Each step opens its original Task.</p></div><div className="button-row"><button onClick={() => { if (mayLeaveRecordDrafts()) newQuest(); }}>New Quest</button><button disabled={!state} onClick={() => { if (mayLeaveRecordDrafts()) { setEditing(true); void load(); } }}>Curate Studio</button></div></div>
    {error && <div className="notice warning" role="alert"><p>{error}</p><button onClick={() => void load()}>Retry Studio</button></div>}
    {!state && !error && <p role="status">Loading your Studio…</p>}
    {state && selected.featured.length === 0 && <Empty title="Choose a quest to make space for.">Curate Studio to feature your own quests, or create one with a few clear steps.</Empty>}
    {selected.featured.length > 0 && <div className="studio-quest-choices" aria-label="Featured quests">{selected.featured.map(quest => <button key={quest.id} aria-pressed={selected.focused?.id === quest.id} onClick={() => focus(quest.id)}><strong>{quest.title}</strong><span>{quest.progress} of {quest.steps.length} steps complete</span></button>)}</div>}
    {selected.focused && <article className="card studio-focus"><span className="eyebrow">{next?.kind === 'revisit' ? 'A finish worth keeping' : 'Your next step'}</span><h3>{next?.kind === 'task' ? next.task.value.title : selected.focused.title}</h3>{selected.focused.description && <p>{selected.focused.description}</p>}
      <div className="button-row">{next?.kind === 'task' ? <button className="primary" onClick={() => { if (mayLeaveRecordDrafts()) openTask(next.task); }}>Open Task</button> : <button className="primary" onClick={() => { if (mayLeaveRecordDrafts()) reviewQuest(selected.focused!.id); }}>{next?.kind === 'revisit' ? 'Revisit Quest' : 'Review Steps'}</button>}<button onClick={() => { if (mayLeaveRecordDrafts()) reviewQuest(selected.focused!.id); }}>View Quest</button></div>
      {next?.kind === 'review' && <p className="metadata">The remaining steps need review. A blocked, skipped or unavailable Task is kept in the quest.</p>}
      <div className="studio-progress"><progress value={selected.focused.progress} max={selected.focused.steps.length} aria-label={`${selected.focused.title} progress`}/><span className="metadata">{selected.focused.progress} of {selected.focused.steps.length} steps complete</span></div>
    </article>}
    {state && state.unavailable.length > 0 && <p className="metadata">{state.unavailable.length} saved {state.unavailable.length === 1 ? 'selection is' : 'selections are'} archived or unavailable. The original references are kept; review them in Curate Studio.</p>}
    {editing && state && <StudioCuration snapshot={snapshot} progress={progress} state={state} reload={load} close={() => setEditing(false)} saved={async () => { await load(); }}/>}
  </section>;
}

export function StudioCuration({ snapshot, progress, state, reload, close, saved }: { snapshot: Snapshot; progress: ProfileProgress; state: StudioState; reload: () => Promise<void>; close: () => void; saved: () => Promise<void> }) {
  const [, render] = useState(0);
  const [editor] = useState(() => new StudioEditor(localStorage, { epoch: snapshot.epoch, device: snapshot.deviceId, window: retainedWindowId }, state, input => request('profile/studio', input), () => render(value => value + 1)));
  useEffect(() => { editor.active = true; const unregister = registerRecordDraftNavigation(() => editor.retain()); return () => { unregister(); editor.retire(); }; }, [editor]);
  const journal = editor.journal, changed = journal.baseRevision !== state.curation.revision || editor.conflict;
  const choices = progress.personalQuests.filter(quest => !quest.archived), unavailable = journal.questIds.filter(id => !choices.some(quest => quest.id === id));
  const submit = async () => { const result = await editor.save(state); if (result && editor.active) await saved(); };
  return <Dialog title="Curate your Studio" close={() => { if (editor.retain()) close(); }}>
    <form className="studio-curation" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>Choose up to two quests. This changes your Studio selection across devices. Tasks and earned progress stay attached to their originals.</p>
      {state.unavailable.length > 0 && <p className="metadata">The saved selection includes {state.unavailable.length} archived or unavailable {state.unavailable.length === 1 ? 'quest' : 'quests'}. Saving the choices below replaces only that selection.</p>}
      <fieldset disabled={editor.busy || !!journal.pending || editor.slot.invalid}>
        {choices.map(quest => <label key={quest.id}><input type="checkbox" checked={journal.questIds.includes(quest.id)} disabled={!journal.questIds.includes(quest.id) && journal.questIds.length >= 2} onChange={event => editor.choose(event.target.checked ? [...journal.questIds, quest.id] : journal.questIds.filter(id => id !== quest.id))}/><span><strong>{quest.title}</strong><small>{quest.progress}/{quest.steps.length} steps complete</small></span></label>)}
        {!choices.length && <p>No personal quests are available yet. Close this review to create one.</p>}
        {unavailable.map(id => <label key={id}><input type="checkbox" checked onChange={() => editor.choose(journal.questIds.filter(value => value !== id))}/><span>Kept quest · unavailable<small>Remove this reference from your proposed selection.</small></span></label>)}
      </fieldset>
      {changed && !journal.pending && <div className="notice warning"><p>The saved Studio selection changed. Your proposed choices are still here.</p><p className="metadata">Saved selection: {state.curation.questIds.map(id => progress.personalQuests.find(quest => quest.id === id)?.title ?? 'Unavailable quest').join(', ') || 'No featured quests'}.</p><button type="button" onClick={() => editor.review(state)}>Keep My Choices for This Version</button></div>}
      {editor.slot.invalid && <details><summary>Original kept record</summary><pre>{editor.slot.original ?? 'Browser storage could not be read.'}</pre></details>}
      {editor.error && <p className="field-error" role="alert">{editor.error}</p>}
      <div className="record-editor-footer"><span className="metadata">{journal.pending ? 'Original save awaiting confirmation' : journal.dirty ? 'Your choices are kept in this window' : 'Studio selection saved'}</span><div className="button-row"><button type="button" disabled={editor.busy} onClick={() => void reload()}>Refresh Saved Selection</button><button className="primary" disabled={editor.busy || editor.slot.invalid || !journal.pending && (changed || !journal.dirty)}>{editor.busy ? 'Saving…' : journal.pending ? 'Check Original Save' : 'Save Selection'}</button></div></div>
    </form>
  </Dialog>;
}
