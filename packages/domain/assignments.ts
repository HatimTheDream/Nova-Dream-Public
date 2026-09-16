import { z } from 'zod';
import type { Entity, Attachment, Project } from './contracts.js';
import type { Assignment, AgentDesign, Contact, Content } from './workspace-records.js';
import type { AssignmentRoutineOrigin } from './agent-routines.js';

export const assignmentStartSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), assignmentId: z.string().min(1).max(100), revision: z.number().int().positive(), projectRevision: z.number().int().positive().nullable() }).strict();
export const assignmentStopSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), attemptId: z.string().uuid() }).strict();
export const assignmentAcknowledgeSchema = assignmentStopSchema.extend({ understandUnconfirmed: z.literal(true) });
export type AssignmentStart = z.infer<typeof assignmentStartSchema>;
export type AssignmentAttemptState = 'prepared' | 'dispatching' | 'running' | 'stopping' | 'returned' | 'failed' | 'cancelled' | 'unknown';
export const assignmentTerminal = (state: AssignmentAttemptState) => ['returned', 'failed', 'cancelled'].includes(state);
export type AssignmentAttempt = {
  id: string; epoch: string; deviceId: string; assignmentId: string; assignmentRevision: number; title: string;
  agentId: string; agentRevision: number; agentName: string; projectId: string | null;
  createdAt: number; updatedAt: number; deadlineAt: number; state: AssignmentAttemptState;
  stopReason?: 'owner' | 'deadline' | 'shutdown'; message: string;
  routine?: AssignmentRoutineOrigin;
  unresolvedReview?: { at: number; deviceId: string };
  connectionGeneration?: string; hostId?: string; runId?: string; sessionKey?: string; nativeSessionId?: string;
  nativeTools?: string[];
  terminal?: { status: 'ok' | 'error'; turnId: string; provider: string; model: string; stopReason?: string };
  failedExecution?: { endedAt: number; stopReason?: string };
  result?: { file: Attachment; preview: string; previewTruncated: boolean; disposition: 'visible' | 'silent' | 'empty' };
};
export const assignmentHoldsSlot = (attempt: Pick<AssignmentAttempt, 'state' | 'unresolvedReview'>) => !assignmentTerminal(attempt.state) && !attempt.unresolvedReview;
export type AssignmentCapture = { plan: Entity<Assignment>; agent: Entity<AgentDesign>; project: Entity<Project> | null; sources: { kind: 'contact' | 'content'; record: Entity<Contact | Content> }[]; files?: { file: Attachment; origins: string[]; text: string }[]; binaryFiles?: { file: Attachment; origins: string[] }[]; omittedFiles?: {file:Attachment;reason:string}[] };
export type AssignmentState = { attempts: AssignmentAttempt[]; canStart: boolean; reason: string; nextCursor: string | null };
