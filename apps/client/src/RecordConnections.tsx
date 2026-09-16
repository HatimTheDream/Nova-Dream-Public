import type { MailContactSource } from '../../../packages/domain/mail-contact';
import type { Contact } from '../../../packages/domain/workspace-records';
import { ContentSource } from './ContentSource';
import { useEffect, useRef, useState } from 'react';
import type { Entity, Snapshot, Task } from '../../../packages/domain/contracts';
import { recordTitle, type Content, type RecordKind, type RecordValue, type RecordTaskCommand, type ContentOutputSource } from '../../../packages/domain/workspace-records';
import { ApiError, readLocal, request, saveLocal } from './api';
import { exportContent } from './record-files';
import { Dialog, Empty } from './ui';
import { retainedWindowId } from './useWorkspace';

export function RecordConnections({ compact = false, timeline = false, contactIds, kind, entity, snapshot, refresh, editTask, openSource, openEmail }: { compact?: boolean; timeline?: boolean; contactIds?: string[]; openEmail?: (source: MailContactSource) => Promise<void>; openSource?: (source: ContentOutputSource) => void; kind: RecordKind; entity: Entity<RecordValue>; snapshot: Snapshot; refresh: () => Promise<void>; editTask: (task: Entity<Task>) => void }) {
  const key = `e3:record-follow-up:${snapshot.deviceId}:${entity.id}:${retainedWindowId}`;
  const [pending, setPending] = useState<RecordTaskCommand | undefined>(() => readLocal(key));
  const [title, setTitle] = useState(() => pending?.title ?? readLocal<string>(key + ':draft') ?? `Follow up: ${recordTitle(entity.value)}`);
  const [adding, setAdding] = useState(() => !!pending); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [busy, setBusy] = useState(false); const flight = useRef(false);
  const [error, setError] = useState(''); const [rejected, setRejected] = useState(false);
  const [history, setHistory] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const linked = snapshot.tasks.filter(task => task.value.origin?.kind === kind && (contactIds ?? [entity.id]).includes(task.value.origin.id));
  const create = async () => {
    if (flight.current || !['contact', 'content', 'assignment'].includes(kind)) return;
    const command: RecordTaskCommand = pending ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, origin: { kind: kind as RecordTaskCommand['origin']['kind'], id: entity.id, revision: entity.revision }, title: title.trim() };
    if (!saveLocal(key, command)) { setError('Browser storage is full. Free storage before creating this Task.'); return; }
    setPending(command); flight.current = true; setBusy(true); setRejected(false); setError('');
    try {
      const task = await request<Entity<Task>>('records/follow-up', command);
      // Keep the original envelope until the acknowledgment can be durably recorded.
      if (saveLocal(key, null)) setPending(undefined);
      saveLocal(key + ':draft', null); await refresh(); if (alive.current) { setAdding(false); editTask(task); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Task has not been confirmed. Retry to reconcile the same request.');
      setRejected(reason instanceof ApiError && ['source_changed', 'record_missing', 'epoch_changed', 'validation'].includes(reason.code));
    } finally { flight.current = false; setBusy(false); }
  };
  return <section className="record-connections"><div className="section-heading">{timeline ? <button disabled={'archived' in entity.value && entity.value.archived} onClick={() => setAdding(true)}>Add follow-up</button> : <h3>{compact ? 'Follow-ups' : 'Saved work'}</h3>}<button onClick={() => setHistory(true)}>Version history</button></div>
    {!compact && kind === 'contact' && !!(entity.value as Contact).mailSources?.length && <section><h4>Source emails</h4><div className="record-linked-list">{(entity.value as Contact).mailSources!.map((source, index) => <button key={index} disabled={!openEmail} onClick={() => { setSourceError(''); void openEmail?.(source).catch(reason => setSourceError(reason instanceof Error ? reason.message : 'This source email could not be opened.')); }}><span>{source.subject || 'Email without a subject'}</span><small>{source.sender} · {source.provider === 'google' ? 'Google' : 'Microsoft'}</small></button>)}</div></section>}
    {sourceError && <p role="alert" className="field-error">{sourceError}</p>}
    {kind === 'content' && <><button onClick={() => exportContent(entity.value as Content, entity.revision)}>Export saved version {entity.revision}</button><ContentSource content={entity.value as Content} openSource={openSource}/></>}
    {['contact', 'content', 'assignment'].includes(kind) && <>{!compact && <h4>Linked Tasks</h4>}{!timeline && (linked.length ? <div className="record-linked-list">{linked.map(task => <button key={task.id} onClick={() => editTask(task)}><span>{task.value.title}</span><small>{task.value.status === 'done' ? 'Completed' : task.value.planned || task.value.due || 'Open'}</small></button>)}</div> : <p className="metadata">No follow-up Tasks yet.</p>)}
      {compact && !timeline && 'archived' in entity.value && (!entity.value.archived || pending) && !adding && <button onClick={() => setAdding(true)}>{pending ? 'Reconcile follow-up' : 'Add follow-up'}</button>}
      {(!compact || adding) && (!('archived' in entity.value) || !entity.value.archived || pending) && <form onSubmit={e => { e.preventDefault(); void create(); }}><label>Follow-up Task<input required maxLength={300} value={title} disabled={!!pending || busy} onChange={e => { setTitle(e.target.value); if (!saveLocal(key + ':draft', e.target.value)) setError('This draft is kept in this window only. Browser storage is full.'); }}/></label>{!compact && <p className="metadata">Links to saved version {pending?.origin.revision ?? entity.revision}. Unsaved edits stay in the editor.</p>}{error && <p role="alert" className="field-error">{error}</p>}<div className="button-row">{compact && <button type="button" disabled={busy} onClick={() => setAdding(false)}>{pending ? 'Close' : 'Cancel'}</button>}<button disabled={busy || !title.trim() || rejected}>{busy ? 'Creating…' : pending ? 'Reconcile Task' : compact ? 'Add' : 'Create linked Task'}</button>{rejected && <button type="button" onClick={() => { if (saveLocal(key, null)) { setPending(undefined); setError(''); setRejected(false); void refresh(); } }}>Review current source</button>}</div></form>}
    </>}
    {history && <RecordHistory kind={kind} entity={entity} close={() => setHistory(false)}/>}
  </section>;
}
export function RecordHistory({ kind, entity, close }: { kind: RecordKind; entity: Entity<RecordValue>; close: () => void }) {
  const [versions, setVersions] = useState<Entity<RecordValue>[]>([]); const [before, setBefore] = useState<number | null>();
  const [selected, setSelected] = useState<Entity<RecordValue>>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(true);
  const sequence = useRef(0);
  const load = async (cursor?: number) => {
    const attempt = ++sequence.current; setBusy(true); setError('');
    try { const result = await request<{ versions: Entity<RecordValue>[]; beforeRevision: number | null }>('records/history', { kind, id: entity.id, beforeRevision: cursor }); if (attempt !== sequence.current) return; setVersions(previous => cursor ? [...previous, ...result.versions] : result.versions); setBefore(result.beforeRevision); }
    catch (reason) { if (attempt === sequence.current) setError(reason instanceof Error ? reason.message : 'History could not load.'); }
    finally { if (attempt === sequence.current) setBusy(false); }
  };
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [entity.id, kind]);
  return <Dialog title={`${recordTitle(entity.value)} · saved history`} close={close}>
    <p className="metadata">Read an exact saved version. Your current device edits stay in the editor.</p>
    {error && <p role="alert" className="field-error">{error}</p>}{!versions.length && !busy && !error && <Empty title="No saved versions yet."/>}
    <div className="record-history-list">{versions.map(version => <button key={version.revision} aria-pressed={selected?.revision === version.revision} onClick={() => setSelected(version)}><strong>Version {version.revision}</strong><span>{new Date(version.updatedAt).toLocaleString()}</span></button>)}</div>
    {busy && <p role="status">Loading saved history…</p>}{(before || error) && <button disabled={busy} onClick={() => void load(before ?? undefined)}>{error ? 'Retry history' : 'Load earlier versions'}</button>}
    {selected && <section className="record-history-preview"><h3>Version {selected.revision}</h3>{kind === 'content' ? <><p>{(selected.value as Content).brief}</p><pre>{(selected.value as Content).body}</pre><button onClick={() => exportContent(selected.value as Content, selected.revision)}>Export version {selected.revision}</button><ContentSource content={selected.value as Content}/></> : <dl>{Object.entries(selected.value).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</dd></div>)}</dl>}</section>}
  </Dialog>;
}
