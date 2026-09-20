import { z } from 'zod';
import { assistantRequestSchema, type Conversation } from './assistant.js';
import type { Attachment } from './contracts.js';

export type VoiceProvider = {
  id: string;
  label: string;
  configured: boolean;
  models: string[];
  voices: string[];
  voicesByModel: Record<string, string[]>;
  browserSupported: boolean;
};

export const voiceStartSchema = assistantRequestSchema.extend({
  conversationId: z.string().uuid(), conversationRevision: z.number().int().positive(),
  projectRevision: z.number().int().nonnegative(), model: z.string().max(100).optional(), voice: z.string().max(100).optional(),
}).strict();
export const voiceActionSchema = assistantRequestSchema.extend({ attemptId: z.string().uuid() }).strict();
export const voiceOfferSchema = voiceActionSchema.extend({ sdp: z.string().startsWith('v=0').max(262144) }).strict();
export const voiceFinalSchema = z.object({ entryId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), role: z.enum(['user', 'assistant']), text: z.string().max(60000), ordinal: z.number().int().nonnegative(), timestamp: z.number().int().nonnegative() }).strict();
export const voiceFinalsSchema = voiceActionSchema.extend({ entries: z.array(voiceFinalSchema).min(1).max(100) }).strict();
export const voiceConsultSchema = voiceActionSchema.extend({ callId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name: z.literal('openclaw_agent_consult'), args: z.object({ question: z.string().min(1).max(16000), context: z.string().max(16000).optional(), responseStyle: z.string().max(1000).optional(), confirmationId: z.string().max(256).optional() }).strict() }).strict();
export type VoiceTarget = { memory?: import('./memory.js').MemorySnapshot; conversation: Conversation & { nativeId: string }; project: { id: string; revision: number; name: string; purpose: string; attachments?: Attachment[] } | null; refineFile?: Attachment };
export type VoiceSource = { file: Attachment; origin: 'project' | 'refinement' | 'conversation'; state: 'included' | 'native' | 'preparing' | 'unsupported' | 'too_large' | 'unavailable' };
export const voiceSourceLabels: Record<VoiceSource['state'], string> = { included: 'Available to voice', native: 'Available through file tools', preparing: 'Preparing for voice', unsupported: 'Use text chat for this format', too_large: 'Too large for voice; use text chat', unavailable: 'File unavailable; review its source' };
export type VoiceFinal = z.infer<typeof voiceFinalSchema> & { saved: boolean };
export type VoiceConsult = { callId: string; state: 'dispatching' | 'running' | 'completed' | 'failed' | 'unknown'; runId?: string; sessionKey?: string; text?: string };
export type VoiceAttempt = {
  id: string; requestId: string; epoch: string; deviceId: string; createdAt: string; target: VoiceTarget;
  state: 'preparing' | 'ready' | 'connecting' | 'active' | 'ending' | 'ended' | 'interrupted' | 'failed';
  message: string; model?: string; voice?: string; context: string; contextDigest: string;
  entries: VoiceFinal[]; consults: VoiceConsult[];
  sources?: VoiceSource[];
};
export type VoiceCatalog = {
  state: 'disconnected' | 'unconfigured' | 'unverified' | 'available';
  message: string;
  providers: VoiceProvider[];
};
