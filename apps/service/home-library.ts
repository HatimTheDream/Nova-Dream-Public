import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { AssistantOutput } from '../../packages/domain/assistant.js';
import type { AssignmentAttempt } from '../../packages/domain/assignments.js';
import { canonical } from '../../packages/domain/contracts.js';
import { homeCaptureSchema, homeLibraryCommandSchema, homeReferenceKey, type HomeCollection, type HomeIdeaPreferences, type HomeItem, type HomeLibraryState, type HomeReference, type HomeResource, type HomeSourceCapture } from '../../packages/domain/home-library.js';
import { Fault, Store } from './store.js';

const collections = 'home:library:collection:', items = 'home:library:item:';
export class HomeLibrary {
 constructor(private store: Store, private now = Date.now) {}
 private catalog(device: string): HomeResource[] {
  const snapshot = this.store.snapshot(device), result: HomeResource[] = [];
  const add = (reference: HomeReference, title: string, subtitle: string, updatedAt: string, url?: string) => result.push({ reference, title, subtitle, updatedAt, availability: 'current', ...(url ? { url } : {}) });
  for (const item of this.store.internalList<HomeItem>(items)) if (!item.archived) add({ kind: item.kind, id: item.id, revision: item.revision }, item.title, item.kind === 'note' ? 'Saved Note' : item.url, item.updatedAt, item.kind === 'link' ? item.url : undefined);
  for (const content of snapshot.records?.content ?? []) if (!content.value.archived) add({ kind: 'content', id: content.id, revision: content.revision }, content.value.title, `${content.value.platform} · ${content.value.stage}`, content.updatedAt);
  for (const project of snapshot.projects) if (!this.store.projectIsDeleted(project.id)) add({ kind: 'project', id: project.id, revision: project.revision }, project.value.name, 'Project', project.updatedAt);
  for (const task of snapshot.tasks) add({ kind: 'task', id: task.id, revision: task.revision }, task.value.title, `Task · ${task.value.status}`, task.updatedAt);
  for (const output of this.store.internalList<AssistantOutput>('assistant:output:')) if (output.state === 'ready' && output.file) add({ kind: 'output', id: output.id, revision: output.version, sha256: output.file.sha256 }, output.name, 'Saved Assistant Result', output.createdAt);
  for (const attempt of this.store.internalList<AssignmentAttempt>('assignments:summary:')) if (attempt.epoch === snapshot.epoch && attempt.state === 'returned' && attempt.result?.disposition === 'visible') add({ kind: 'assignment', id: attempt.id, revision: attempt.assignmentRevision, sha256: attempt.result.file.sha256 }, attempt.title, `${attempt.agentName} · Saved Result`, new Date(attempt.updatedAt).toISOString());
  for (const widget of snapshot.layout.value.widgets) if (widget.type === 'note' || widget.type === 'links') add({ kind: 'widget', id: widget.id, revision: snapshot.layout.revision }, widget.title || (widget.type === 'note' ? 'Kept Note' : 'Kept Links'), 'Kept Widget · Original Content Preserved', snapshot.layout.updatedAt);
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
 }
 resolve(device: string, reference: HomeReference, catalog = this.catalog(device)): HomeResource {
  const current = catalog.find(r => homeReferenceKey(r.reference) === homeReferenceKey(reference));
  if (!current) return { reference, title: `${reference.kind} · ${reference.id}`, subtitle: 'Source unavailable. Its reference is kept.', availability: 'missing', updatedAt: '' };
  const same = current.reference.revision === reference.revision && current.reference.sha256 === reference.sha256;
  return { ...current, reference, availability: same ? 'current' : 'changed', currentRevision: current.reference.revision };
 }
 private current(ref: HomeReference): boolean {
  if (ref.kind === 'note' || ref.kind === 'link') { const item = this.store.internalRead<HomeItem>(items + ref.id);return !!item && item.kind === ref.kind && item.revision === ref.revision && !item.archived; }
  if (ref.kind === 'output') { const output = this.store.internalRead<AssistantOutput>('assistant:output:' + ref.id);return output?.state === 'ready' && output.version === ref.revision && !!output.file && output.file.sha256 === ref.sha256; }
  if (ref.kind === 'assignment') { const attempt = this.store.internalRead<AssignmentAttempt>('assignments:summary:' + ref.id);return attempt?.epoch === this.store.epoch && attempt.state === 'returned' && attempt.assignmentRevision === ref.revision && attempt.result?.disposition === 'visible' && attempt.result.file.sha256 === ref.sha256; }
  if (ref.kind === 'widget') { const layout = this.store.readEntity('layout', 'layout');return layout?.revision === ref.revision && layout.value.widgets.some(w => w.id === ref.id && (w.type === 'note' || w.type === 'links')); }
  const entity = this.store.readEntity(ref.kind, ref.id);return !!entity && entity.revision === ref.revision && !('archived' in entity.value && entity.value.archived) && !('trashed' in entity.value && entity.value.trashed) && !(ref.kind === 'project' && this.store.projectIsDeleted(ref.id));
 }
 state(device: string): HomeLibraryState {
  const list = this.store.internalList<HomeCollection>(collections).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const resources = this.catalog(device), keys = new Set(resources.map(r => canonical(r.reference))), catalog = [...resources];
  for (const ref of list.flatMap(c => c.references)) if (!keys.has(canonical(ref))) { resources.push(this.resolve(device, ref, catalog)); keys.add(canonical(ref)); }
  return { epoch: this.store.epoch, collections: list, items: this.store.internalList<HomeItem>(items), resources, ideaPreferences: this.store.internalRead<HomeIdeaPreferences>('home:ideas:preferences') ?? { revision: 0, saved: [], hidden: [] } };
 }
 command(device: string, raw: unknown): HomeCollection | HomeItem | HomeIdeaPreferences {
  const input = homeLibraryCommandSchema.parse(raw);
  return this.store.admit(device, input, { operation: 'home.library', ...input }, () => {
   if (input.type === 'preferences-save') { const old = this.store.internalRead<HomeIdeaPreferences>('home:ideas:preferences');if ((old?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'home_preferences_changed', 'Idea preferences changed. Refresh before saving your preference.');return this.store.internalWrite('home:ideas:preferences', { ...input.value, revision: input.expectedRevision + 1 }); }
   const prefix = input.type === 'collection-save' ? collections : items, old = this.store.internalRead<HomeCollection | HomeItem>(prefix + input.id);
   if ((old?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'home_library_changed', 'This item changed. Your edits are kept; reload the saved version before saving.', old);
   if (input.type === 'collection-save') {
    if (old && !('references' in old)) throw new Fault(409, 'home_library_kind', 'Choose the original collection.');
    if (!old && this.store.internalList(collections).length >= 100) throw new Fault(507, 'home_library_limit', 'The collection limit is reached. Reuse an existing collection.');
    for (const ref of input.value.references) {
     if (old && 'references' in old && old.references.some(r => canonical(r) === canonical(ref))) continue;
     if (!this.current(ref)) throw new Fault(409, 'home_source_changed', 'A selected source changed or disappeared. Refresh it before adding it.');
    }
   } else {
    if (old && (!('kind' in old) || old.kind !== input.value.kind)) throw new Fault(409, 'home_library_kind', 'Keep the original item type.');
    const all = this.store.internalList<HomeItem>(items);
    if (!old && all.length >= 300 || all.filter(i => i.id !== input.id).reduce((n, i) => n + i.body.length, 0) + input.value.body.length > 2_000_000) throw new Fault(507, 'home_library_limit', 'Library storage is full. Existing notes and links are kept.');
   }
   const saved = { ...input.value, id: input.id, revision: input.expectedRevision + 1, updatedAt: new Date(this.now()).toISOString() };
   this.store.internalWrite(`home:library:version:${input.type}:${input.id}:${saved.revision}`, saved);
   return this.store.internalWrite(prefix + input.id, saved);
  }).value;
 }
 capture(device: string, raw: unknown): HomeSourceCapture {
  const input = homeCaptureSchema.parse(raw), catalog = this.catalog(device);
  return this.store.admit(device, input, { operation: 'home.context', ...input }, () => {
   const sources = input.references.map(ref => {
    const resource = this.resolve(device, ref, catalog);if (!this.current(ref)) throw new Fault(409, 'home_source_changed', 'A source changed. Refresh the selection before continuing.');
    let text = '';
    if (ref.kind === 'note' || ref.kind === 'link') text = this.store.internalRead<HomeItem>(items + ref.id)!.body;
    else if (ref.kind === 'content') { const c = this.store.readEntity('content', ref.id)!.value; text = [c.brief, c.body].filter(Boolean).join('\n\n'); }
    else if (ref.kind === 'project') { const p = this.store.readEntity('project', ref.id)!.value; text = [p.purpose, p.instructions].filter(Boolean).join('\n\n'); }
    else if (ref.kind === 'task') text = JSON.stringify(this.store.readEntity('task', ref.id)!.value, null, 2);
    else if (ref.kind === 'widget') { const w = this.store.readEntity('layout', 'layout')!.value.widgets.find(w => w.id === ref.id)!; text = w.settings?.text ?? w.settings?.links?.map(l => `${l.label}\n${l.url}`).join('\n\n') ?? ''; }
    else {
     const output = ref.kind === 'output' ? this.store.internalRead<AssistantOutput>('assistant:output:' + ref.id) : undefined;
     const attempt = ref.kind === 'assignment' ? this.store.internalRead<AssignmentAttempt>('assignments:attempt:' + ref.id) : undefined;
     const file = output?.file ?? attempt?.result?.file;
     if (!file || file.sha256 !== ref.sha256) throw new Fault(409, 'home_source_changed', 'The saved result changed. Reopen its original source.');
     const downloaded = this.store.download(file.id);if (downloaded.metadata.sha256 !== file.sha256) throw new Fault(409, 'home_source_changed', 'The saved file changed.');
     if (downloaded.bytes.length > 400000) throw new Fault(413, 'home_source_large', 'This result is too large for quoted context. Open or download the original result.');
     try { text = new TextDecoder('utf-8', { fatal: true }).decode(downloaded.bytes); } catch { throw new Fault(400, 'home_source_format', 'This result needs its original file. Choose a text source for discussion.'); }
    }
    return { ...resource, text };
   });
   if (sources.reduce((n, s) => n + (s.text?.length ?? 0), 0) > 90000) throw new Fault(413, 'home_context_large', 'The selected sources exceed the Assistant draft limit. Choose fewer sources; nothing was shortened.');
   const capture: HomeSourceCapture = { id: randomUUID(), epoch: input.epoch, createdAt: new Date(this.now()).toISOString(), sources };
   return this.store.internalWrite('home:context:' + capture.id, capture);
  }).value;
 }
}
