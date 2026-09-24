import { z } from 'zod';

const serviceInfoSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/),
  state: z.enum(['unconfigured', 'connecting', 'ready', 'disconnected', 'pairing', 'error', 'unavailable']),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/).optional().catch(undefined),
});
export type AgentServiceInfo = z.infer<typeof serviceInfoSchema>;

/** Public adapter metadata only. A disconnected host has no current version. */
export function agentServiceInfo(value: unknown): AgentServiceInfo {
  const parsed = serviceInfoSchema.safeParse(value);
  if (!parsed.success) return { id: 'unknown', name: 'Agent service', state: 'unavailable' };
  const { version, ...info } = parsed.data;
  return info.state === 'ready' && version ? { ...info, version } : info;
}
