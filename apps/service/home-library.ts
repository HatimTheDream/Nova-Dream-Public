import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { AssistantOutput } from '../../packages/domain/assistant.js';
import type { AssignmentAttempt } from '../../packages/domain/assignments.js';
import { canonical } from '../../packages/domain/contracts.js';
import { homeCaptureSchema, homeLibraryCommandSchema, homeReferenceKey, type HomeCollection, type HomeIdeaPreferences, type HomeItem, type HomeLibraryState, type HomeReference, type HomeResource, type HomeSourceCapture, type HomeLibraryCommand, type HomeItemValue, type HomeOrganization, type LibraryReceipt } from '../../packages/domain/home-library.js';
import { normalizeHomeUrl } from '../../packages/domain/home-library-view.js';
import { Fault, Store } from './store.js';

const collections = 'home:library:collection:', items = 'home:library:item:';
const organizationKey = 'home:library:organization', operationKey = 'home:library:operation:', undoneKey = 'home:library:undone:';
type CollectionInverse = { id: string; revision: number; before: Partial<Pick<HomeCollection, 'references' | 'pinned' | 'archived'>> };
type OrganizationInverse = { revision: number; collectionIds: string[] };
type Inverse = { epoch: string; device: string; type: HomeLibraryCommand['type']; collections: CollectionInverse[]; organization: OrganizationInverse | null };
type Mutation = Exclude<HomeLibraryCommand, { type: 'collection-save' | 'item-save' | 'preferences-save' }>;
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const refEqual = (a: HomeReference, b: HomeReference) => equal(a, b);
const linkUrl = (value: string) => {
 const normalized = normalizeHomeUrl(value);
 if (!normalized) throw new Fault(409, 'home_reference_conflict', 'The exact saved link is unavailable or invalid. Review it before continuing.');
 return normalized;
};
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
  if (reference.kind === 'note' || reference.kind === 'link') {
   const saved = this.savedItem(reference);
   if (saved) return { reference, title: saved.title, subtitle: saved.kind === 'link' ? saved.url : 'Saved Note',
    ...(saved.kind === 'link' ? { url: saved.url } : {}), updatedAt: saved.updatedAt,
    availability: current && refEqual(current.reference, reference) ? 'current' : 'changed', ...(current ? { currentRevision: current.reference.revision } : {}) };
   // Never turn an unavailable historical URL into the current item's URL.
   return { reference, title: `${reference.kind} · ${reference.id}`, subtitle: 'Saved version unavailable. Its reference is kept.', availability: 'missing', updatedAt: '', ...(current ? { currentRevision: current.reference.revision } : {}) };
  }
  if (!current) return { reference, title: `${reference.kind} · ${reference.id}`, subtitle: 'Source unavailable. Its reference is kept.', availability: 'missing', updatedAt: '' };
  const same = current.reference.revision === reference.revision && current.reference.sha256 === reference.sha256;
  return { ...current, reference, availability: same ? 'current' : 'changed', currentRevision: current.reference.revision };
 }
 private savedItem(ref: HomeReference): HomeItem | undefined {
  if ((ref.kind !== 'note' && ref.kind !== 'link') || ref.sha256 !== undefined) return undefined;
  const current = this.store.internalRead<HomeItem>(items + ref.id);
  const saved = current?.revision === ref.revision ? current : this.store.internalRead<HomeItem>(`home:library:version:item-save:${ref.id}:${ref.revision}`);
  return saved?.kind === ref.kind && saved.id === ref.id && saved.revision === ref.revision ? saved : undefined;
 }
 private current(ref: HomeReference): boolean {
  if (ref.kind === 'note' || ref.kind === 'link') { const item = this.store.internalRead<HomeItem>(items + ref.id);return !!item && item.kind === ref.kind && item.revision === ref.revision && ref.sha256 === undefined && !item.archived; }
  if (ref.kind === 'output') { const output = this.store.internalRead<AssistantOutput>('assistant:output:' + ref.id);return output?.state === 'ready' && output.version === ref.revision && !!output.file && output.file.sha256 === ref.sha256; }
  if (ref.kind === 'assignment') { const attempt = this.store.internalRead<AssignmentAttempt>('assignments:summary:' + ref.id);return attempt?.epoch === this.store.epoch && attempt.state === 'returned' && attempt.assignmentRevision === ref.revision && attempt.result?.disposition === 'visible' && attempt.result.file.sha256 === ref.sha256; }
  if (ref.sha256 !== undefined) return false;
  if (ref.kind === 'widget') { const layout = this.store.readEntity('layout', 'layout');return layout?.revision === ref.revision && layout.value.widgets.some(w => w.id === ref.id && (w.type === 'note' || w.type === 'links')); }
  const entity = this.store.readEntity(ref.kind, ref.id);return !!entity && entity.revision === ref.revision && !('archived' in entity.value && entity.value.archived) && !('trashed' in entity.value && entity.value.trashed) && !(ref.kind === 'project' && this.store.projectIsDeleted(ref.id));
 }
 state(device: string): HomeLibraryState {
  const all = this.store.internalList<HomeCollection>(collections), organization = this.organization(all);
  const byId = new Map(all.map(row => [row.id, row])), list = organization.collectionIds.map(id => byId.get(id)!);
  const resources = this.catalog(device), keys = new Set(resources.map(r => canonical(r.reference))), catalog = [...resources];
  for (const ref of list.flatMap(c => c.references)) if (!keys.has(canonical(ref))) { resources.push(this.resolve(device, ref, catalog)); keys.add(canonical(ref)); }
  return { epoch: this.store.epoch, collections: list, organization, items: this.store.internalList<HomeItem>(items), resources, ideaPreferences: this.store.internalRead<HomeIdeaPreferences>('home:ideas:preferences') ?? { revision: 0, saved: [], hidden: [] } };
 }
 private organization(all = this.store.internalList<HomeCollection>(collections)): HomeOrganization {
  const saved = this.store.internalRead<HomeOrganization>(organizationKey);
  if (saved) {
   if (!equal([...saved.collectionIds].sort(), all.map(c => c.id).sort())) throw new Fault(409, 'home_organization_changed', 'Collection order changed. Reload Library before organizing it.');
   return saved;
  }
  return { revision: 0, collectionIds: [...all].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(c => c.id) };
 }
 /** Called only inside admission, after validation, before changing collection rows. */
 private seedOrganization(newId?: string): HomeOrganization | undefined {
  const old = this.organization();
  if (old.revision && !newId) return undefined;
  return this.store.internalWrite(organizationKey, { revision: old.revision + 1, collectionIds: newId ? [...old.collectionIds, newId] : old.collectionIds });
 }
 private saveCollection(old: HomeCollection, change: Partial<Pick<HomeCollection, 'references' | 'pinned' | 'archived'>>, at: string): HomeCollection {
  const saved = { ...old, ...change, revision: old.revision + 1, updatedAt: at };
  this.store.internalWrite(`home:library:version:collection-save:${old.id}:${saved.revision}`, saved);
  return this.store.internalWrite(collections + old.id, saved);
 }
 private saveItem(id: string, value: HomeItemValue, revision: number, at: string): HomeItem {
  const saved = { ...value, id, revision, updatedAt: at } as HomeItem;
  this.store.internalWrite(`home:library:version:item-save:${id}:${revision}`, saved);
  return this.store.internalWrite(items + id, saved);
 }
 private guardedCollection(guard: { id: string; expectedRevision: number }, active = true): HomeCollection {
  const row = this.store.internalRead<HomeCollection>(collections + guard.id);
  if (!row || row.revision !== guard.expectedRevision || active && row.archived) throw new Fault(409, 'home_library_changed', 'This collection changed or was archived. Reload before organizing it.', row ? { id: row.id, revision: row.revision } : undefined);
  return row;
 }
 private recordInverse(device: string, operationId: string, type: Inverse['type'], inverse: Omit<Inverse, 'epoch' | 'device' | 'type'>): LibraryReceipt['undo'] {
  this.store.internalWrite(operationKey + operationId, { ...inverse, device, type, epoch: this.store.epoch } satisfies Inverse);
  return { operationId, expected: { collections: inverse.collections.map(c => ({ id: c.id, expectedRevision: c.revision })), organizationRevision: inverse.organization?.revision ?? null } };
 }
 private mutate(device: string, input: Mutation): LibraryReceipt {
  const at = new Date(this.now()).toISOString();
  const result: LibraryReceipt = { format: 1, operationId: input.requestId, epoch: input.epoch, type: input.type, appliedAt: at, changed: false, collections: [], createdItems: [], outcomes: [], undo: null };
  const inverse: Omit<Inverse, 'epoch' | 'device' | 'type'> = { collections: [], organization: null };
  const seed = () => { const organization = this.seedOrganization(); if (organization) result.organization = organization; };
  const change = (old: HomeCollection, references: HomeReference[]) => {
   if (equal(old.references, references)) return;
   const saved = this.saveCollection(old, { references }, at); result.collections.push(saved);
   inverse.collections.push({ id: old.id, revision: saved.revision, before: { references: old.references } });
  };
  if (input.type === 'items-capture') {
   const destination = this.guardedCollection(input.destination), all = this.store.internalList<HomeItem>(items);
   const urls = new Map<string, HomeReference>();
   for (const ref of destination.references) if (ref.kind === 'link') {
    const item = this.savedItem(ref);
    if (!item || item.kind !== 'link') throw new Fault(409, 'home_reference_conflict', 'A saved destination link version is unavailable. Review that reference before adding links.');
    const url = linkUrl(item.url); if (!urls.has(url)) urls.set(url, ref);
   }
   const batch = new Map<string, HomeReference>(), additions: HomeReference[] = [], pending: Array<{ id: string; value: HomeItemValue }> = [];
   for (const row of input.rows) {
    if (all.some(item => item.id === row.id)) throw new Fault(409, 'home_library_changed', 'A proposed item identity already exists. Reconcile its original request.');
    const url = row.value.kind === 'link' ? linkUrl(row.value.url) : undefined;
    if (url && url.length > 2048) throw new Fault(400, 'home_link_large', 'The normalized link exceeds the saved URL limit. No rows were saved.');
    const existing = url ? urls.get(url) : undefined, duplicate = url ? batch.get(url) : undefined;
    const reference: HomeReference = existing ?? duplicate ?? { kind: row.value.kind, id: row.id, revision: 1 };
    result.outcomes.push({ rowId: row.rowId, reference, disposition: existing ? 'already-in-destination' : duplicate ? 'duplicate-in-batch' : 'created-and-added' });
    if (existing || duplicate) continue;
    if (url) batch.set(url, reference);
    additions.push(reference); pending.push({ id: row.id, value: row.value.kind === 'link' ? { ...row.value, url: url! } : row.value });
   }
   if (destination.references.length + additions.length > 200 || all.length + pending.length > 300 || [...all, ...pending.map(p => p.value)].reduce((n, item) => n + item.body.length, 0) > 2_000_000) throw new Fault(507, 'home_library_limit', 'Library capacity is reached. No items or memberships were saved.');
   if (pending.length) {
    seed();
    result.createdItems = pending.map(row => this.saveItem(row.id, row.value, 1, at));
    change(destination, [...destination.references, ...additions]);
   }
  } else if (input.type === 'references-transfer') {
   const source = this.guardedCollection(input.source), destination = this.guardedCollection(input.destination);
   const additions: HomeReference[] = [];
   for (const ref of input.references) {
    if (!source.references.some(r => refEqual(r, ref))) throw new Fault(409, 'home_reference_conflict', 'The exact captured reference is not in the source collection.');
    const held = destination.references.find(r => homeReferenceKey(r) === homeReferenceKey(ref));
    if (held && !refEqual(held, ref)) throw new Fault(409, 'home_reference_conflict', 'The destination holds another version of this source. Review both captured versions.');
    result.outcomes.push({ reference: ref, disposition: held ? 'already-in-destination' : input.mode === 'move' ? 'moved' : 'added' });
    if (!held) additions.push(ref);
   }
   const position = input.before === null ? destination.references.length : destination.references.findIndex(ref => refEqual(ref, input.before!));
   if (position < 0) throw new Fault(409, 'home_reference_conflict', 'The exact destination position changed.');
   if (destination.references.length + additions.length > 200) throw new Fault(507, 'home_library_limit', 'The destination collection is full. No membership was moved.');
   if (additions.length) {
    seed();
    change(destination, [...destination.references.slice(0, position), ...additions, ...destination.references.slice(position)]);
    if (input.mode === 'move') change(source, source.references.filter(ref => !additions.some(added => refEqual(ref, added))));
   }
  } else if (input.type === 'references-order') {
   const old = this.guardedCollection(input.collection);
   if (!equal(old.references.map(canonical).sort(), input.references.map(canonical).sort())) throw new Fault(409, 'home_reference_conflict', 'Reordering requires every exact captured reference, including hidden results.');
   if (!equal(old.references, input.references)) { seed(); change(old, input.references); }
  } else if (input.type === 'collections-order') {
   const old = this.organization();
   if (old.revision !== input.expectedRevision || !equal([...old.collectionIds].sort(), [...input.collectionIds].sort())) throw new Fault(409, 'home_organization_changed', 'Collection order or membership changed. Reload before reordering.');
   if (!equal(old.collectionIds, input.collectionIds)) {
    result.organization = this.store.internalWrite(organizationKey, { revision: old.revision + 1, collectionIds: input.collectionIds });
    inverse.organization = { revision: result.organization.revision, collectionIds: old.collectionIds };
   }
  } else {
   const original = this.store.internalRead<Inverse>(operationKey + input.operationId);
   if (!original || original.device !== device || original.epoch !== input.epoch) throw new Fault(409, 'home_undo_conflict', 'Undo requires your confirmed original organization operation in this workspace.');
   if (this.store.internalRead(undoneKey + input.operationId)) throw new Fault(409, 'home_already_undone', 'This operation was already undone. Reconcile its saved result.');
   const expected = original.collections.map(c => ({ id: c.id, expectedRevision: c.revision })).sort((a, b) => a.id.localeCompare(b.id));
   if (!equal(expected, [...input.expected.collections].sort((a, b) => a.id.localeCompare(b.id))) || input.expected.organizationRevision !== (original.organization?.revision ?? null)) throw new Fault(409, 'home_undo_conflict', 'Undo must refer to the exact affected records and revisions.');
   const current = original.collections.map(c => this.store.internalRead<HomeCollection>(collections + c.id));
   if (current.some((c, index) => !c || c.revision !== original.collections[index].revision) || original.organization && this.organization().revision !== original.organization.revision) throw new Fault(409, 'home_undo_conflict', 'Affected Library organization changed after this operation. Your newer changes are kept.');
   result.collections = original.collections.map((c, index) => this.saveCollection(current[index]!, c.before, at));
   if (original.organization) result.organization = this.store.internalWrite(organizationKey, { revision: original.organization.revision + 1, collectionIds: original.organization.collectionIds });
   this.store.internalWrite(undoneKey + input.operationId, { operationId: input.requestId, epoch: input.epoch, device, appliedAt: at });
   result.changed = true; result.undoneOperationId = input.operationId; return result;
  }
  result.changed = result.collections.length > 0 || inverse.organization !== null;
  if (result.changed) result.undo = this.recordInverse(device, input.requestId, input.type, inverse);
  return result;
 }
 command(device: string, raw: unknown): HomeCollection | HomeItem | HomeIdeaPreferences | LibraryReceipt {
  const input = homeLibraryCommandSchema.parse(raw);
  return this.store.admit(device, input, { operation: 'home.library', ...input }, () => {
   if (input.type === 'preferences-save') { const old = this.store.internalRead<HomeIdeaPreferences>('home:ideas:preferences');if ((old?.revision ?? 0) !== input.expectedRevision) throw new Fault(409, 'home_preferences_changed', 'Idea preferences changed. Refresh before saving your preference.');return this.store.internalWrite('home:ideas:preferences', { ...input.value, revision: input.expectedRevision + 1 }); }
   if (input.type !== 'collection-save' && input.type !== 'item-save') return this.mutate(device, input);
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
   const at = new Date(this.now()).toISOString();
   if (input.type === 'item-save') return this.saveItem(input.id, input.value, input.expectedRevision + 1, at);
   this.seedOrganization(old ? undefined : input.id);
   const saved: HomeCollection = { ...input.value, id: input.id, revision: input.expectedRevision + 1, updatedAt: at };
   this.store.internalWrite(`home:library:version:collection-save:${input.id}:${saved.revision}`, saved);
   this.store.internalWrite(collections + input.id, saved);
   if (old && 'references' in old && old.title === saved.title && old.subtitle === saved.subtitle && old.icon === saved.icon) {
    const before: CollectionInverse['before'] = {};
    if (!equal(old.references, saved.references)) before.references = old.references;
    if (old.pinned !== saved.pinned) before.pinned = old.pinned;
    if (old.archived !== saved.archived) before.archived = old.archived;
    if (Object.keys(before).length) this.recordInverse(device, input.requestId, input.type, { collections: [{ id: saved.id, revision: saved.revision, before }], organization: null });
   }
   return saved;
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
