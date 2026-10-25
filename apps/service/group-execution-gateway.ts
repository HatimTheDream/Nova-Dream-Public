import { z } from 'zod';
import { chatGptProfileIdSchema } from '../../packages/domain/chatgpt-accounts.js';
import { groupRuntimeAgent } from '../../packages/domain/assistant-group-execution.js';

export const groupNativeKeySchema = z.string().regex(/^agent:edition3-group:e3:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
export const groupAgentGatewaySchema = z.object({
  sessionKey: groupNativeKeySchema, expectedExistingSessionId: z.string().uuid(),
  expectedExistingSessionLifecycleRevision: z.string().trim().min(1).max(512).nullable(),
  idempotencyKey: z.string().uuid(), promptMode: z.literal('minimal'),
  bootstrapContextMode: z.literal('lightweight'), deliver: z.literal(false),
  extraSystemPrompt: z.string().min(1).max(120000),
  message: z.string().min(1).max(250000).startsWith('Owner message:\n'),
  attachments: z.array(z.never()).length(0),
}).strict();
export function isGroupGatewayRequest(method: string, params: unknown) {
  const value = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  return method === 'e3.group.policy' || method === 'e3.accounts.group-profile' || method === 'e3.accounts.group-identity'
    || [value.key, value.sessionKey, value.nativeKey].some(key => typeof key === 'string' && key.startsWith('agent:edition3-group:'));
}
/** Literal Group branch only. In particular no generic chat.send, patch, fork,
 * commands, tool additions, arbitrary agent IDs or personal native keys. */
export function assertGroupGatewayRequest(method: string, params: unknown) {
  if (method === 'agent') return groupAgentGatewaySchema.parse(params);
  if (method === 'e3.group.policy') return z.object({
    epoch: z.string().uuid(), nativeKey: groupNativeKeySchema, nativeId: z.string().uuid().nullable(),
  }).strict().parse(params);
  if (method === 'e3.accounts.group-profile' || method === 'e3.accounts.group-identity') return z.object({
    epoch: z.string().uuid(), agentId: z.literal(groupRuntimeAgent), profileId: chatGptProfileIdSchema,
  }).strict().parse(params);
  if (method === 'sessions.create') return z.object({
    key: groupNativeKeySchema, idempotencyKey: z.string().uuid(),
    model: z.string().max(1024).regex(/^openai\/[^\s@]+@openai:[A-Za-z0-9_.@+-]+$/),
    permissionMode: z.literal('read-only'), emitCommandHooks: z.literal(false),
  }).strict().parse(params);
  if (method === 'chat.history') return z.object({
    sessionKey: groupNativeKeySchema, limit: z.literal(1), maxChars: z.literal(1000),
  }).strict().parse(params);
  if (method === 'chat.abort') return z.object({
    sessionKey: groupNativeKeySchema, runId: z.string().uuid(), preserveSideRuns: z.literal(true),
  }).strict().parse(params);
  throw Error('This operation is unavailable for the original Group child.');
}
