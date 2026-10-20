import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { HomeIdeaPreferences, HomeReference, HomeResource } from '../../../packages/domain/home-library';
import { homeClockTime, homeIdeaScope, homeQuote, exactHomeReference } from '../../../packages/domain/home-library-view';
import { activeProjects } from '../../../packages/domain/project-organization';
import { Dialog, Empty } from './ui';
import { Filter, MoreHorizontal, Pin, Sparkles } from './icons';
import { acknowledgeHomeCapture, captureHomeContext, type HomeLibraryController, type HomeSourceActions } from './HomeLibrary';
import { saveLocal } from './api';
import { HomeSourcePicker } from './HomeSourcePicker';
import { ComposerMenu } from './ComposerMenu';
import { retainedWindowId } from './useWorkspace';
import { registerHomeDraftNavigation } from './home-draft-navigation';
import { homeIdeas as ideas, ideaCategories, emptySourcePickerView, ideaScopeKey, readIdeaScope, retainIdeaScope, readIdeasView, savedAssistantDrafts, type IdeaScope, type IdeasView, type IdeasViewState, type KeptIdeaScope } from './home-ideas-state';
import './home-ideas.css';

type Choices = { saved: string[]; hidden: string[] };
type ScopeEditor = { ideaId: string; kept: KeptIdeaScope; value: IdeaScope; dirty: boolean };
type Props = HomeSourceActions & { snapshot: Snapshot; controller: HomeLibraryController; openDraft?: (id: string) => void };
const ideaViews: IdeasView[] = ['explore', 'saved', 'drafts'];
// Resolve browser storage inside the readers' guarded calls, including browsers
// that throw while obtaining localStorage itself.
const scopeStorage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
export function HomeIdeas({ snapshot, controller, onAssistantHandoff, openDraft }: Props) {
 const owner = useRef({ epoch: snapshot.epoch, deviceId: snapshot.deviceId });
 const viewKey = `e3:home-ideas-view:${owner.current.deviceId}:${owner.current.epoch}:${retainedWindowId}`;
 const [initial] = useState(() => readIdeasView(scopeStorage, viewKey));
 const [view, setView] = useState(initial.value);
 const currentView = useRef(view);currentView.current = view;
 const readScope = (id: string) => readIdeaScope(scopeStorage, ideaScopeKey(owner.current.deviceId, owner.current.epoch, id), id);
 const [editor, setEditor] = useState<ScopeEditor | undefined>(() => initial.value.selected ? (() => { const kept = readScope(initial.value.selected!);return { ideaId: initial.value.selected!, kept, value: kept.value, dirty: false }; })() : undefined);
 const currentEditor = useRef(editor), active = useRef(false), flight = useRef(false), sequence = useRef(0), previewSequence = useRef(0);
 const tabs = useRef(new Map<IdeasView, HTMLButtonElement>());
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [options, setOptions] = useState(false), [preview, setPreview] = useState<HomeResource>(), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState('');
 const latest = useRef({ snapshot, controller, onAssistantHandoff, openDraft });latest.current = { snapshot, controller, onAssistantHandoff, openDraft };
 const sameOwner = () => active.current && owner.current.epoch === latest.current.snapshot.epoch && owner.current.deviceId === latest.current.snapshot.deviceId;
 const publishEditor = (next: ScopeEditor | undefined) => { currentEditor.current = next;setEditor(next); };
 const retain = () => {
  const current = currentEditor.current;
  if (!current || !current.dirty) return true;
  try { const kept = retainIdeaScope(scopeStorage, current.kept, current.value, current.ideaId);publishEditor({ ...current, kept, dirty: false });setError('');return true; }
  catch (reason) { setError(reason instanceof Error ? reason.message : 'Your Idea writing could not be kept. Keep this window open.');return false; }
 };
 const retention = useRef(retain);retention.current = retain;
 useEffect(() => { active.current = true;const unregister = registerHomeDraftNavigation(() => retention.current());return () => { active.current = false;sequence.current++;previewSequence.current++;unregister(); }; }, []);
 const updateView = (patch: Partial<IdeasViewState>) => {
  if (!sameOwner()) return false;
  const next = { ...currentView.current, ...patch };
  if (!initial.invalid && !saveLocal(viewKey, next)) { setError('The current Idea view could not be kept. Your scope writing remains separate and unchanged.');return false; }
  currentView.current = next;setView(next);return true;
 };
 const update = (patch: Partial<IdeaScope>) => {
  const current = currentEditor.current;
  if (!current || current.kept.invalid || !sameOwner() || flight.current) return;
  sequence.current++;publishEditor({ ...current, value: { ...current.value, ...patch }, dirty: true });retain();
 };
 const open = (id: string) => {
  if (!sameOwner() || flight.current || !retain()) return;
  const kept = readScope(id);if (!updateView({ selected: id })) return;
  sequence.current++;publishEditor({ ideaId: id, kept, value: kept.value, dirty: false });setError('');setOptions(false);
 };
 const close = () => { if (!flight.current && retain() && updateView({ selected: undefined })) { sequence.current++;publishEditor(undefined);setOptions(false); } };
 const idea = ideas.find(i => i.id === editor?.ideaId), scopeValue = editor?.value;
 const choices: Choices & { revision: number } = controller.state?.ideaPreferences ?? { revision: 0, saved: [], hidden: [] };
 const preferencesBlocked = controller.busy || !!controller.pending || !!controller.journalError || !controller.state || controller.state.epoch !== snapshot.epoch;
 const keep = (value: Choices) => {
  const current = latest.current.controller;
  if (!sameOwner() || preferencesBlocked || current.busy || current.pending || current.journalError || current.state?.epoch !== snapshot.epoch || current.state.ideaPreferences.revision !== choices.revision) return;
  void current.run({ requestId: crypto.randomUUID(), epoch: snapshot.epoch, type: 'preferences-save', expectedRevision: choices.revision, value: { saved: value.saved as HomeIdeaPreferences['saved'], hidden: value.hidden as HomeIdeaPreferences['hidden'] } });
 };
 const saved = savedAssistantDrafts(snapshot.drafts);
 const scopes = ideas.map(i => ({ idea: i, kept: readScope(i.id) })).filter(row => row.kept.raw !== null && row.kept.raw !== 'null' || row.kept.invalid);
 const visibleIdeas = ideas.filter(i => !choices.hidden.includes(i.id) && (view.view !== 'saved' || choices.saved.includes(i.id)) && (view.category === 'All Categories' || i.category === view.category));
 const counts = { explore: ideas.filter(i => !choices.hidden.includes(i.id)).length, saved: ideas.filter(i => !choices.hidden.includes(i.id) && choices.saved.includes(i.id)).length, drafts: scopes.length + saved.length };
 const projects = activeProjects(snapshot);
 const currentTasks = snapshot.tasks.filter(t => t.value.status === 'open' && !t.value.trashed && (!scopeValue?.project || t.value.projectId === scopeValue.project));
 const currentSources = controller.state?.epoch === snapshot.epoch ? controller.state.resources.filter(r => r.reference.kind !== 'task' && r.reference.kind !== 'project') : [];
 const inspect = async (resource: HomeResource) => {
  if (!sameOwner() || flight.current) return;
  const ticket = ++previewSequence.current;setPreview(resource);setPreviewError('');setPreviewBusy(true);
  try {
   const capture = await captureHomeContext(snapshot, [resource.reference], 'idea-preview:' + resource.reference.kind + ':' + resource.reference.id);
   if (sameOwner() && ticket === previewSequence.current) {
    if (capture.epoch !== snapshot.epoch || capture.sources.length !== 1 || !exactHomeReference(capture.sources[0].reference, resource.reference)) throw Error('The returned preview did not match the exact selected source.');
    setPreview(capture.sources[0]);acknowledgeHomeCapture(snapshot, 'idea-preview:' + resource.reference.kind + ':' + resource.reference.id);
   }
  } catch (reason) { if (sameOwner() && ticket === previewSequence.current) setPreviewError(reason instanceof Error ? reason.message : 'The exact source could not be read.'); }
  finally { if (sameOwner() && ticket === previewSequence.current) setPreviewBusy(false); }
 };
 const start = async () => {
  if (!idea || !editor || !onAssistantHandoff || !sameOwner() || flight.current || editor.kept.invalid || !retain()) return;
  const value = currentEditor.current!.value;
  const { outputs, project, tasks, sources, instructions, from, to } = value;
  if (!outputs.length) { setError('Choose at least one requested output.');return; }
  if (idea.needsTasks && (!project || !tasks.length || !from || !to || !homeClockTime(from) || !homeClockTime(to) || from >= to)) { setError('Choose a Project, at least one open Task and valid planning hours.');return; }
  if (idea.needsSources && !sources.length) { setError('Choose at least one current Library source.');return; }
  let scope: ReturnType<typeof homeIdeaScope>;
  try { scope = homeIdeaScope(snapshot, project, tasks, idea.mode); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Review the current scope.');return; }
  const selectedProject = scope.project, refs: HomeReference[] = [...sources, ...scope.tasks.map(t => ({ kind: 'task' as const, id: t.id, revision: t.revision })), ...(selectedProject ? [{ kind: 'project' as const, id: selectedProject.id, revision: selectedProject.revision }] : [])];
  const ticket = ++sequence.current;flight.current = true;setBusy(true);setError('');
  try {
   const capture = await captureHomeContext(snapshot, refs, 'idea:' + idea.id);
   if (!sameOwner() || ticket !== sequence.current) throw Error('The original context is kept. Return to this Idea in the original workspace to review it.');
   if (capture.epoch !== snapshot.epoch || capture.sources.length !== refs.length || refs.some((ref, index) => !exactHomeReference(ref, capture.sources[index].reference))) throw Error('The captured context did not match the reviewed source versions.');
   const requested = idea.outputs.filter(o => outputs.includes(o.id));
   const text = [`${idea.title}\n\n${idea.explanation}`, `Requested outputs:\n${requested.map(o => `- ${o.title}: ${o.detail}`).join('\n')}`, idea.needsTasks ? `Planning hours: ${from}–${to}, timezone ${snapshot.layout.value.timezone}. Treat these as proposal boundaries. Current calendar coverage has not been supplied here: ask for commitments or use supported current calendar tools before claiming that times are conflict-free. Do not change Tasks, mark them completed, or schedule automatically from this request.` : 'Prepare the requested work for review. Do not modify the original sources.', instructions.trim() ? `My directions:\n${instructions.trim()}` : '', `Captured Library context ${capture.id}:\n${homeQuote(capture)}`].filter(Boolean).join('\n\n');
   if (text.length > 100000) throw Error('The selected context is too large. Choose fewer sources; nothing was shortened.');
   await latest.current.onAssistantHandoff!({ title: idea.title, text, space: scope.space, workMode: scope.workMode, projectId: scope.projectId, sourceCaptureId: capture.id, sourceRefs: refs, ideaId: idea.id, selectedTaskIds: tasks, outputs });
   acknowledgeHomeCapture(snapshot, 'idea:' + idea.id);
   if (sameOwner() && updateView({ selected: undefined })) publishEditor(undefined);
  } catch (reason) { if (sameOwner()) setError(reason instanceof Error ? reason.message : 'The existing workflow could not open.'); }
  finally { flight.current = false;if (active.current) setBusy(false); }
 };
 const unavailableOwner = owner.current.epoch !== snapshot.epoch || owner.current.deviceId !== snapshot.deviceId;
 const disabled = busy || !!editor?.kept.invalid || unavailableOwner;
 return <section className="home-ideas home-ideas-compact" aria-label="Ideas">
  {unavailableOwner && <p role="alert">The workspace changed. This original Idea writing remains in its own workspace. Keep it before leaving, then reopen Ideas.</p>}
  {(controller.error || controller.journalError) && <p role="alert">{controller.error || controller.journalError}</p>}
  {controller.pending && <button disabled={controller.busy || unavailableOwner} onClick={() => { const current = latest.current.controller;if (sameOwner() && !current.busy && current.pending?.epoch === snapshot.epoch) void current.run(current.pending); }}>Check Original Library Save</button>}
  <header className="home-ideas-viewhead"><h1 className="sr-only">{view.view === 'explore' ? 'Explore' : view.view === 'saved' ? 'Saved' : 'Drafts'}</h1><nav role="tablist" aria-label="Idea Views" className="home-ideas-tabs" onKeyDown={event => { const index = ideaViews.indexOf(view.view), next = event.key === 'Home' ? ideaViews[0] : event.key === 'End' ? ideaViews.at(-1) : event.key === 'ArrowRight' ? ideaViews[(index + 1) % ideaViews.length] : event.key === 'ArrowLeft' ? ideaViews[(index + ideaViews.length - 1) % ideaViews.length] : undefined;if (next) { event.preventDefault();if (retain() && updateView({ view: next })) tabs.current.get(next)?.focus(); } }}>{ideaViews.map(id => <button key={id} id={`idea-tab-${id}`} role="tab" aria-selected={view.view === id} aria-controls="idea-view-panel" tabIndex={view.view === id ? 0 : -1} ref={node => { if (node) tabs.current.set(id, node);else tabs.current.delete(id); }} onClick={() => { if (retain()) updateView({ view: id }); }}>{id[0].toUpperCase() + id.slice(1)}<span>{counts[id]}</span></button>)}</nav>
   {view.view !== 'drafts' && <ComposerMenu label="Idea Categories" icon={<Filter size={16}/>} text={view.category} className="compact-composer-menu" placement="below" kind="menu">{closeMenu => <div className="home-idea-category-options">{ideaCategories.map(category => <button className="compact-action compact-utility" role="menuitemradio" aria-checked={view.category === category} key={category} onClick={() => { updateView({ category });closeMenu(); }}>{category}</button>)}</div>}</ComposerMenu>}
  </header>
  {initial.invalid && <p role="status">The earlier Idea view could not be read. Its original browser record is preserved; scope writing is separate.</p>}
  {error && !idea && <p role="alert">{error}</p>}
  <div id="idea-view-panel" role="tabpanel" aria-labelledby={`idea-tab-${view.view}`}>
  {view.view !== 'drafts' ? <><div className="home-ideas-gallery">{visibleIdeas.map(i => <article className="home-idea-card" key={i.id}><span className="home-idea-symbol" aria-hidden="true">{i.symbol}</span><p className="metadata">{i.category}</p><h2>{i.title}</h2><p>{i.summary}</p><div className="compact-actions"><button className="compact-action" disabled={unavailableOwner} onClick={() => open(i.id)}>Preview</button><button className="compact-action compact-utility" disabled={preferencesBlocked || unavailableOwner} aria-pressed={choices.saved.includes(i.id)} aria-label={`${choices.saved.includes(i.id) ? 'Unsave' : 'Save'} ${i.title}`} onClick={() => keep({ ...choices, saved: choices.saved.includes(i.id) ? choices.saved.filter(id => id !== i.id) : [...choices.saved, i.id] })}><Pin size={15}/>{choices.saved.includes(i.id) ? 'Saved' : 'Save'}</button></div></article>)}</div>{!visibleIdeas.length && <Empty title={view.view === 'saved' ? 'No Saved Ideas In This View' : 'No Ideas In This Category'}>Choose another category or save a starter from Explore.</Empty>}{choices.hidden.length > 0 && <button className="compact-action" disabled={preferencesBlocked} onClick={() => keep({ ...choices, hidden: [] })}>Restore Hidden Ideas</button>}</> : <div className="home-ideas-drafts">
   <section aria-label="Unfinished Idea Scopes"><h2>On This Device <small>{scopes.length}</small></h2><p className="metadata">Unfinished Idea context and directions. Opening a scope does not capture sources or send a message.</p>{scopes.map(row => <article className="home-idea-draft" key={row.idea.id}><div><h3>{row.idea.title}</h3><p>{row.kept.invalid ? 'Original Scope Needs Review' : `${row.kept.value.tasks.length + row.kept.value.sources.length} Selected Sources And Tasks`}</p></div><button className="compact-action" onClick={() => open(row.idea.id)}>Continue Scope</button></article>)}{!scopes.length && <p>No unfinished Idea scopes are kept on this device.</p>}</section>
   <section aria-label="Saved Assistant Drafts"><h2>Saved Assistant Drafts <small>{saved.length}</small></h2><p className="metadata">Saved Assistant writing from this workspace. Earlier drafts do not record which Idea created them.</p>{saved.map(d => <article className="home-idea-draft" key={d.id}><div><h3 className="preserve-case">{d.value.title || 'Untitled Draft'}</h3><p className="metadata">{d.value.space === 'work' ? 'Work' : 'Chat'} · Saved {new Date(d.updatedAt).toLocaleString()}</p></div><button className="compact-action" disabled={!openDraft || unavailableOwner} onClick={() => { if (retain() && sameOwner() && latest.current.snapshot.drafts.some(current => current.id === d.id && current.revision === d.revision)) latest.current.openDraft?.(d.id); }}>Open Saved Draft</button></article>)}{!saved.length && <p>No saved Assistant writing is available. Unsaved writing stays in its current Assistant editor.</p>}</section>
  </div>}
  </div>
  {idea && editor && scopeValue && <Dialog title={idea.title} close={close}><div className="home-idea-dialog"><p className="home-idea-description">{idea.explanation}</p>{editor.kept.invalid ? <><p role="alert">{editor.kept.problem}</p><pre className="home-source-text">{editor.kept.raw?.slice(0, 128000) ?? 'Browser storage could not be read.'}</pre></> : <>
   <section className="home-idea-included"><h3>What’s Included</h3>{idea.outputs.map(o => <label className="check-label" key={o.id}><input type="checkbox" checked={scopeValue.outputs.includes(o.id)} disabled={disabled} onChange={e => update({ outputs: e.target.checked ? [...scopeValue.outputs, o.id] : scopeValue.outputs.filter(id => id !== o.id) })}/><span><strong>{o.title}</strong><small>{o.detail}</small></span></label>)}</section>
   <div className="home-idea-scope"><h3>Scope</h3><label className="home-idea-project">Project<select value={scopeValue.project} disabled={disabled} onChange={e => update({ project: e.target.value, tasks: [] })}><option value="">{idea.needsTasks ? 'Choose A Project' : 'No Project'}</option>{scopeValue.project && !projects.some(p => p.id === scopeValue.project) && <option value={scopeValue.project}>Unavailable Project</option>}{projects.map(p => <option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label>
    {idea.needsTasks && <><div className="home-planning-hours"><label>From<input type="time" value={scopeValue.from} disabled={disabled} onChange={e => update({ from: e.target.value })}/></label><label>Until<input type="time" value={scopeValue.to} disabled={disabled} onChange={e => update({ to: e.target.value })}/></label></div><p className="metadata">{snapshot.layout.value.timezone} · Proposed Times Only</p><div className="home-source-picker">{currentTasks.map(t => <label className="check-label" key={t.id}><input type="checkbox" disabled={disabled || scopeValue.tasks.length + scopeValue.sources.length >= 18 && !scopeValue.tasks.includes(t.id)} checked={scopeValue.tasks.includes(t.id)} onChange={e => update({ tasks: e.target.checked ? [...scopeValue.tasks, t.id] : scopeValue.tasks.filter(id => id !== t.id) })}/><span><strong>{t.value.title}</strong><small>{t.value.due ? `Due ${t.value.due}` : 'No Deadline'}</small></span></label>)}{!currentTasks.length && <p>No open Tasks in this scope. Add Tasks in the Tasks module first.</p>}</div></>}
    <h4>Library Sources</h4>{controller.loading && !controller.state ? <p role="status">Loading Library Sources…</p> : controller.state?.epoch === snapshot.epoch ? <HomeSourcePicker compact collections={controller.state.collections} resources={currentSources} selected={scopeValue.sources} select={sources => update({ sources })} busy={disabled || previewBusy} selectionCount={scopeValue.tasks.length + scopeValue.sources.length} selectionLimit={18} view={scopeValue.picker ?? emptySourcePickerView} changeView={picker => update({ picker })} inspect={resource => void inspect(resource)}/> : <p className="metadata">Library sources could not load. Your kept selections and directions are unchanged.</p>}
    <label>Your Directions<textarea rows={3} maxLength={4000} disabled={disabled} placeholder="What should Nova focus on?" value={scopeValue.instructions} onChange={e => update({ instructions: e.target.value })}/></label>
   </div></>}
   {error && <p role="alert">{error}</p>}{editor.dirty && <button disabled={busy} onClick={retain}>Retry Keeping Writing</button>}
   <div className="home-idea-actions"><button className="compact-action compact-utility compact-icon" aria-label="Idea Options" aria-expanded={options} disabled={busy} onClick={() => setOptions(!options)}><MoreHorizontal size={20}/></button><button className="compact-action" disabled={busy} onClick={close}>Keep And Close</button><button className="primary compact-action" disabled={disabled || !scopeValue.outputs.length || !onAssistantHandoff} onClick={() => void start()}><Sparkles size={17}/>{busy ? 'Opening Draft…' : 'Open Assistant Draft'}</button></div>
   {options && <div className="home-idea-options"><button className="compact-action" disabled={preferencesBlocked} onClick={() => { keep({ ...choices, saved: choices.saved.includes(idea.id) ? choices.saved.filter(id => id !== idea.id) : [...choices.saved, idea.id] });setOptions(false); }}><Pin size={15}/>{choices.saved.includes(idea.id) ? 'Remove From Saved' : 'Save For Later'}</button><button className="compact-action" disabled={preferencesBlocked} onClick={() => { if (retain()) { keep({ ...choices, hidden: [...new Set([...choices.hidden, idea.id])] });close(); } }}>Not Interested</button></div>}
   <p className="metadata">Opens A Kept Assistant Draft For Review · Nothing Runs Until You Send</p>
  </div></Dialog>}
  {preview && <Dialog title={preview.title} close={() => { previewSequence.current++;setPreview(undefined);setPreviewBusy(false); }}><p className="metadata">{preview.subtitle}</p>{previewBusy ? <p role="status">Reading The Exact Saved Version…</p> : <pre className="home-source-text">{preview.text || (preview.url ? 'This saved source contains a link. Its web page has not been fetched.' : 'No captured text is available.')}</pre>}{preview.url && <p className="preserve-case">{preview.url}</p>}{previewError && <p role="alert">{previewError}</p>}<button className="compact-action" onClick={() => { previewSequence.current++;setPreview(undefined);setPreviewBusy(false); }}>Back To Idea</button></Dialog>}
 </section>;
}
