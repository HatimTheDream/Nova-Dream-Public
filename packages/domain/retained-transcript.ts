import { z } from 'zod';
import { assistantRequestSchema } from './assistant.js';
import type { Attachment } from './contracts.js';

export const retainedTranscriptRequest = assistantRequestSchema.extend({
  conversationId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RetainedTranscriptReview = {
  conversationId: string; title: string; digest: string; complete: boolean;
  capturedAt?: string; messageCount: number; attachmentCount: number; bytes: number;
};
export type RetainedTranscriptExport = { review: RetainedTranscriptReview; file: Attachment };
