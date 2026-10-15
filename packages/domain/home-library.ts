import { z } from 'zod';
import type { WorkMode } from './work-mode.js';
import { homeIcons, homeIdeaIds, homeReferenceKey } from './home-library-view.js';
export { homeIcons, homeIdeaIds, homeReferenceKey, homeQuote, homeIdeaScope } from './home-library-view.js';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/);
const revision = z.number().int().positive();
export const homeReferenceSchema = z.object({ kind: z.enum(['note', 'link', 'content', 'project', 'task', 'output', 'assignment', 'widget']), id, revision, sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
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
export type HomeLibraryState = { epoch: string; collections: HomeCollection[]; items: HomeItem[]; resources: HomeResource[]; ideaPreferences: HomeIdeaPreferences };
const envelope = { requestId: z.uuid(), epoch: z.uuid() };
export const homeLibraryCommandSchema = z.discriminatedUnion('type', [
 z.object({ ...envelope, type: z.literal('collection-save'), id, expectedRevision: z.number().int().nonnegative(), value: homeCollectionValueSchema }).strict(),
 z.object({ ...envelope, type: z.literal('item-save'), id, expectedRevision: z.number().int().nonnegative(), value: homeItemValueSchema }).strict(),
 z.object({ ...envelope, type: z.literal('preferences-save'), expectedRevision: z.number().int().nonnegative(), value: homeIdeaChoicesSchema }).strict(),
]);
export type HomeLibraryCommand = z.infer<typeof homeLibraryCommandSchema>;
export const homeCaptureSchema = z.object({ ...envelope, references: z.array(homeReferenceSchema).max(20).refine(refs => new Set(refs.map(homeReferenceKey)).size === refs.length) }).strict();
export type HomeCaptureRequest = z.infer<typeof homeCaptureSchema>;
export type HomeSourceCapture = { id: string; epoch: string; createdAt: string; sources: HomeResource[] };
export type HomeAssistantHandoff = { title: string; text: string; space: 'chat' | 'work'; workMode?: WorkMode; projectId: string | null; sourceCaptureId?: string; handoffId?: string; sourceRefs: HomeReference[]; ideaId?: string; selectedTaskIds?: string[]; outputs?: string[] };
