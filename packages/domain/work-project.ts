import { z } from 'zod';
export const workProjectDiffSchema = z.object({
  sessionKey: z.string(), root: z.string().optional(), branch: z.string().optional(), baseRef: z.string().optional(),
  files: z.array(z.object({ path: z.string().max(8000), oldPath: z.string().optional(), status: z.enum(['added','modified','deleted','renamed']), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), patch: z.string().max(1024*1024).optional(), binary: z.boolean().optional(), untracked: z.boolean().optional(), truncated: z.boolean().optional() })),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), truncated: z.boolean().optional(), unavailableReason: z.enum(['unknown_session','not_git','unknown_commit']).optional(),
});
export type WorkProjectDiff = z.infer<typeof workProjectDiffSchema>;
