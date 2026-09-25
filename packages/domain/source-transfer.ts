import { z } from 'zod';
import { attachmentSchema } from './contracts.js';

export const sourcePluginId = 'edition3-sources';
export const sourceTransferVersion = '2026.9.2';
export const sourceTransferVersions = ['2026.9.2', '2026.9.6'] as const;
export const supportsSourceTransferRuntime = (version: string) => sourceTransferVersions.some(value => value === version);
export const sourceTransferLimit = 8 * 1024 * 1024;
export const sourceMimeTypes: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const sourceMime = (name: string) => sourceMimeTypes[name.split('.').pop()?.toLowerCase() ?? ''];
export const sourceTargetSchema = z.object({ epoch: z.string().uuid(), nativeKey: z.string().regex(/^(?:(?:agent:main:)?e3:|agent:main:dashboard:e3-)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/), nativeId: z.string().uuid() }).strict();
export const sourceStageSchema = sourceTargetSchema.extend({ file: attachmentSchema, content: z.string().max(Math.ceil(sourceTransferLimit / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict();
export const sourceReferenceSchema = sourceTargetSchema.extend({ file: attachmentSchema, mimeType: z.string().min(1), mediaId: z.string().min(1).max(300), path: z.string().min(1).max(4096) }).strict();
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
