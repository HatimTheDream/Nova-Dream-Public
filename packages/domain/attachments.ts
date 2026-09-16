import { z } from 'zod';

export const attachmentSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/),
  name: z.string().min(1).max(200), size: z.number().int().nonnegative().max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
