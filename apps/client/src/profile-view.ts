import { z } from 'zod';
export const profileViewSchema = z.object({ format: z.literal(1), tab: z.enum(['studio', 'quests', 'milestones', 'history']), focusedId: z.uuid().nullable(),
  cadence: z.enum(['daily', 'weekly']), questFilter: z.enum(['active', 'completed', 'archived']), reviewId: z.uuid().nullable()
}).strict();
export type ProfileView = z.infer<typeof profileViewSchema>;
export const emptyProfileView: ProfileView = { format: 1, tab: 'studio', focusedId: null, cadence: 'daily', questFilter: 'active', reviewId: null };
export const isProfileView = (value: unknown): value is ProfileView => profileViewSchema.safeParse(value).success;
