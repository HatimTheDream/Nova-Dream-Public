import { z } from 'zod';
import { saveOutputSchema } from './assistant.js';

export const messagePinSchema = saveOutputSchema.omit({ name: true }).extend({
  role: z.enum(['user', 'assistant']), pinned: z.boolean(), expectedRevision: z.number().int().nonnegative(),
}).strict();
export type MessagePin = { id: string; revision: number; conversationId: string; nativeId: string; messageId: string; messageHash: string; role: 'user' | 'assistant'; pinned: boolean; excerpt: string; updatedAt: string };
