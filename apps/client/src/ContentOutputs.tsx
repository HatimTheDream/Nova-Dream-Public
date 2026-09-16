import { useEffect, useRef, useState } from 'react';
import type { AssistantOutput } from '../../../packages/domain/assistant';
import type { Entity, Snapshot } from '../../../packages/domain/contracts';
import type { Content, ContentFromOutputCommand } from '../../../packages/domain/workspace-records';
import type { ContentFromAssignmentCommand } from '../../../packages/domain/workspace-records';
import type { AssignmentAttempt } from '../../../packages/domain/assignments';
import { ApiError, readLocal, request, saveLocal } from './api';
import { Dialog, Empty } from './ui';

export type ContentOutputActions = { snapshot: Snapshot; refresh: () => Promise<void>; openContent: (id: string) => void };

// Both entry points keep the same admission envelope until the host confirms it.
// Navigation never creates another request after a lost response.
export function UseOutputInContent({ output, snapshot, refresh, openContent }: ContentOutputActions & { output: AssistantOutput }) {
  const key = `e3:content-output:${snapshot.deviceId}:${snapshot.epoch}:${output.id}:${output.version}`;
  const [pending, setPending] = useState<ContentFromOutputCommand | undefined>(() => readLocal(key));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [rejected, setRejected] = useState(false);
  const flight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [key]);
  const linked = snapshot.records?.content.find(record => record.value.source?.kind !== 'assignment' && record.value.source?.outputId === output.id && record.value.source.version === output.version && record.value.source.sha256 === output.file?.sha256);
  const create = async () => {
    if (flight.current || !output.file || output.state !== 'ready') return;
    if (linked) { openContent(linked.id); return; }
    const command = pending ?? readLocal<ContentFromOutputCommand>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, outputId: output.id, version: output.version, sha256: output.file.sha256 };
    if (!saveLocal(key, command)) { setError('Free browser storage before starting this draft. Your original output is kept.'); return; }
    setPending(command); flight.current = true; setBusy(true); setError('');
    try {
      const content = await request<Entity<Content>>('content/from-output', command);
      // Retain the receipt identity even after acknowledgment. It remains safe to
      // reopen before polling has brought the new entity into the snapshot.
      await refresh();
      if (mounted.current) openContent(content.id);
    } catch (reason) {
      if (mounted.current) { setError(reason instanceof Error ? reason.message : 'The new draft is not confirmed. Retry to reconcile the same request.'); setRejected(reason instanceof ApiError && ['epoch_changed', 'output_source_changed', 'attachment_changed', 'attachment_corrupt', 'attachment_missing', 'missing_project', 'validation'].includes(reason.code)); }
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  return <span className="content-output-action"><button disabled={busy || rejected || !output.file || output.state !== 'ready'} onClick={() => void create()}>{busy ? 'Opening Content…' : linked ? 'Open Content draft' : pending ? 'Reconcile Content draft' : 'Use in Content'}</button>{error && <span className="field-error" role="alert">{error}</span>}</span>;
}

export function UseAssignmentInContent({ attempt, snapshot, refresh, openContent }: ContentOutputActions & { attempt: AssignmentAttempt }) {
  const key = `e3:content-assignment:${snapshot.deviceId}:${snapshot.epoch}:${attempt.id}`;
  const [pending, setPending] = useState<ContentFromAssignmentCommand | undefined>(() => readLocal(key));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [rejected, setRejected] = useState(false);
  const flight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [key]);
  const linked = snapshot.records?.content.find(record => record.value.source?.kind === 'assignment' && record.value.source.attemptId === attempt.id && record.value.source.sha256 === attempt.result?.file.sha256);
  const create = async () => {
    if (flight.current || !attempt.result) return;
    if (linked) { openContent(linked.id); return; }
    const command = pending ?? readLocal<ContentFromAssignmentCommand>(key) ?? { requestId: crypto.randomUUID(), epoch: snapshot.epoch, attemptId: attempt.id, sha256: attempt.result.file.sha256 };
    if (!saveLocal(key, command)) { setError('Free browser storage before creating the Content draft. The assignment result is kept.'); return; }
    setPending(command); setBusy(true); flight.current = true; setError('');
    try { const content = await request<Entity<Content>>('content/from-assignment', command); await refresh(); if (mounted.current) openContent(content.id); }
    catch (reason) { if (mounted.current) { setError(reason instanceof Error ? reason.message : 'The Content draft has not been confirmed. Reconcile the same request.'); setRejected(reason instanceof ApiError && ['assignment_result_changed', 'assignment_result_empty', 'attachment_changed', 'attachment_corrupt', 'attachment_missing', 'missing_project', 'epoch_changed', 'validation'].includes(reason.code)); } }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  return <span className="content-output-action"><button disabled={busy || rejected} onClick={() => void create()}>{busy ? 'Opening Content…' : linked ? 'Open Content draft' : pending ? 'Reconcile Content draft' : 'Use in Content'}</button>{error && <span className="field-error" role="alert">{error}</span>}</span>;
}

export function ContentOutputLibrary({ outputs, close, ...actions }: ContentOutputActions & { outputs: AssistantOutput[]; close: () => void }) {
  const [query, setQuery] = useState('');
  const saved = outputs.filter(output => output.state === 'ready' && output.file && output.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Dialog title="Start from a saved output" close={close}>
    <p className="metadata">Keep the original file and its exact version. Text becomes an editable draft; other files stay attached to the new brief.</p>
    <label>Find an output<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search saved file names…"/></label>
    <div className="content-output-library">{saved.map(output => <article key={`${output.id}:${output.version}`}><div><strong>{output.name}</strong><p className="metadata">Version {output.version} · {actions.snapshot.projects.find(project => project.id === output.projectId)?.value.name ?? 'Unfiled'}</p><a href={`/api/attachments/${output.file!.id}`}>Download original</a></div><UseOutputInContent key={`${actions.snapshot.epoch}:${output.id}:${output.version}`} output={output} {...actions}/></article>)}</div>
    {!saved.length && <Empty title={query ? 'No saved outputs match.' : 'Your saved outputs will appear here.'}>Save a reply or generated file in Assistant, then use it to begin a Content draft.</Empty>}
  </Dialog>;
}
