import { z } from 'zod';
import type { WorkMode } from './work-mode.js';
import { homeIcons, homeIdeaIds, homeReferenceKey } from './home-library-view.js';
export { homeIcons, homeIdeaIds, homeReferenceKey, exactHomeReference, normalizeHomeUrl, homeQuote, homeIdeaScope } from './home-library-view.js';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+(?![\s\S])/);
const revision = z.number().int().positive();
const expectedRevision = z.number().int().nonnegative();
export const homeReferenceSchema = z.object({ kind: z.enum(['note', 'link', 'content', 'project', 'task', 'output', 'assignment', 'widget']), id, revision, sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type HomeReference = z.infer<typeof homeReferenceSchema>;
export const homeCollectionValueSchema = z.object({ title: z.string().trim().min(1).max(100), subtitle: z.string().max(240), icon: z.enum(homeIcons), pinned: z.boolean(), archived: z.boolean(), references: z.array(homeReferenceSchema).max(200).refine(refs => new Set(refs.map(homeReferenceKey)).size === refs.length, 'Keep each source once.') }).strict();
export type HomeCollectionValue = z.infer<typeof homeCollectionValueSchema>;
export type HomeCollection = HomeCollectionValue & { id: string; revision: number; updatedAt: string };
export const homeItemValueSchema = z.discriminatedUnion('kind', [
 z.object({ kind: z.literal('note'), title: z.string().trim().min(1).max(150), body: z.string().max(100000), archived: z.boolean() }).strict(),
 z.object({ kind: z.literal('link'), title: z.string().trim().min(1).max(150), url: z.string().trim().url().max(2048).refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }, 'Use an http or https link without credentials.'), body: z.string().max(10000), archived: z.boolean() }).strict(),
]);
export type HomeItemValue = z.infer<typeof homeItemValueSchema>;
export type HomeItem = HomeItemValue & { id: string; revision: number; updatedAt: string };
export type HomeResource = { reference: HomeReference; title: string; subtitle: string; text?: string; url?: string; updatedAt: string; availability: 'current' | 'changed' | 'missing'; currentRevision?: number };
export const homeIdeaChoicesSchema = z.object({ saved: z.array(z.enum(homeIdeaIds)).max(4), hidden: z.array(z.enum(homeIdeaIds)).max(4) }).strict();
export type HomeIdeaPreferences = z.infer<typeof homeIdeaChoicesSchema> & { revision: number };
export const homeOrganizationSchema = z.object({ revision: expectedRevision, collectionIds: z.array(id).max(100).refine(ids => new Set(ids).size === ids.length, 'Keep each collection once.') }).strict();
export type HomeOrganization = z.infer<typeof homeOrganizationSchema>;
export const homeCollectionGuardSchema = z.object({ id, expectedRevision }).strict();
export type CollectionGuard = z.infer<typeof homeCollectionGuardSchema>;
const guardedCollections = z.array(homeCollectionGuardSchema).max(2).refine(guards => new Set(guards.map(guard => guard.id)).size === guards.length, 'Keep each collection guard once.');
export const homeLibraryUndoSchema = z.object({ operationId: z.uuid().length(36), expected: z.object({ collections: guardedCollections, organizationRevision: expectedRevision.nullable() }).strict() }).strict();
export type HomeLibraryUndo = z.infer<typeof homeLibraryUndoSchema>;
export const homeCaptureRowSchema = z.object({ rowId: id, id, value: homeItemValueSchema.refine(value => !value.archived, 'Capture an active item.') }).strict();
export type HomeCaptureRow = z.infer<typeof homeCaptureRowSchema>;
export type HomeLibraryState = { epoch: string; collections: HomeCollection[]; items: HomeItem[]; resources: HomeResource[]; ideaPreferences: HomeIdeaPreferences; organization: HomeOrganization };
const envelope = { requestId: z.uuid().length(36), epoch: z.uuid().length(36) };
const references = (minimum: number) => z.array(homeReferenceSchema).min(minimum).max(200).refine(refs => new Set(refs.map(homeReferenceKey)).size === refs.length, 'Keep each source once.');
export const homeLibraryCommandSchema = z.discriminatedUnion('type', [
 z.object({ ...envelope, type: z.literal('collection-save'), id, expectedRevision, value: homeCollectionValueSchema }).strict(),
 z.object({ ...envelope, type: z.literal('item-save'), id, expectedRevision, value: homeItemValueSchema }).strict(),
 z.object({ ...envelope, type: z.literal('preferences-save'), expectedRevision, value: homeIdeaChoicesSchema }).strict(),
 z.object({ ...envelope, type: z.literal('items-capture'), destination: homeCollectionGuardSchema, rows: z.array(homeCaptureRowSchema).min(1).max(20).refine(rows => new Set(rows.map(row => row.id)).size === rows.length && new Set(rows.map(row => row.rowId)).size === rows.length, 'Use a distinct row and new item ID for each capture.') }).strict(),
 z.object({ ...envelope, type: z.literal('collections-order'), expectedRevision, collectionIds: homeOrganizationSchema.shape.collectionIds }).strict(),
 z.object({ ...envelope, type: z.literal('references-transfer'), mode: z.enum(['move', 'copy']), source: homeCollectionGuardSchema, destination: homeCollectionGuardSchema, references: references(1), before: homeReferenceSchema.nullable() }).strict().refine(value => value.source.id !== value.destination.id, 'Choose a different destination collection.'),
 z.object({ ...envelope, type: z.literal('references-order'), collection: homeCollectionGuardSchema, references: references(0) }).strict(),
 z.object({ ...envelope, type: z.literal('library-undo'), ...homeLibraryUndoSchema.shape }).strict(),
]);
export type HomeLibraryCommand = z.infer<typeof homeLibraryCommandSchema>;
export type HomeLibraryMutation = Extract<HomeLibraryCommand, { type: 'items-capture' | 'collections-order' | 'references-transfer' | 'references-order' | 'library-undo' }>;
export type HomeLibraryOutcome = { rowId?: string; reference: HomeReference; disposition: 'created-and-added' | 'added' | 'moved' | 'already-in-destination' | 'duplicate-in-batch' };
export type HomeLibraryReceipt = {
 format: 1; operationId: string; epoch: string; type: HomeLibraryMutation['type']; appliedAt: string; changed: boolean;
 collections: HomeCollection[]; organization?: HomeOrganization; createdItems: HomeItem[]; outcomes: HomeLibraryOutcome[]; undo: HomeLibraryUndo | null; undoneOperationId?: string;
};
export type LibraryReceipt = HomeLibraryReceipt;
export type HomeLibraryResult = HomeCollection | HomeItem | HomeIdeaPreferences | HomeLibraryReceipt;
export type HomeLibraryJournalOwner = { deviceId: string; epoch: string; windowId: string };
/** The exact command survives a lost response; this record never authorizes a new request. */
export type HomeLibraryJournal = HomeLibraryJournalOwner & { format: 1; command: HomeLibraryCommand; uncertain: boolean };
export const homeCaptureSchema = z.object({ ...envelope, references: z.array(homeReferenceSchema).max(20).refine(refs => new Set(refs.map(homeReferenceKey)).size === refs.length) }).strict();
export type HomeCaptureRequest = z.infer<typeof homeCaptureSchema>;
export type HomeSourceCapture = { id: string; epoch: string; createdAt: string; sources: HomeResource[] };
export type HomeAssistantHandoff = { title: string; text: string; space: 'chat' | 'work'; workMode?: WorkMode; projectId: string | null; sourceCaptureId?: string; handoffId?: string; sourceRefs: HomeReference[]; ideaId?: string; selectedTaskIds?: string[]; outputs?: string[] };
