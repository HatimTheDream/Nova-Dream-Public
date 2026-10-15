import { z } from 'zod';
import type { AgentAccess } from './agent-capabilities.js';

export const agentActivityPreferencesSchema = z.object({
  personality: z.enum(['thoughtful', 'curious', 'focused']),
  traits: z.string().trim().max(240),
  initiative: z.enum(['on-request', 'proactive']),
  sleep: z.enum(['awake', 'after-work', 'asleep']),
  intervalMinutes: z.number().int().min(15).max(1440),
  dailyLimit: z.number().int().min(1).max(12),
}).strict();
export type AgentActivityPreferences = z.infer<typeof agentActivityPreferencesSchema>;
export const defaultAgentActivityPreferences = (): AgentActivityPreferences => ({
  personality: 'thoughtful', traits: '', initiative: 'on-request', sleep: 'awake', intervalMinutes: 30, dailyLimit: 4,
});
export type AgentActivityPreference = {
  agentId: string; revision: number; value: AgentActivityPreferences; updatedAt: number;
  nextConversationAt: number | null; conversationsToday: number;
  busy?: boolean;
};
const envelope = { requestId: z.uuid(), epoch: z.uuid(), agentId: z.string().min(1).max(100), expectedRevision: z.number().int().nonnegative() };
export const agentActivityCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('preferences'), value: agentActivityPreferencesSchema.omit({ sleep: true }) }).strict(),
  z.object({ ...envelope, type: z.literal('wake') }).strict(),
  z.object({ ...envelope, type: z.literal('sleep'), pauseMeeting: z.object({ id: z.uuid(), revision: z.number().int().positive() }).strict().optional() }).strict(),
  z.object({ ...envelope, type: z.literal('interact'), action: z.enum(['hello', 'coffee', 'office', 'visit']) }).strict(),
]);
export type AgentActivityCommand = z.infer<typeof agentActivityCommandSchema>;
export type AgentActivityEvent = {
  id: string; agentId: string; at: number; action: 'hello' | 'coffee' | 'office' | 'visit' | 'sleep' | 'wake' | 'conversation';
  reason: string; meetingId?: string;
  origin?: 'owner' | 'initiative' | 'lifecycle';
};
export type AgentWorkReference = {
  assignmentId: string; assignmentRevision: number; title: string;
  attemptId?: string; attemptUpdatedAt?: number; attemptState?: string; resultFileId?: string;
  capturedAssignmentRevision?: number; brief?: string; expectedOutput?: string; resultExcerpt?: string;
  briefTruncated?: boolean; expectedOutputTruncated?: boolean; resultExcerptTruncated?: boolean; unavailable?: string;
};
export type AgentConversationParticipant = {
  agentId: string; agentRevision: number; preferenceRevision: number;
  preferences: AgentActivityPreferences; access: AgentAccess; work?: AgentWorkReference;
};
/** Constructed only by the service after explicit, versioned Proactive opt-in. */
export type AgentConversationCapture = {
  id: string; epoch: string; at: number; participants: AgentConversationParticipant[];
};
export type AgentActivityState = { preferences: AgentActivityPreference[]; events: AgentActivityEvent[]; conversations: { id: string; at: number; agentIds: string[]; state: 'prepared' | 'started' | 'blocked'; meetingId?: string; message?: string }[]; sleepRequests: { id: string; agentId: string; meetingId: string; state: 'pending' | 'requested' | 'review'; message?: string }[] };
export const personalityLabels = { thoughtful: 'Calm & Thoughtful', curious: 'Curious & Exploratory', focused: 'Focused & Precise' } as const;
