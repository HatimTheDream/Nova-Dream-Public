import { z } from 'zod';
import { canonical } from '../../packages/domain/contracts.js';
import { homeShelvesSchema, type HomeCollection, type HomeReference, type HomeShelves, type HomeShelvesCommand, type HomeShelvesReceipt, type HomeShelvesState } from '../../packages/domain/home-library.js';
import { emptyHomeShelves, exactHomeReference, homeReferenceKey, homeSpaceNameKey } from '../../packages/domain/home-library-view.js';
import { Fault, type Store } from './store.js';

export const shelvesKey = 'home:library:shelves';
// Old library-undo cannot locate or consume this distinct inverse namespace.
export const shelvesOperationKey = 'home:library:shelves-operation:', shelvesUndoneKey = 'home:library:shelves-undone:';
const inverseSchema = z.object({
 format: z.literal(1), operationId: z.uuid(), epoch: z.uuid(), device: z.string().min(1),
 afterRevision: z.number().int().positive(), before: homeShelvesSchema,
}).strict().refine(value => value.afterRevision === value.before.revision + 1);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Called only by HomeLibrary; writes execute inside its original Store.admit. */
export class HomeLibraryShelves {
 constructor(private store: Store, private current: (ref: HomeReference) => boolean, private now = Date.now) {}
 state(): HomeShelvesState {
  const raw = this.store.internalRead<unknown>(shelvesKey);
  if (raw === undefined) return { status: 'ready', value: emptyHomeShelves() };
  const parsed = homeShelvesSchema.safeParse(raw);
  return parsed.success ? { status: 'ready', value: parsed.data } : { status: 'needs-review',
   message: 'Saved Spaces and Up Next need review. Their original data is kept. Collections, notes and sources are still available.' };
 }
 private read(): HomeShelves {
  const state = this.state();
  if (state.status !== 'ready') throw new Fault(409, 'home_shelves_unreadable', state.message);
  return state.value;
 }
 command(device: string, input: HomeShelvesCommand): HomeShelvesReceipt {
  const old = this.read();
  if (old.revision !== input.expectedRevision) throw new Fault(409, 'home_shelves_changed', 'Spaces or Up Next changed. Reload before organizing them; your writing is kept.');
  const at = new Date(this.now()).toISOString();
  const result: HomeShelvesReceipt = { format: 2, kind: 'shelves', operationId: input.requestId, epoch: input.epoch,
   type: input.type, appliedAt: at, changed: false, shelves: old, undo: null };
  let next = structuredClone(old);
  if (input.type === 'shelves-undo') {
   const parsed = inverseSchema.safeParse(this.store.internalRead(shelvesOperationKey + input.operationId));
   if (!parsed.success || parsed.data.operationId !== input.operationId || parsed.data.device !== device ||
       parsed.data.epoch !== input.epoch || parsed.data.afterRevision !== old.revision)
    throw new Fault(409, 'home_shelves_undo_conflict', 'Undo requires your exact confirmed Spaces or Up Next operation with no later organization changes.');
   if (this.store.internalRead(shelvesUndoneKey + input.operationId) !== undefined)
    throw new Fault(409, 'home_already_undone', 'This organization change was already undone. Reconcile its original result.');
   next = { ...parsed.data.before, revision: old.revision + 1 };
   this.store.internalWrite(shelvesKey, homeShelvesSchema.parse(next));
   this.store.internalWrite(shelvesUndoneKey + input.operationId, { operationId: input.requestId, epoch: input.epoch, device, appliedAt: at });
   return { ...result, changed: true, shelves: next, undoneOperationId: input.operationId };
  }
  if (input.type === 'space-save') {
   if (next.spaces.some(space => space.id !== input.id && homeSpaceNameKey(space.name) === homeSpaceNameKey(input.name)))
    throw new Fault(409, 'home_space_name', 'Another active or archived Space has this name. Keep a distinct name.');
   const space = next.spaces.find(space => space.id === input.id);
   if (space) space.name = input.name;
   else {
    if (next.spaces.length >= 32) throw new Fault(507, 'home_shelves_limit', 'All 32 Space slots are kept, including archived Spaces. Rename or reuse an existing Space.');
    next.spaces.push({ id: input.id, name: input.name, archived: false });
   }
  } else if (input.type === 'space-archive') {
   const space = next.spaces.find(space => space.id === input.id);
   if (!space) throw new Fault(409, 'home_space_missing', 'The original Space is unavailable. Existing collections are kept.');
   space.archived = input.archived;
  } else if (input.type === 'collection-assign') {
   const collection = this.store.internalRead<HomeCollection>('home:library:collection:' + input.collection.id);
   if (!collection || collection.revision !== input.collection.expectedRevision || collection.archived)
    throw new Fault(409, 'home_library_changed', 'This collection changed or was archived. Reload before moving it to a Space.');
   if (input.spaceId !== null && !next.spaces.some(space => space.id === input.spaceId && !space.archived))
    throw new Fault(409, 'home_space_missing', 'Choose an active destination Space or Unassigned.');
   const assignment = next.assignments.find(row => row.collectionId === collection.id);
   if (input.spaceId === null) next.assignments = next.assignments.filter(row => row.collectionId !== collection.id);
   else if (assignment) assignment.spaceId = input.spaceId;
   else {
    if (next.assignments.length >= 100) throw new Fault(507, 'home_shelves_limit', 'The 100 saved assignments are kept. Unassign a collection before adding another.');
    next.assignments.push({ collectionId: collection.id, spaceId: input.spaceId });
   }
  } else if (input.type === 'up-next-add') {
   const held = next.upNext.find(ref => homeReferenceKey(ref) === homeReferenceKey(input.reference));
   if (held && !exactHomeReference(held, input.reference))
    throw new Fault(409, 'home_reference_conflict', 'Up Next keeps another version of this source. Review it, then explicitly remove and add the desired version.');
   // An exact duplicate remains a no-op even if that saved source later changed.
   if (!held) {
    if (!this.current(input.reference)) throw new Fault(409, 'home_source_changed', 'This source changed or disappeared. Review its exact saved version before adding it.');
    if (next.upNext.length >= 200) throw new Fault(507, 'home_shelves_limit', 'Up Next keeps 200 sources. Remove an entry before adding another; its source will remain saved.');
    next.upNext.push(input.reference);
   }
  } else if (input.type === 'up-next-remove') {
   const held = next.upNext.find(ref => homeReferenceKey(ref) === homeReferenceKey(input.reference));
   if (held && !exactHomeReference(held, input.reference))
    throw new Fault(409, 'home_reference_conflict', 'The kept Up Next version changed. Review the original entry before removing it.');
   next.upNext = next.upNext.filter(ref => !exactHomeReference(ref, input.reference));
  } else {
   if (!equal(next.upNext.map(canonical).sort(), input.references.map(canonical).sort()))
    throw new Fault(409, 'home_reference_conflict', 'Reordering requires every exact Up Next entry, including changed, missing and hidden sources.');
   next.upNext = input.references;
  }
  if (equal(old, next)) return result;
  next.revision = old.revision + 1;
  const saved = homeShelvesSchema.parse(next);
  this.store.internalWrite(shelvesKey, saved);
  this.store.internalWrite(shelvesOperationKey + input.requestId, {
   format: 1, operationId: input.requestId, epoch: input.epoch, device, afterRevision: saved.revision, before: old,
  });
  return { ...result, changed: true, shelves: saved, undo: { operationId: input.requestId, expectedRevision: saved.revision } };
 }
}
