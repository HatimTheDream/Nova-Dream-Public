import { z } from 'zod';
import { agentAccessSchema } from './agent-capabilities.js';
import { clockTime, localDate, timezone } from './tasks.js';
import { reminderInstant } from './reminders.js';
import { attachmentSchema } from './attachments.js';
import { mailContactSourceSchema } from './mail-contact.js';
import { keepInTouchSchema, pipelineStages, relationshipSchema } from './crm.js';

// Original DC People/Content fields, Nova saved records and agent identity,
// adapted to the single Nova Dream entity/revision authority.
export const recordKinds = ['contact', 'content', 'agent', 'assignment', 'profile'] as const;
export const recordKindSchema = z.enum(recordKinds);
export type RecordKind = typeof recordKinds[number];
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
const projectId = id.nullable();
const date = z.union([z.literal(''), localDate]);
const title = z.string().trim().min(1).max(240);
const tags = z.array(z.string().trim().min(1).max(60)).max(30).refine(v => new Set(v).size === v.length, 'Use each tag once.');
const appearance = z.record(z.string(), z.unknown()).nullable().refine(v => JSON.stringify(v).length <= 8192, 'Portrait settings are too large.');

export const contactSchema = z.object({
  name: title, position: z.string().max(240), organization: z.string().max(240),
  email: z.union([z.literal(''), z.string().email().max(254)]), phone: z.string().max(80), handle: z.string().max(240),
  timezone, category: z.enum(['internal', 'content', 'external', 'client']), tags,
  notes: z.string().max(20000), projectId, archived: z.boolean(),
  mailSources: z.array(mailContactSourceSchema).max(100).optional(),
  favorite: z.boolean().optional(), otherEmails: z.array(z.email().max(254)).max(100).optional(),
  otherOrganizations: z.array(z.string().trim().min(1).max(240)).max(30).refine(v => new Set(v.map(s => s.toLocaleLowerCase())).size === v.length, 'Use each organization once.').optional(),
  photo: attachmentSchema.nullable().optional(),
  pipelineStage: z.enum(pipelineStages).nullable().optional(),
  keepInTouch: keepInTouchSchema.nullable().optional(),
  relationships: z.array(relationshipSchema).max(100).optional(),
  mergedInto: id.optional(),
}).strict();
export const contentStages = ['ideas', 'drafting', 'review', 'ready', 'published'] as const;
export const contentOutputSourceSchema = z.object({
  kind: z.literal('assistant').optional(),
  outputId: z.string().uuid(), version: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  conversationId: z.string().uuid(), nativeId: z.string().uuid(), messageId: z.string().min(1).max(1000),
  messageHash: z.string().regex(/^[a-f0-9]{64}$/), fileId: id, name: z.string().min(1).max(200), importedText: z.boolean(),
}).strict();
export type ContentOutputSource = z.infer<typeof contentOutputSourceSchema>;
export const contentAssignmentSourceSchema = z.object({
  kind: z.literal('assignment'), attemptId: z.string().uuid(), version: z.literal(1),
  assignmentId: id, assignmentRevision: z.number().int().positive(), agentId: id, agentRevision: z.number().int().positive(),
  runId: z.string().uuid(), nativeId: z.string().uuid(), turnId: z.string().min(1).max(1000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), fileId: id, name: z.string().min(1).max(200), importedText: z.boolean(),
}).strict();
export type ContentAssignmentSource = z.infer<typeof contentAssignmentSourceSchema>;
export const contentFromOutputSchema = z.object({
  requestId: z.string().uuid(), epoch: z.string().uuid(), outputId: z.string().uuid(),
  version: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ContentFromOutputCommand = z.infer<typeof contentFromOutputSchema>;
export const contentFromAssignmentSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), attemptId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ContentFromAssignmentCommand = z.infer<typeof contentFromAssignmentSchema>;
export const contentSchema = z.object({
  title, brief: z.string().max(10000), body: z.string().max(100000), format: z.enum(['markdown', 'text']),
  platform: z.string().trim().min(1).max(100), stage: z.enum(contentStages), plannedDate: date,
  plannedTime: clockTime.optional(), plannedTimezone: timezone.optional(), plannedMinutes: z.number().int().min(5).max(1440).optional(), plannedOverlap: z.enum(['earlier', 'later']).optional(),
  publication: z.object({ kind: z.literal('manual'), date: localDate, note: z.string().trim().min(1).max(2000) }).strict().nullable(),
  projectId, archived: z.boolean(),
  collection: z.string().trim().max(100).optional(), tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  brandId: id.nullable().optional(),
  source: z.union([contentOutputSourceSchema, contentAssignmentSourceSchema]).optional(),
  assets: z.array(attachmentSchema).max(32).refine(v => new Set(v.map(a => a.id)).size === v.length, 'Keep each file once.').optional(),
}).strict().refine(v => v.stage !== 'published' || v.publication !== null, 'Record when and where it was published; a plan is not a publication.').superRefine((value, context) => {
  if (!value.plannedTime) return;
  if (!value.plannedDate || !value.plannedTimezone) { context.addIssue({ code: 'custom', path: ['plannedTime'], message: 'Choose a planned date and timezone for this time.' }); return; }
  const resolution = reminderInstant({ date: value.plannedDate, time: value.plannedTime, timezone: value.plannedTimezone, overlap: value.plannedOverlap });
  if (resolution.instant === null) context.addIssue({ code: 'custom', path: ['plannedTime'], message: resolution.problem === 'overlap' ? 'This clock time occurs twice. Choose the earlier or later occurrence.' : 'This time is skipped when the clock changes. Choose another time.' });
});
export const agentSchema = z.object({
  name: title, position: z.string().trim().min(1).max(240), purpose: z.string().max(10000),
  instructions: z.string().max(20000), knowledge: z.string().max(20000),
  nonGoals: z.string().max(10000), reviewCriteria: z.string().max(10000),
  appearance, archived: z.boolean(), access: agentAccessSchema.optional(),
}).strict();
export const assignmentSourceSchema = z.object({ kind: z.enum(['contact', 'content']), id, revision: z.number().int().positive() }).strict();
export const assignmentSchema = z.object({
  title, brief: z.string().max(20000), expectedOutput: z.string().max(10000),
  agentId: id, agentRevision: z.number().int().positive(), projectId, due: date,
  state: z.enum(['planned', 'cancelled']), archived: z.boolean(),
  sources: z.array(assignmentSourceSchema).max(5).refine(v => new Set(v.map(s => s.id)).size === v.length, 'Choose each source once.').optional(),
  maxMinutes: z.number().int().min(1).max(10).optional(),
  executionMode: z.enum(['work', 'discussion', 'proposal']).optional(),
}).strict();
export const profileSchema = z.object({ name: title, position: z.string().max(240), about: z.string().max(10000), appearance }).strict();
export const recordSchemas = { contact: contactSchema, content: contentSchema, agent: agentSchema, assignment: assignmentSchema, profile: profileSchema };
export type Contact = z.infer<typeof contactSchema>;
export type Content = z.infer<typeof contentSchema>;
export type AgentDesign = z.infer<typeof agentSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type PersonalProfile = z.infer<typeof profileSchema>;
export type RecordValues = { contact: Contact; content: Content; agent: AgentDesign; assignment: Assignment; profile: PersonalProfile };
export type RecordValue = RecordValues[RecordKind];
export const recordOriginSchema = z.object({ kind: z.enum(['contact', 'content', 'assignment']), id, revision: z.number().int().positive() }).strict();
export type RecordOrigin = z.infer<typeof recordOriginSchema>;
export const recordTaskSchema = z.object({ requestId: z.string().uuid(), epoch: z.string().uuid(), origin: recordOriginSchema, title: z.string().trim().min(1).max(300) }).strict();
export type RecordTaskCommand = z.infer<typeof recordTaskSchema>;
export const recordHistorySchema = z.object({ kind: recordKindSchema, id, beforeRevision: z.number().int().positive().optional() }).strict();
export function isRecordKind(kind: string): kind is RecordKind { return (recordKinds as readonly string[]).includes(kind); }
export function recordTitle(value: RecordValue): string { return 'name' in value ? value.name : value.title; }
export function blankRecord(kind: RecordKind, zone: string): RecordValue {
  if (kind === 'contact') return { name: '', position: '', organization: '', email: '', phone: '', handle: '', timezone: zone, category: 'external', tags: [], notes: '', projectId: null, archived: false };
  if (kind === 'content') return { title: '', brief: '', body: '', format: 'markdown', platform: 'Document', stage: 'ideas', plannedDate: '', publication: null, projectId: null, archived: false };
  if (kind === 'agent') return { name: '', position: '', purpose: '', instructions: '', knowledge: '', nonGoals: 'No external sends, publishing, file changes or permission changes.', reviewCriteria: '', appearance: null, archived: false, access: {} };
  if (kind === 'assignment') return { title: '', brief: '', expectedOutput: '', agentId: '', agentRevision: 1, projectId: null, due: '', state: 'planned', archived: false };
  return { name: '', position: '', about: '', appearance: null };
}
