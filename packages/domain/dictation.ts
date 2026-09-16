import { z } from 'zod';
import { assistantRequestSchema } from './assistant.js';
export const dictationStartSchema = assistantRequestSchema.extend({ draftId: z.string().min(1).max(200) }).strict();
export const dictationActionSchema = assistantRequestSchema.extend({ attemptId: z.string().uuid() }).strict();
export const dictationAudioSchema = dictationActionSchema.extend({ sequence: z.number().int().nonnegative(), audio: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(24000) }).strict();
export type DictationAttempt = { id: string; requestId: string; epoch: string; deviceId: string; draftId: string; generation: string; state: 'preparing' | 'listening' | 'ending' | 'ended' | 'failed'; route?: 'browser'; cleanupPending?: boolean; nativeKey?: string; browserNativeId?: string; nativeId?: string; transcriptId?: string; encoding?: 'mulaw' | 'pcm16'; sampleRate?: number; text: string; final: boolean; turns?: { id: string; text: string; final: boolean }[]; error?: string; sequence: number; updatedAt: number };
