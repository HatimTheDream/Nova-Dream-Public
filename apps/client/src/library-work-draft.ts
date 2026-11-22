import type { Snapshot } from '../../../packages/domain/contracts';
import type { HomeReference } from '../../../packages/domain/home-library';
import { exactHomeReference, isHomeCollectionDraft } from '../../../packages/domain/home-library-view';
import type { LibraryWorkOrigin } from '../../../packages/domain/work-library-origin';
import type { WorkSourceSelection } from '../../../packages/domain/work-sources';
import { libraryView } from './home-library-navigation';
export type { LibraryWorkOrigin };

export type LibraryWorkStart = { origin: LibraryWorkOrigin; references: HomeReference[] };
type Scope = Pick<Snapshot, 'deviceId' | 'epoch'>;
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'length' | 'key'>;
export type WorkStartRequest = {
  planRequestId: string; startRequestId: string; agentRevision: number; projectRevision: number | null;
  stage: 'save-plan' | 'start' | 'check-start';
};
export type LibraryWorkDraft = {
  id: string; origin: LibraryWorkOrigin; originalSources: HomeReference[];
  title: string; brief: string; projectId: string | null; agentId: string | null;
  sources: WorkSourceSelection[]; planRevision: number; updatedAt: number;
  pending?: WorkStartRequest; attemptId?: string; planConflict?: true;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const idPrefix = 'library-work:';
const prefix = (scope: Scope) => 'e3:library-work:' + scope.deviceId + ':' + scope.epoch + ':';
function draftKey(scope: Scope, id: string) {
  if (!id.startsWith(idPrefix) || !uuid.test(id.slice(idPrefix.length))) throw Error('This assignment draft ID is unavailable.');
  return prefix(scope) + id;
}
export const libraryAssignmentId = (draftId: string) => 'assignment:' + draftId.slice(idPrefix.length);
const validRefs = (references: unknown): references is HomeReference[] =>
  isHomeCollectionDraft({ title: '', subtitle: '', icon: 'folder', pinned: false, archived: false, references });
function validOrigin(origin: LibraryWorkOrigin | undefined) {
  return !!origin && !!libraryView(origin.view) && Number.isFinite(origin.scrollTop) && origin.scrollTop >= 0;
}
function validDraft(draft: LibraryWorkDraft, id: string) {
  if (!draft || draft.id !== id || !validOrigin(draft.origin) || !validRefs(draft.originalSources) || !Array.isArray(draft.sources)
      || !validRefs(draft.sources.map(s => s?.reference)) || typeof draft.title !== 'string' || typeof draft.brief !== 'string'
      || !(draft.agentId === null || typeof draft.agentId === 'string') || !(draft.projectId === null || typeof draft.projectId === 'string')
      || !Number.isSafeInteger(draft.planRevision) || draft.planRevision < 0 || !Number.isFinite(draft.updatedAt)) return false;
  if (draft.sources.some(s => s.allowReferenceOnly !== undefined && typeof s.allowReferenceOnly !== 'boolean' ||
      s.confirmedAgainst !== undefined && (!validRefs([s.confirmedAgainst]) || s.confirmedAgainst.id !== s.reference.id || s.confirmedAgainst.kind !== s.reference.kind))) return false;
  const p = draft.pending;
  return (draft.planConflict === undefined || draft.planConflict === true && !p) && (!draft.attemptId || uuid.test(draft.attemptId)) && (!p || ['save-plan','start','check-start'].includes(p.stage)
    && uuid.test(p.planRequestId) && uuid.test(p.startRequestId) && Number.isSafeInteger(p.agentRevision) && p.agentRevision > 0
    && (p.projectRevision === null || Number.isSafeInteger(p.projectRevision) && p.projectRevision > 0));
}
export function readLibraryWorkDraft(scope: Scope, id: string, storage?: Storage): LibraryWorkDraft | undefined {
  const raw = (storage ?? localStorage).getItem(draftKey(scope, id));
  if (raw === null) return;
  const value = JSON.parse(raw) as LibraryWorkDraft;
  if (!validDraft(value, id)) throw Error('This kept assignment could not be read. Its original writing is preserved.');
  return value;
}
export function keepLibraryWorkStart(scope: Scope, id: string, initial: LibraryWorkStart, storage?: Storage): boolean {
  try {
    const store = storage ?? localStorage;
    if (!validOrigin(initial.origin) || !validRefs(initial.references) || !initial.references.length || readLibraryWorkDraft(scope, id, store)) return false;
    const draft: LibraryWorkDraft = { id, origin: initial.origin, originalSources: initial.references, sources: initial.references.map(reference => ({reference})),
      title: '', brief: '', agentId: null, projectId: null, planRevision: 0, updatedAt: Date.now() };
    store.setItem(draftKey(scope, id), JSON.stringify(draft));
    return true;
  } catch { return false; }
}
/** Each editor compares with the exact last version it opened or kept. */
export function updateLibraryWorkDraft(scope: Scope, prior: LibraryWorkDraft, next: LibraryWorkDraft, storage?: Storage) {
  const store = storage ?? localStorage, key = draftKey(scope, prior.id);
  if (next.id !== prior.id || !validDraft(next, prior.id) || store.getItem(key) !== JSON.stringify(prior))
    throw Error('This draft changed in another window. Your writing is still here. Reopen the kept version or keep a separate copy.');
  const updated = {...next, updatedAt: Date.now()};
  store.setItem(key, JSON.stringify(updated));
  return updated;
}
export function copyLibraryWorkDraft(scope: Scope, source: LibraryWorkDraft, newId: string, storage?: Storage) {
  const store = storage ?? localStorage;
  if (source.pending || source.attemptId || readLibraryWorkDraft(scope, newId, store)) throw Error('This preparation cannot be copied to a new draft.');
  const copy: LibraryWorkDraft = {id:newId, origin:source.origin, originalSources:source.originalSources, sources:source.sources,
    title:source.title, brief:source.brief, projectId:source.projectId, agentId:source.agentId, planRevision:0, updatedAt:Date.now()};
  if (!validDraft(copy,newId)) throw Error('This preparation could not be verified.');
  store.setItem(draftKey(scope,newId),JSON.stringify(copy));
  return copy;
}
export function listLibraryWorkDrafts(scope: Scope, storage?: Storage): LibraryWorkDraft[] {
  const result: LibraryWorkDraft[] = [];
  try {
    const store = storage ?? localStorage, start = prefix(scope);
    for (let i=0; i<store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(start)) continue;
      try { const draft = readLibraryWorkDraft(scope, key.slice(start.length), store); if (draft && !draft.attemptId) result.push(draft); }
      catch { /* Preserve unreadable entries for their original editor. */ }
    }
  } catch { /* Browser storage may be unavailable. */ }
  return result.sort((a,b)=>b.updatedAt-a.updatedAt);
}
export function existingLibraryWorkDraft(scope: Scope, initial: LibraryWorkStart, storage?: Storage): string | undefined {
  return listLibraryWorkDrafts(scope, storage).find(d => d.origin.view.selection?.collectionId === initial.origin.view.selection?.collectionId
    && d.originalSources.length === initial.references.length && d.originalSources.every(r=>initial.references.some(s=>exactHomeReference(r,s))))?.id;
}
export function readLibraryWorkOrigin(snapshot: Snapshot, assignmentId: string): LibraryWorkOrigin | undefined {
  const durable = snapshot.records?.assignment.find(plan=>plan.id===assignmentId)?.value.workOrigin;
  if (validOrigin(durable)) return durable;
  if (!assignmentId.startsWith('assignment:')) return;
  try { return readLibraryWorkDraft(snapshot, idPrefix + assignmentId.slice('assignment:'.length))?.origin; }
  catch { return; }
}
