import { z } from 'zod';

export const importMaxBytes = 32 * 1024 * 1024;
export const novaImportSnapshotSchema = z.object({ format: z.literal(1), id: z.string().regex(/^backup:[a-f0-9-]{36}$/), schemaVersion: z.literal(15), appVersion: z.string().min(1).max(40), createdAt: z.string().datetime(), kind: z.enum(['manual', 'automatic', 'before_restore']), tables: z.record(z.string().regex(/^[a-z_]+$/), z.object({ columns: z.array(z.string().max(100)).max(80), rows: z.array(z.array(z.unknown()).max(80)).max(100000) }).strict()) }).strict();
export const importSourceSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('dream-claw-storage-1'), appVersion: z.literal('0.57.2'), storeId: z.string().uuid(), createdAt: z.string().datetime(), timezone: z.string().min(1).max(80), storage: z.record(z.string().max(200), z.string().max(importMaxBytes)) }).strict(),
  z.object({ format: z.literal('nova-dream-backup-15'), storeId: z.string().uuid(), timezone: z.string().min(1).max(80), snapshot: novaImportSnapshotSchema }).strict(),
]);
export type ImportSource = z.infer<typeof importSourceSchema>;
export type ImportItem = { source: string; sourceId: string; title: string; outcome: 'editable' | 'preserved' | 'linked'; targetId?: string; targetKind?: string; notes: string[] };
export type ImportReview = { id: string; source: 'Dream Claw' | 'Nova Dream'; version: string; createdAt: string; sourceHash: string; targetHash: string; timezone: string; items: ImportItem[]; counts: { editable: number; preserved: number; linked: number }; duplicates: string[][]; notes: string[]; restoreId?: string; savedInWorkspace?: boolean; priorProgress?: { name: string; xp: number; ledgerEvents: number; ledgerTotal: number; carried?: true } };
export const importReviewCommand = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), source: importSourceSchema }).strict();
export const importRestoreCommand = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), reviewId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), targetHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function importGroupLabel(group: string) {
  const labels: Record<string,string> = { agent_blueprint_versions:'Agent instruction history',agent_blueprints:'Agent instructions',chat_custody:'Retained conversations',chat_custody_identities:'Conversation identities',chat_projects:'Projects',core_records:'Saved work',home_layouts:'Home layout',idempotency:'Earlier operations',ordinary_task_occurrence_revisions:'Task occurrence history',ordinary_task_occurrences:'Task occurrences',profiles:'Profiles and characters',project_source_identities:'Source identities',project_source_libraries:'Project libraries',project_sources:'Project sources',task_daily_revisions:'Daily task history',task_days:'Daily plans',task_occurrences:'Habit outcomes',task_reminder_deliveries:'Reminder history',task_revisions:'Task history',task_schedule_revisions:'Schedule history',task_schedules:'Task schedules',team_runs:'Earlier agent work',voice_recovery:'Saved voice calls',voice_recovery_identities:'Voice identities',xp_events:'XP history' };
  return labels[group] ?? group.replace(/[_:-]+/g,' ');
}
