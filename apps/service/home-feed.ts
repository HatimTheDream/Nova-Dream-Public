import { TextDecoder } from 'node:util';
import type { AssistantOutput, Conversation } from '../../packages/domain/assistant.js';
import type { Attachment } from '../../packages/domain/contracts.js';
import type { AssignmentAttempt } from '../../packages/domain/assignments.js';
import type { AgentRoutine, RoutineOccurrence } from '../../packages/domain/agent-routines.js';
import type { ContentReview } from '../../packages/domain/content-workspace.js';
import { homeFeedOpenSchema, type HomeDestination, type HomeDestinationLink, type HomeFeedCard, type HomeFeedState } from '../../packages/domain/home-feed.js';
import type { HomeItem } from '../../packages/domain/home-library.js';
import { Fault, Store } from './store.js';

/** Observations of retained work only; reading Feed never dispatches a job. */
export class HomeFeed {
 constructor(private store: Store) {}
 /** Reopen a saved identity without dispatching, revising, or recapturing work. */
 destination(_device: string, raw: unknown): HomeDestination {
  const input = homeFeedOpenSchema.parse(raw);
  if (input.epoch !== this.store.epoch) throw new Fault(409, 'epoch_changed', 'The workspace changed. Reopen this saved reference before continuing.');
  const links: HomeDestinationLink[] = [];
  let fileStatus: string | undefined;
  const link = (value: HomeDestinationLink) => { if (!links.some(l => JSON.stringify(l) === JSON.stringify(value))) links.push(value); };
  const finish = (title: string, status: string, text: string, details = ''): HomeDestination => ({ ...input, epoch: this.store.epoch, title, status: fileStatus ?? status, text: text.length > 60000 ? text.slice(0, 60000) + '\n\n[Preview ends here. Open the original saved work for the complete text.]' : text, sourceDetails: [JSON.stringify('target' in input ? input.target : input.reference, null, 2), details].filter(Boolean).join('\n\n'), links, ...(text.length > 60000 || fileStatus ? { previewOnly: true } : {}) });
  const missing = (label: string) => finish('Saved Work Unavailable', 'Unavailable', 'This exact saved work is unavailable. Its reference is kept; a newer record has not been substituted.', label);
  const fileText = (file: Attachment): string => {
   try {
    const saved = this.store.download(file.id);
    if (saved.metadata.sha256 !== file.sha256 || saved.metadata.size !== file.size) { fileStatus = 'File Changed';return 'The original saved file no longer matches this result. Open the original work to inspect its retained state.'; }
    if (saved.bytes.length > 400000) { fileStatus = 'File Preview Unavailable';return 'This saved file is too large for an inline preview. Open the original work to inspect or download the complete result.'; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes); } catch { fileStatus = 'File Preview Unavailable';return 'This saved result is a file rather than readable UTF-8 text. Open the original work to inspect or download it.'; }
   } catch (error) { if (!(error instanceof Fault) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;fileStatus = 'File Unavailable';return 'The original saved file is unavailable. The result identity is kept; no newer file was substituted.'; }
  };
  const projectLink = (id: string | null) => { if (id && this.store.readEntity('project', id) && !this.store.projectIsDeleted(id)) link({ kind: 'project', id }); };
  const assignment = (attemptId: string, assignmentId?: string, revision?: number, sha256?: string) => {
   const a = this.store.internalRead<AssignmentAttempt>('assignments:attempt:' + attemptId) ?? this.store.internalRead<AssignmentAttempt>('assignments:summary:' + attemptId);
   if (!a || a.epoch !== input.epoch || assignmentId && a.assignmentId !== assignmentId || revision && a.assignmentRevision !== revision || sha256 && a.result?.file.sha256 !== sha256) return missing(`Assignment Attempt · ${attemptId}`);
   if (this.store.readEntity('assignment', a.assignmentId)) link({ kind: 'assignment', id: a.assignmentId, attemptId: a.id });projectLink(a.projectId);
   const visible = a.state === 'returned' && a.result?.disposition === 'visible';
   return finish(a.title, visible ? 'Saved Result' : a.state === 'unknown' ? 'Needs Checking' : a.state === 'stopping' ? 'Stop Unconfirmed' : a.state[0].toUpperCase() + a.state.slice(1), [a.message, visible && a.result ? fileText(a.result.file) : 'No complete visible result is available for this exact attempt.'].join('\n\n'), `Assignment ${a.assignmentId}\nAttempt ${a.id}\nPlan version ${a.assignmentRevision}\nObserved state: ${a.state}${a.result ? `\nFile SHA256 ${a.result.file.sha256}` : ''}`);
  };
  const output = (id: string, version: number, sha256?: string, conversationId?: string) => {
   const o = this.store.internalRead<AssistantOutput>('assistant:output:' + id);
   if (!o || o.version !== version || conversationId && o.conversationId !== conversationId || sha256 && o.file?.sha256 !== sha256) return missing(`Saved Output · ${id} · Version ${version}`);
   const conversation = this.store.internalRead<Conversation>('assistant:conversation:' + o.conversationId);
   if (conversation && !conversation.deleted) link({ kind: 'conversation', id: o.conversationId });projectLink(o.projectId);
   return finish(o.name, o.state === 'ready' && o.file ? 'Saved Result' : 'Save Unconfirmed', o.state === 'ready' && o.file ? fileText(o.file) : 'The original output save has not been confirmed. Open the original conversation before retrying.', `Output ${o.id}\nVersion ${o.version}\nConversation ${o.conversationId}${o.file ? `\nFile SHA256 ${o.file.sha256}` : ''}`);
  };
  if ('reference' in input) {
   const ref = input.reference;
   if (ref.kind === 'assignment') return assignment(ref.id, undefined, ref.revision, ref.sha256);
   if (ref.kind === 'output') return output(ref.id, ref.revision, ref.sha256);
   if (ref.kind === 'note' || ref.kind === 'link') {
    const current = this.store.internalRead<HomeItem>('home:library:item:' + ref.id), saved = current?.revision === ref.revision ? current : this.store.internalRead<HomeItem>(`home:library:version:item-save:${ref.id}:${ref.revision}`);
    if (!saved || saved.kind !== ref.kind || saved.revision !== ref.revision) return missing(`${ref.kind} · ${ref.id} · Version ${ref.revision}`);
    return finish(saved.title, current?.revision === ref.revision ? 'Saved Version' : 'Earlier Saved Version', [current?.revision !== ref.revision ? 'This is an earlier saved version. Your current writing is kept separately.' : '', saved.body, saved.kind === 'link' ? saved.url : ''].filter(Boolean).join('\n\n'), `Library ${saved.id} · version ${saved.revision}`);
   }
   if (ref.kind === 'widget') {
    const layout = this.store.readEntityVersion('layout', 'layout', ref.revision), widget = layout?.value.widgets.find(w => w.id === ref.id && (w.type === 'note' || w.type === 'links'));
    if (!widget) return missing(`Widget · ${ref.id} · Layout Version ${ref.revision}`);
    return finish(widget.title || 'Kept Widget', 'Saved Widget Version', widget.settings?.text ?? widget.settings?.links?.map(l => `${l.label}\n${l.url}`).join('\n\n') ?? '', `Widget ${ref.id} · layout version ${ref.revision}`);
   }
   const entity = this.store.readEntityVersion(ref.kind, ref.id, ref.revision), current = this.store.readEntity(ref.kind, ref.id);
   if (!entity) return missing(`${ref.kind} · ${ref.id} · Version ${ref.revision}`);
   link({ kind: ref.kind, id: ref.id });
   const value = entity.value;
   const fields = ref.kind === 'task' ? [['status', 'Status'], ['planned', 'Planned Date'], ['plannedTime', 'Planned Time'], ['timezone', 'Timezone'], ['due', 'Deadline'], ['priority', 'Priority'], ['estimateMinutes', 'Minutes'], ['notes', 'Notes']] : ref.kind === 'project' ? [['purpose', 'Purpose'], ['instructions', 'Instructions']] : [['brief', 'Brief'], ['body', 'Draft']];
   const copy = fields.flatMap(([key, label]) => { const field = (value as Record<string, unknown>)[key!];return typeof field === 'string' && field || typeof field === 'number' && field ? [`${label}\n${field}`] : []; }).join('\n\n');
   return finish('title' in value ? value.title : 'name' in value ? value.name : ref.id, current?.revision === ref.revision ? 'Saved Version' : 'Earlier Saved Version', [current?.revision !== ref.revision ? `The current record is version ${current?.revision}. This preview is the earlier saved version.` : '', copy || 'This saved record has no additional description.'].filter(Boolean).join('\n\n'), `${ref.kind} ${ref.id} · version ${ref.revision}`);
  }
  const target = input.target;
  if (target.kind === 'assignment') return assignment(target.attemptId, target.id);
  if (target.kind === 'conversation') {
   if (target.outputId && target.outputVersion) return output(target.outputId, target.outputVersion, target.sha256, target.id);
   const conversation = this.store.internalRead<Conversation>('assistant:conversation:' + target.id);
   if (!conversation || conversation.deleted) return missing(`Conversation · ${target.id}`);
   link({ kind: 'conversation', id: conversation.id });return finish(conversation.title, 'Conversation', 'Open the original conversation to inspect its retained messages.');
  }
  if (target.kind === 'content') {
   const current = this.store.readEntity('content', target.id);if (current) link({ kind: 'content', id: target.id });
   const review = target.reviewId ? this.store.internalRead<ContentReview>('content:review:' + target.reviewId) : undefined;
   if (target.reviewId && (!review || review.contentId !== target.id || review.sourceRevision !== target.sourceRevision)) return missing(`Content Review · ${target.reviewId}`);
   const source = target.sourceRevision ? this.store.readEntityVersion('content', target.id, target.sourceRevision) : current;
   if (!source) return missing(`Content · ${target.id} · Version ${target.sourceRevision ?? 'Current'}`);
   const reviewChanged = !!(review && target.reviewRevision && review.revision !== target.reviewRevision);
   return finish(source.value.title, reviewChanged ? 'Review Updated' : current?.revision !== source.revision ? 'Earlier Content Version' : review ? 'Content Review' : 'Saved Content', [current?.revision !== source.revision ? `The current draft is version ${current?.revision}. This preview is the reviewed saved version.` : '', review ? reviewChanged ? `The review changed from revision ${target.reviewRevision} to ${review.revision}. Earlier review comments are unavailable; no current comments are presented as the earlier review.` : `Review · ${review.state}\n${review.comments.map(c => `${c.author}${c.resolved ? ' · Resolved' : ' · Open'}\n${c.quote ? `Quoted: ${c.quote}\n` : ''}${c.text}`).join('\n\n')}` : '', source.value.brief, source.value.body].filter(Boolean).join('\n\n'), `Content ${source.id} · version ${source.revision}${review ? `\nReview ${review.id} · source version ${review.sourceRevision} · revision ${review.revision}` : ''}`);
  }
  const routine = this.store.internalRead<AgentRoutine>('agent-routines:item:' + target.id);
  if (!routine || routine.epoch !== input.epoch) return missing(`Routine · ${target.id} · Occurrence ${target.occurrenceId}`);
  const cursor = this.store.internalRead<{ suffix: string; routineId: string }>('agent-routines:cursor:' + target.occurrenceId);
  const occurrence = cursor?.routineId === target.id ? this.store.internalRead<RoutineOccurrence>('agent-routines:history:all:' + cursor.suffix) : this.store.internalList<RoutineOccurrence>('agent-routines:history:all:').find(o => o.id === target.occurrenceId && o.routineId === target.id);
  if (!occurrence || occurrence.id !== target.occurrenceId || occurrence.routineId !== target.id) return missing(`Routine Occurrence · ${target.occurrenceId}`);
  const captured = routine.revision === occurrence.routineRevision ? routine : this.store.internalRead<AgentRoutine>(`agent-routines:revision:${routine.id}:${occurrence.routineRevision.toString().padStart(8, '0')}`);
  link({ kind: 'routine', id: routine.id, occurrenceId: occurrence.id });
  const attempt = occurrence.attemptId ? this.store.internalRead<AssignmentAttempt>('assignments:attempt:' + occurrence.attemptId) ?? this.store.internalRead<AssignmentAttempt>('assignments:summary:' + occurrence.attemptId) : undefined;
  const matching = attempt?.epoch === input.epoch && attempt.routine?.routineId === routine.id && attempt.routine?.occurrenceId === occurrence.id ? attempt : undefined;
  if (matching && this.store.readEntity('assignment', matching.assignmentId)) link({ kind: 'assignment', id: matching.assignmentId, attemptId: matching.id });
  return finish(captured?.value.name ?? 'Saved Routine Occurrence', occurrence.state === 'review' ? 'Needs Review' : occurrence.state === 'skipped' ? 'Skipped' : matching?.state === 'returned' && matching.result?.disposition === 'visible' ? 'Result Ready' : matching ? matching.state[0].toUpperCase() + matching.state.slice(1) : 'Occurrence Recorded', [`Scheduled ${new Date(occurrence.scheduledAt).toISOString()}${captured ? `\nTimezone ${captured.value.timezone}` : '\nThe original routine definition is unavailable; current settings have not been substituted.'}`, occurrence.message, matching ? `${matching.message}${matching.state === 'returned' && matching.result?.disposition === 'visible' ? '\n\n' + fileText(matching.result.file) : ''}` : occurrence.attemptId ? 'The recorded attempt is unavailable or no longer matches this occurrence.' : 'No assignment attempt was recorded for this occurrence.'].join('\n\n'), `Routine ${routine.id} · version ${occurrence.routineRevision}\nOccurrence ${occurrence.id}\nRecorded ${new Date(occurrence.recordedAt).toISOString()}${occurrence.attemptId ? `\nAttempt ${occurrence.attemptId}` : ''}`);
 }
 state(device: string): HomeFeedState {
  const snapshot = this.store.snapshot(device), cards: HomeFeedCard[] = [];
  const attempts = this.store.internalList<AssignmentAttempt>('assignments:summary:').filter(a => a.epoch === snapshot.epoch);
  for (const a of attempts) {
   const returned = a.state === 'returned' && a.result?.disposition === 'visible', attention = ['unknown', 'stopping', 'failed'].includes(a.state);
   if (!returned && !attention) continue;
   cards.push({ id: 'assignment:' + a.id, title: a.title, summary: a.message, detail: [a.message, returned ? 'A saved result is available. Open the exact attempt to inspect the full result and any changes.' : 'This is the last observed state. Check the original attempt before starting more work.', `Assignment ${a.assignmentId} · attempt ${a.id} · plan version ${a.assignmentRevision}`].join('\n\n'), kind: returned ? 'result' : 'attention', status: returned ? 'Result Ready' : a.state === 'unknown' ? 'Needs Checking' : a.state === 'stopping' ? 'Stop Unconfirmed' : 'Run Failed', at: new Date(a.updatedAt).toISOString(), target: { kind: 'assignment', id: a.assignmentId, attemptId: a.id }, references: returned && a.result ? [{ kind: 'assignment', id: a.id, revision: a.assignmentRevision, sha256: a.result.file.sha256 }] : [], projectId: a.projectId });
  }
  for (const o of this.store.internalList<AssistantOutput>('assistant:output:')) if (o.state === 'ready' && o.file) cards.push({ id: 'output:' + o.id + ':' + o.version, title: o.name, summary: 'A saved Assistant result is ready to reopen.', detail: `Saved output ${o.id} · version ${o.version}\nConversation ${o.conversationId}\nOpen the original conversation or discuss the complete saved text.`, at: o.createdAt, kind: 'result', status: 'Saved Result', target: { kind: 'conversation', id: o.conversationId, outputId: o.id, outputVersion: o.version, sha256: o.file.sha256 }, references: [{ kind: 'output', id: o.id, revision: o.version, sha256: o.file.sha256 }], projectId: o.projectId });
  for (const review of this.store.internalList<ContentReview>('content:review:')) {
   const content = snapshot.records?.content.find(c => c.id === review.contentId);if (!content || content.value.archived || review.state === 'approved') continue;
   cards.push({ id: 'review:' + review.id, title: content.value.title, summary: review.state === 'changes' ? 'Changes were requested on this Content version.' : 'A review is waiting on this Content version.', detail: `Review ${review.id} · revision ${review.revision}\nContent version ${review.sourceRevision}${content.revision !== review.sourceRevision ? '\nThe current draft has changed since this review.' : ''}`, at: new Date(review.updatedAt).toISOString(), kind: 'review', status: 'Review', target: { kind: 'content', id: content.id, reviewId: review.id, reviewRevision: review.revision, sourceRevision: review.sourceRevision }, references: [{ kind: 'content', id: content.id, revision: review.sourceRevision }], projectId: content.value.projectId });
  }
  const routines = this.store.internalList<AgentRoutine>('agent-routines:item:');
  for (const occurrence of this.store.internalList<RoutineOccurrence>('agent-routines:history:all:')) {
   const routine = routines.find(r => r.id === occurrence.routineId);if (!routine || routine.epoch !== snapshot.epoch) continue;
   const attempt = attempts.find(a => a.id === occurrence.attemptId);
   const status = occurrence.state === 'review' ? 'Routine Needs Review' : occurrence.state === 'skipped' ? 'Skipped Occurrence' : attempt?.state === 'returned' ? attempt.result?.disposition === 'visible' ? 'Result Ready' : 'Run Returned Without A Visible Result' : attempt?.state === 'unknown' ? 'Needs Checking' : attempt?.state === 'stopping' ? 'Stop Unconfirmed' : attempt?.state === 'failed' ? 'Run Failed' : attempt?.state === 'cancelled' ? 'Run Cancelled' : attempt ? 'Occurrence Started' : 'Occurrence Recorded';
   cards.push({ id: 'occurrence:' + occurrence.id, title: routine.value.name, summary: attempt?.message || occurrence.message, detail: `Occurrence ${occurrence.id}\nRoutine version ${occurrence.routineRevision}\n${occurrence.message}`, at: new Date(occurrence.recordedAt).toISOString(), kind: 'routine', status, target: { kind: 'routine', id: routine.id, occurrenceId: occurrence.id }, references: attempt?.state === 'returned' && attempt.result?.disposition === 'visible' ? [{ kind: 'assignment', id: attempt.id, revision: attempt.assignmentRevision, sha256: attempt.result.file.sha256 }] : [], projectId: attempt?.projectId ?? null });
  }
  return { epoch: snapshot.epoch, cards: cards.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, 100) };
 }
}
