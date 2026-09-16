import { z } from 'zod';
import { attachmentSchema } from './contracts.js';
export const readableSourceLimit = 8 * 1024 * 1024;
export const sourceReadSchema = z.object({ fileId: z.string().uuid(), page: z.number().int().min(1).max(1000).default(1), view: z.enum(['text', 'image']).default('text') }).strict();
export type CapturedSourceFile = { file: z.infer<typeof attachmentSchema>; origins: string[] };
export type SourceReading = {
  file: z.infer<typeof attachmentSchema>; origins: string[];
  page: number; pages: number; view: 'text' | 'image'; text?: string;
  image?: { mimeType: 'image/jpeg'; data: string; width: number; height: number };
  truncated: boolean; notes: string[];
};
export const isBinarySource = (name: string) => /\.(pdf|png|jpe?g|webp)$/i.test(name);
