import { z } from 'zod';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
export const directNativeKeySchema = z.string().regex(new RegExp(`^agent:edition3-direct:e3:${uuid}$`, 'i'));
const attachment = z.object({
  type: z.enum(['image', 'file']), fileName: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(200), sizeBytes: z.number().int().nonnegative(),
  content: z.string(),
}).strict();
/** This is the sole ordinary Assistant `agent` RPC shape. Adding that method
 * must not expose an arbitrary agent, command, workspace or delivery route. */
export const directAgentGatewaySchema = z.object({
  sessionKey: directNativeKeySchema, expectedExistingSessionId: z.uuid(),
  expectedExistingSessionLifecycleRevision: z.string().trim().min(1).max(512).nullable(),
  idempotencyKey: z.uuid(), promptMode: z.literal('minimal'),
  bootstrapContextMode: z.literal('lightweight'), deliver: z.literal(false),
  extraSystemPrompt: z.string().min(1).max(120000),
  message: z.string().min(1).max(250000).startsWith('Owner message:\n'),
  attachments: z.array(attachment).max(20),
}).strict();
export function assertDirectGatewayRequest(method: string, params: unknown) {
  if (method === 'agent') directAgentGatewaySchema.parse(params);
  else if (method === 'e3.direct.policy') z.object({
    epoch: z.uuid(), nativeKey: directNativeKeySchema, nativeId: z.uuid().nullable(),
  }).strict().parse(params);
  else if (method === 'e3.accounts.direct-profile') z.object({
    epoch: z.uuid(), agentId: z.literal('edition3-direct'), profileId: z.string().min(1).max(512),
  }).strict().parse(params);
}
