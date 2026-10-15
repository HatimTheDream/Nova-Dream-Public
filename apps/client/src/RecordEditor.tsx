import type { MailContactSource } from '../../../packages/domain/mail-contact';
import { useEffect, useRef, useState } from 'react';
import { dayInZone } from '../../../packages/domain/tasks';
import type { Contact, Content } from '../../../packages/domain/workspace-records';
import { canonical, type Entity, type Snapshot, type Task } from '../../../packages/domain/contracts';
import { blankRecord, recordSchemas, recordTitle, type RecordKind, type RecordValue, type ContentOutputSource, type Assignment } from '../../../packages/domain/workspace-records';
import { Conflict } from './ui';
import { retainedWindowId, useRetained } from './useWorkspace';
import { readLocal, saveLocal } from './api';
import { createMascotAppearance } from '../../../packages/domain/mascot-appearance';
import { AgentAccessFields, RecordFields } from './RecordFields';
import type { AgentDesign } from '../../../packages/domain/workspace-records';
import { RecordConnections } from './RecordConnections';
import { AssignmentRuns } from './AssignmentRuns';
import { ContactPhoto } from './ContactPhoto';
import { ContentFiles } from './ContentFiles';

export function RecordEditor({ onSaved, compact = false, requestPublication, kind, id, entity, snapshot, refresh, editTask, close, removeDraft, openSource, openContent, openEmail }: { onSaved?: () => void; compact?: boolean; openEmail?: (source: MailContactSource) => Promise<void>; requestPublication?: string; openSource?: (source: ContentOutputSource) => void; openContent?: (id: string) => void; kind: RecordKind; id: string; entity?: Entity<RecordValue>; snapshot: Snapshot; refresh: () => Promise<void>; editTask: (task: Entity<Task>) => void; close?: () => void; removeDraft?: () => void }) {
  const [initial] = useState(() => { const blank = blankRecord(kind, snapshot.layout?.value.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone); return kind === 'agent' ? { ...blank, appearance: createMascotAppearance() } : blank; });
  const stepKey = `e3:agent-creator-step:${snapshot.deviceId}:${id}:${retainedWindowId}`;
  const [agentStep, setAgentStep] = useState<'identity' | 'appearance' | 'work'>(() => { const value = readLocal<string>(stepKey); return value === 'appearance' || value === 'work' ? value : 'identity'; });
  const chooseStep = (step: typeof agentStep) => { setAgentStep(step); saveLocal(stepKey, step); };
  const savedScope = `${snapshot.epoch}:${kind}:${id}`;
  const currentSavedScope = useRef(savedScope); currentSavedScope.current = savedScope;
  const [acknowledged, setAcknowledged] = useState<{ scope: string; entity: Entity<RecordValue> }>();
  const snapshotEntity = entity?.id === id ? entity : undefined;
  // A successful command is authoritative even when an already-running
  // refresh has not propagated its snapshot yet. Newer host state still wins.
  const savedEntity = acknowledged?.scope === savedScope && acknowledged.entity.id === id && acknowledged.entity.revision > (snapshotEntity?.revision ?? 0) ? acknowledged.entity : snapshotEntity;
  const keepAcknowledgement = (result: Entity<RecordValue> | undefined) => {
    if (!result || result.id !== id || currentSavedScope.current !== savedScope) return;
    setAcknowledged(previous => previous?.scope === savedScope && previous.entity.revision > result.revision ? previous : { scope: savedScope, entity: result });
  };
  const editor = useRetained<RecordValue>(kind, id, initial, savedEntity, snapshot, refresh, { autoSave: false });
  const [error, setError] = useState('');
  const [lookMessage, setLookMessage] = useState('');
  const [filesPending, setFilesPending] = useState(false);
  const archived = 'archived' in editor.value && editor.value.archived;
  const publicationRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!requestPublication || publicationRequest.current === requestPublication || kind !== 'content') return;
    if (editor.pending || editor.conflict || archived) { setError('Finish the retained save or restore the record before recording publication.'); return; }
    const value = editor.value as Content;
    if (editor.change({ ...value, stage: 'published', publication: value.publication ?? { kind: 'manual', date: dayInZone(snapshot.layout.value.timezone), note: '' } })) publicationRequest.current = requestPublication;
  }, [requestPublication, editor.pending, editor.conflict, archived, kind]);
  const save = async (proposal = editor.value) => {
    const reconcilingPartialSave = !!editor.pending && canonical(editor.pending.payload) !== canonical(proposal);
    if (filesPending) { setError('Finish or remove the pending uploads before saving this version.'); return; }
    if (!editor.pending) {
      const parsed = recordSchemas[kind].safeParse(proposal);
      if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'Record'}: ${issue.message}`).join(' ')); return; }
      editor.change(parsed.data);
    }
    setError(''); const saved = await editor.flush(); keepAcknowledgement(saved); if (saved && !reconcilingPartialSave) onSaved?.();
  };
  const savedAppearance = savedEntity && 'appearance' in savedEntity.value ? savedEntity.value.appearance : null;
  const saveLook = async (appearance: Record<string, unknown> | null) => {
    if ((kind !== 'agent' && kind !== 'profile') || !('appearance' in editor.value)) return;
    setLookMessage('');
    if (editor.saving || editor.pending || editor.conflict || archived) {
      setError('Finish or reconcile the retained save before saving this look.'); return;
    }
    if (editor.epoch !== snapshot.epoch || savedEntity && savedEntity.revision !== editor.revision) {
      setError('The saved record changed. Review your kept edits with Save Changes before saving this look.'); return;
    }
    // New records may still have an incomplete identity. Use Look stages only;
    // the ordinary record Save Changes remains their first host write.
    if (!savedEntity) {
      if (!editor.change({ ...editor.value, appearance })) { setError('Browser storage is full. Keep this window open to preserve your look.'); return; }
      setError(''); setLookMessage('Look kept in this draft. Save Changes when the record is ready.'); return;
    }
    const proposal = recordSchemas[kind].safeParse({ ...savedEntity.value, appearance });
    if (!proposal.success) { setError(proposal.error.issues.map(issue => `${issue.path.join('.') || 'Record'}: ${issue.message}`).join(' ')); return; }
    if (!editor.change({ ...editor.value, appearance })) { setError('Browser storage is full. Keep this window open to preserve your look.'); return; }
    setError('');
    const result = await editor.flush(proposal.data);
    keepAcknowledgement(result);
    if (result) setLookMessage('Look saved. Your other edits are still kept in this draft.');
  };
  const cancelLook = () => {
    if (!('appearance' in editor.value) || editor.saving || editor.pending) return;
    editor.change({ ...editor.value, appearance: savedAppearance });
    setLookMessage('Appearance edits cancelled. Other edits are kept.');
  };
  const toggleArchive = () => { if ('archived' in editor.value) void save({ ...editor.value, archived: !editor.value.archived }); };
  return <section className="card record-editor" data-kind={kind} aria-label={`${kind === 'profile' ? 'Profile' : 'Record'} editor`}>
    <div className="section-heading"><div><span className="eyebrow">{entity ? kind === 'assignment' ? 'Assignment Plan' : kind === 'agent' ? 'Agent Design' : kind === 'contact' ? 'Contact' : kind === 'content' ? 'Content' : 'Profile' : `New ${kind}`}</span><h2>{recordTitle(editor.value) || (kind === 'contact' ? 'New contact' : kind === 'profile' ? 'Your identity' : 'A new beginning')}</h2></div>{close && <button onClick={close}>Keep & close</button>}</div>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {kind === 'agent' && <nav className="agent-creator-steps" aria-label="Agent creation steps">{([['identity', '1 · Identity'], ['appearance', '2 · Appearance'], ['work', '3 · Work setup']] as const).map(([step, label]) => <button key={step} type="button" aria-current={agentStep === step ? 'step' : undefined} onClick={() => chooseStep(step)}>{label}</button>)}</nav>}
      <fieldset disabled={editor.saving || !!editor.pending || archived}>{kind === 'contact' && <ContactPhoto id={id} value={editor.value as Contact} snapshot={snapshot} change={editor.change} pendingChanged={setFilesPending}/>}<RecordFields kind={kind} value={editor.value} change={editor.change} snapshot={snapshot} agentStep={agentStep} appearanceControls={{ savedValue: savedAppearance, onSaveLook: saveLook, onCancelLook: cancelLook, saveLabel: savedEntity ? 'Save Look' : 'Use Look', saving: editor.saving, saveDisabled: !!editor.pending || !!editor.conflict || archived, preferenceKey: `e3:creator-locks:${snapshot.epoch}:${snapshot.deviceId}:${kind}:${id}` }}/>{kind === 'content' && <ContentFiles id={id} value={editor.value as Content} snapshot={snapshot} change={editor.change} pendingChanged={setFilesPending}/>}</fieldset>
      {kind === 'agent' && agentStep !== 'work' && <div className="button-row"><button type="button" onClick={() => chooseStep(agentStep === 'identity' ? 'appearance' : 'work')}>Continue to {agentStep === 'identity' ? 'appearance' : 'work setup'} →</button></div>}
      {kind === 'agent' && agentStep === 'work' && <fieldset disabled={editor.saving || !!editor.pending || archived}><details className="record-optional"><summary>Capabilities</summary><AgentAccessFields value={(editor.value as AgentDesign).access ?? {}} change={access => editor.change({ ...editor.value, access })}/></details></fieldset>}
      {lookMessage && <p role="status" className="metadata">{lookMessage}</p>}
      {error && <p role="alert" className="field-error">{error}</p>}
      <div className="record-editor-footer"><span role="status" className="metadata">{editor.status}{savedEntity && (kind === 'agent' || kind === 'assignment' || kind === 'content') && ` · Version ${savedEntity.revision}`}</span><div className="button-row"><button type="button" disabled={editor.saving || !!editor.pending || filesPending} onClick={() => { editor.discard(); setError(''); if (!savedEntity) removeDraft?.(); }}>{savedEntity ? 'Discard edits' : 'Discard draft'}</button><button className="primary" disabled={editor.saving || filesPending || !!editor.conflict || !editor.dirty || (archived && !editor.pending)}>{editor.saving ? 'Saving…' : filesPending ? 'Finish uploads to save' : editor.pending ? 'Reconcile save' : 'Save changes'}</button></div></div>
    </form>
    {editor.conflict && <Conflict name={recordTitle(editor.value) || 'Record'} message={editor.conflict.message} current={editor.conflict.current ? JSON.stringify(editor.conflict.current.value, null, 2) : undefined} reapply={editor.editProposal} reapplyLabel="Review my edits" discard={() => { editor.discard(); setError(''); }}/>}
    {entity && kind === 'assignment' && <AssignmentRuns key={`${snapshot.epoch}:${entity.id}`} entity={entity as Entity<Assignment>} snapshot={snapshot} refresh={refresh} openContent={openContent} dirty={editor.dirty || !!editor.pending || editor.saving}/>}
    {entity && !compact && <><div className="record-archive-row">{'archived' in entity.value && <button type="button" disabled={editor.dirty || editor.saving || !!editor.pending} onClick={toggleArchive}>{archived ? 'Restore record' : 'Archive record'}</button>}{archived && <span className="metadata">Archived · saved history and linked Tasks are kept.</span>}</div><RecordConnections openEmail={openEmail} openSource={openSource} kind={kind} entity={entity} snapshot={snapshot} refresh={refresh} editTask={editTask}/></>}
  </section>;
}
