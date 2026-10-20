import { z } from 'zod';
import { profileWeekIdentitySchema, shiftProfileDay } from '../../../packages/domain/profile-week';
import { localDate } from '../../../packages/domain/tasks';
import { readProfileSlot, type ProfileSlot, type ProfileStorage } from './profile-kept-state';
const legacyProfileViewSchema = z.object({ format: z.literal(1), tab: z.enum(['studio', 'quests', 'milestones', 'history']), focusedId: z.uuid().nullable(),
  cadence: z.enum(['daily', 'weekly']), questFilter: z.enum(['active', 'completed', 'archived']), reviewId: z.uuid().nullable()
}).strict();
export const profileViewSchema = legacyProfileViewSchema.omit({ format: true, tab: true }).extend({
  format: z.literal(2), tab: z.enum(['studio', 'quests', 'week', 'milestones']),
  week: profileWeekIdentitySchema.nullable(), day: localDate.nullable(), weekSection: z.enum(['week', 'history']),
  historyCount: z.number().int().min(0).max(1000000), weekScroll: z.number().finite().min(0), historyScroll: z.number().finite().min(0)
}).strict().refine(value => value.day === null || !!value.week && value.day >= value.week.start && value.day < shiftProfileDay(value.week.start, 7), 'Keep the selected day inside its original week.');
export type ProfileView = z.infer<typeof profileViewSchema>;
export const emptyProfileView: ProfileView = { format: 2, tab: 'studio', focusedId: null, cadence: 'daily', questFilter: 'active', reviewId: null, week: null, day: null, weekSection: 'week', historyCount: 0, weekScroll: 0, historyScroll: 0 };
export const isProfileView = (value: unknown): value is ProfileView => profileViewSchema.safeParse(value).success;
export function readProfileViewSlot(storage: ProfileStorage, key: string): ProfileSlot<ProfileView> {
  type Kept = ProfileView | z.infer<typeof legacyProfileViewSchema>;
  const slot = readProfileSlot<Kept>(storage, key, emptyProfileView, (value): value is Kept => isProfileView(value) || legacyProfileViewSchema.safeParse(value).success);
  if (slot.value.format === 2) return slot as ProfileSlot<ProfileView>;
  const old = slot.value;
  return { ...slot, value: { ...emptyProfileView, ...old, format: 2, tab: old.tab === 'history' ? 'week' : old.tab, weekSection: old.tab === 'history' ? 'history' : 'week' } };
}
