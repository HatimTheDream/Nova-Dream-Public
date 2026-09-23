import { z } from 'zod';
import { assistantRequestSchema } from './assistant.js';

const questionId = z.string().regex(/^[a-z][a-z0-9_]*$/).max(100);
const secretStore = z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), kind: z.literal('secret'), allowedHosts: z.array(z.string().min(1).max(253)).max(128).optional(), reason: z.string().max(200).optional() }).strict();
export const questionPromptSchema = z.object({
  questionId, header: z.string().max(12), question: z.string().min(1).max(30000),
  options: z.array(z.object({ label: z.string().min(1).max(4000), description: z.string().max(8000).optional() }).strict()).max(4),
  multiSelect: z.boolean().optional(), isOther: z.boolean().optional(), isSecret: z.boolean().optional(), secretStore: secretStore.optional(),
  secretStoreExisting: z.object({ updatedAtMs: z.number().int().nonnegative(), updatedBy: z.string().max(500).optional() }).optional(),
}).strict();
export const questionAnswersSchema = z.record(questionId, z.array(z.string().max(65536)).min(1).max(8));
export const nativeQuestionSchema = z.object({
  id: z.string().min(1).max(500), questions: z.array(questionPromptSchema).min(1).max(3),
  sessionKey: z.string().min(1).max(2000), agentId: z.string().max(500).optional(), runId: z.string().max(500).optional(),
  createdAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().nonnegative(),
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']), answers: z.object({ answers: questionAnswersSchema }).optional(),
}).refine(value => new Set(value.questions.map(q => q.questionId)).size === value.questions.length, 'Question identifiers must be unique.').refine(value => value.questions.every(q => q.options.length !== 1 && new Set(q.options.map(o => o.label.trim().toLowerCase())).size === q.options.length && (!q.isSecret && !q.secretStore || q.isSecret && q.secretStore && value.questions.length === 1 && q.options.length === 0 && !q.multiSelect)), 'The question format is unsupported.').refine(value => (value.status === 'answered') === !!value.answers, 'The question outcome is incomplete.');
export type QuestionPrompt = z.infer<typeof questionPromptSchema>;
export type NativeQuestion = z.infer<typeof nativeQuestionSchema>;
export type QuestionAnswers = z.infer<typeof questionAnswersSchema>;
export const resolveQuestionSchema = assistantRequestSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().positive(), answers: questionAnswersSchema.optional(), cancel: z.literal(true).optional() }).strict().refine(input => !!input.answers !== !!input.cancel, 'Submit answers or cancel this request.');
export const checkQuestionSchema = assistantRequestSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const dismissQuestionSchema = checkQuestionSchema.extend({ expectedRevision: z.number().int().positive() }).strict();
export type AssistantQuestion = {
  id: string; revision: number; epoch: string; connectionGeneration: string; conversationId: string; nativeId: string; nativeKey: string;
  snapshot: NativeQuestion; fingerprint: string; availability: 'live' | 'missing'; dismissed?: boolean;
  /** First observed terminal outcome of a previously pending request, not a provider timestamp. */
  resolvedAtMs?: number;
  action?: { requestId: string; kind: 'answer' | 'cancel'; state: 'sending' | 'unknown' | 'confirmed'; answerHash?: string; message?: string };
};
export type QuestionState = { state: 'unavailable' | 'connecting' | 'ready' | 'error'; message?: string; items: AssistantQuestion[] };

/** Mirror the native canonicalization without trimming secret bytes. */
export function canonicalQuestionAnswers(questions: QuestionPrompt[], input: QuestionAnswers): QuestionAnswers {
  if (Object.keys(input).some(id => !questions.some(q => q.questionId === id))) throw new Error('An answer belongs to a different question.');
  const result: QuestionAnswers = {};
  for (const q of questions) {
    const values = input[q.questionId];
    if (!values?.length || !q.multiSelect && values.length !== 1 || values.some(value => q.isSecret ? !value.length : !value.trim())) throw new Error('Answer each question before submitting.');
    result[q.questionId] = values.map(value => q.isSecret ? value : q.options.find(o => o.label.trim() === value.trim())?.label ?? value.trim());
    if (!q.isSecret && q.options.length && !q.isOther && result[q.questionId].some(value => !q.options.some(o => o.label === value))) throw new Error('Choose one of the available answers.');
  }
  return result;
}
export function safeQuestionSnapshot(record: NativeQuestion): NativeQuestion {
  if (!record.questions.some(q => q.isSecret)) return record;
  return { ...record, ...(record.status === 'answered' ? { answers: { answers: { [record.questions[0].questionId]: ['stored'] } } } : { answers: undefined }) };
}
