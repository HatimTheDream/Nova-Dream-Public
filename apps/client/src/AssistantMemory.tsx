import { LoadingRing } from './ModuleLoading';
import { useEffect, useRef, useState } from 'react';
import { calendarWindowIdentity } from './calendar-window';
import { canonical } from '../../../packages/domain/contracts';
import type { Snapshot } from '../../../packages/domain/contracts';
import type { MemoryChange, MemoryEntry, MemorySource, MemoryState } from '../../../packages/domain/memory';
import type { BrowseTarget } from '../../../packages/domain/search';
import { ApiError, readLocal, request, saveLocal } from './api';
import { Dialog } from './ui';

export type MemorySeed = { text: string; projectId: string | null; source: MemorySource };
type EditorProps = { snapshot: Snapshot; entry?: MemoryEntry; seed?: MemorySeed; refresh: () => Promise<void>; close: () => void };
type Kept = { id: string; text: string; projectId: string | null; expectedRevision: number; pending?: MemoryChange };

export function MemoryEditor(props: EditorProps) {
  const [owner, setOwner] = useState<{ id: string; previous?: string }>();
  useEffect(() => { let live = true; void calendarWindowIdentity().then(value => { if (live) setOwner(value); }); return () => { live = false; }; }, []);
  return owner ? <MemoryWriting key={owner.id} {...props} owner={owner}/> : <Dialog title="Save to memory" close={props.close}><LoadingRing label="Opening your saved writing…"/></Dialog>;
}

function MemoryWriting({ snapshot, entry, seed, refresh, close, owner }: EditorProps & { owner: { id: string; previous?: string } }) {
  const baseKey = `e3:memory-edit:${snapshot.epoch}:${snapshot.deviceId}:${entry?.id ?? (seed ? `${seed.source.nativeId}:${seed.source.role}:${seed.source.messageId}:${seed.source.messageHash}` : 'new')}`;
  const key = `${baseKey}:${owner.id}`;
  const initial = (): Kept => ({ id: entry?.id ?? crypto.randomUUID(), text: entry?.text ?? seed?.text ?? '', projectId: entry ? entry.projectId : seed?.projectId ?? null, expectedRevision: entry?.revision ?? 0 });
  const [kept, setKept] = useState<Kept>(() => {
    const local = readLocal<Kept>(key); if (local) return local;
    const copied = owner.previous && !readLocal<boolean>(`${key}:adopted`) ? readLocal<Kept>(`${baseKey}:${owner.previous}`) : undefined;
    if (owner.previous) saveLocal(`${key}:adopted`, true);
    if (!copied) return initial();
    const value = !entry && !copied.pending ? { ...copied, id: crypto.randomUUID() } : copied;
    saveLocal(key, value); return value;
  });
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmRemove, setConfirmRemove] = useState(false);
  const change = (value: Kept) => { setKept(value); if (!saveLocal(key, value)) setError('This unfinished memory is only kept in this window.'); };
  const submit = async (action: 'save' | 'remove') => {
    if (busy) return;
    const common = { requestId: crypto.randomUUID(), epoch: snapshot.epoch, id: kept.id, expectedRevision: kept.expectedRevision };
    const command: MemoryChange = kept.pending ?? (action === 'remove' ? { ...common, action } : { ...common, action, text: kept.text, projectId: kept.projectId, ...(!entry && seed ? { source: seed.source } : {}) });
    const pending = { ...kept, pending: command };
    if (!saveLocal(key, pending)) { setError('This change could not be kept safely. Your writing remains in this window. Try saving again.'); return; }
    setKept(pending); setBusy(true); setError('');
    try { await request('assistant/memory', command); if (canonical(readLocal(key)) === canonical(pending)) localStorage.removeItem(key); await refresh(); if (live.current) close(); }
    catch (reason) {
      if (reason instanceof ApiError && (reason.status ?? 0) >= 400 && (reason.status ?? 0) < 500 && ![408, 429].includes(reason.status ?? 0)) change({ ...kept, pending: undefined });
      setError(reason instanceof Error ? reason.message : 'The memory change was not confirmed. Retry the same change to check it safely.');
      await refresh();
    } finally { setBusy(false); }
  };
  return <Dialog title={entry ? 'Edit memory' : 'Save to memory'} close={close}><form onSubmit={event => { event.preventDefault(); void submit('save'); }}>
    <p className="metadata">Keep a fact, preference or constraint for future chats. Only notes you choose to save are added here.</p>
    <label>Memory<textarea autoFocus rows={5} value={kept.text} disabled={busy || !!kept.pending} onChange={event => change({ ...kept, text: event.target.value })}/></label>
    <p className={kept.text.length > 4000 ? 'field-error' : 'metadata'}>{kept.text.length.toLocaleString()} / 4,000 characters</p>
    <label>Use in<select value={kept.projectId ?? ''} disabled={busy || !!kept.pending} onChange={event => change({ ...kept, projectId: event.target.value || null })}><option value="">All chats</option>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.value.name}</option>)}</select></label>
    {(entry?.source || seed?.source) && <p className="metadata">The original message stays linked as the source. Editing this note leaves that message intact.</p>}
    <p className="metadata">Changes apply to newly sent messages and new voice calls. Earlier messages, already queued inputs, active calls and backup copies keep the context they received.</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    {kept.pending && <p className="metadata" role="status">A change is awaiting confirmation. Retry checks the same request.</p>}
    {entry && !kept.pending && entry.revision !== kept.expectedRevision && <button type="button" disabled={busy} onClick={() => change(initial())}>Load current saved memory</button>}
    {confirmRemove && !kept.pending && <div className="notice warning"><span>Remove this note from future memory?</span><button type="button" disabled={busy} onClick={() => void submit('remove')}>Remove memory</button><button type="button" onClick={() => setConfirmRemove(false)}>Keep memory</button></div>}
    <div className="dialog-footer">{entry && !confirmRemove && !kept.pending && <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</button>}<button type="button" disabled={busy} onClick={close}>Keep for later</button><button className="primary" disabled={busy || !kept.pending && (!kept.text.trim() || kept.text.length > 4000)}>{busy ? 'Saving…' : kept.pending ? 'Retry saved change' : 'Save memory'}</button></div>
  </form></Dialog>;
}

export function MemoryPanel({ memory, snapshot, refresh, openSource }: { memory?: MemoryState; snapshot: Snapshot; refresh: () => Promise<void>; openSource: (target: BrowseTarget) => void }) {
  const [editor, setEditor] = useState<MemoryEntry | 'new' | null>(null), [search, setSearch] = useState('');
  const entries = [...(memory?.entries ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(entry => entry.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="assistant-memory" aria-label="Saved memories"><div className="section-heading"><h3>Memory</h3><button disabled={!memory} onClick={() => setEditor('new')}>Add memory</button></div>
    <p className="metadata">Facts and preferences you choose to keep for future conversations.</p>
    {!memory ? <p className="metadata" role="status">Checking saved memories…</p> : <>
      {!!memory.entries.length && <label>Find a memory<input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>}
      {entries.map(entry => <article className="inspector-output" key={entry.id}><p className="preserve-lines">{entry.text}</p><small>{entry.projectId ? snapshot.projects.find(project => project.id === entry.projectId)?.value.name ?? 'Project unavailable' : 'All chats'}</small><div className="button-row"><button onClick={() => setEditor(entry)}>Edit memory</button>{entry.source && <button onClick={() => openSource({ epoch: snapshot.epoch, role: entry.source!.role, conversationId: entry.source!.conversationId, nativeId: entry.source!.nativeId, messageId: entry.source!.messageId, messageHash: entry.source!.messageHash })}>View source</button>}</div></article>)}
      {!entries.length && <p className="metadata">{search ? 'No memories match this search.' : 'No saved memories yet.'}</p>}
    </>}
    {editor && <MemoryEditor key={editor === 'new' ? 'new' : editor.id} snapshot={snapshot} entry={editor === 'new' ? undefined : memory?.entries.find(entry => entry.id === editor.id) ?? editor} refresh={refresh} close={() => setEditor(null)}/>}
  </section>;
}
