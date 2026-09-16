import { z } from 'zod';

export const removeConversationSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), conversationId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
export type RemoveConversation = z.infer<typeof removeConversationSchema>;
export type ConversationRemoval = RemoveConversation & { deviceId: string; nativeId: string | null; nativeKey: string; connectionGeneration: string; state: 'prepared' | 'unknown' | 'completed' | 'rejected'; message?: string; updatedAt: string };
