import type { AssistantOperation, ConversationHistory } from '../../../packages/domain/assistant';
import type { AssistantPlan } from '../../../packages/domain/assistant-plan';
import type { AssistantQuestion } from '../../../packages/domain/questions';
import { transcriptParts, type TranscriptMessage } from './voice-transcript';

type Options = { epoch: string; conversationId: string; questions?: AssistantQuestion[]; operations: AssistantOperation[]; plans?: AssistantPlan[]; history?: ConversationHistory };
export const confirmedQuestion = (item: AssistantQuestion) => !item.dismissed && item.snapshot.status !== 'pending' && (!item.action || item.action.state === 'confirmed');

/** A display-only projection of confirmed answers. Original native messages and
 * request identities remain untouched; uncertain requests stay in their tray.
 * Never infer ownership from matching question wording or answer text. */
export function withQuestionReceipts(rows: TranscriptMessage[], options: Options): TranscriptMessage[] {
  const { epoch, conversationId, history } = options;
  if (!history || history.conversationId !== conversationId) return rows;
  const times = history.messages.flatMap(message => message.createdAt && Number.isFinite(Date.parse(message.createdAt)) ? [Date.parse(message.createdAt)] : []);
  const additions = new Map<number, AssistantQuestion[]>();
  const seen = new Set<string>();
  for (const question of options.questions ?? []) {
    if (seen.has(question.id) || !confirmedQuestion(question) || question.epoch !== epoch || question.conversationId !== conversationId) continue;
    seen.add(question.id);
    const time = question.snapshot.createdAtMs;
    // A partial history page must not acquire answers from outside its window.
    if ((history.hasMore && (!times.length || time < Math.min(...times))) || (history.hasNewer && (!times.length || time > Math.max(...times)))) continue;
    const linked = new Set((options.plans ?? []).filter(plan => plan.epoch === epoch && plan.conversationId === conversationId)
      .flatMap(plan => plan.versions.filter(version => version.questionIds?.includes(question.id)).map(version => version.operationId)));
    const candidates = options.operations.filter(operation => operation.epoch === epoch && operation.conversationId === conversationId && !operation.steerTarget
      && operation.nativeId === question.nativeId && operation.nativeKey === question.nativeKey && operation.connectionGeneration === question.connectionGeneration
      && (question.snapshot.runId ? operation.nativeRunId === question.snapshot.runId
        : linked.size ? linked.has(operation.id)
          : time >= Date.parse(operation.createdAt) && time <= Date.parse(operation.settledAt ?? operation.updatedAt)));
    if (candidates.length !== 1) continue;
    const operation = candidates[0];
    const matches = (message: TranscriptMessage) => {
      const source = message.source;
      return (source?.nativeId ?? history.nativeId) === operation.nativeId
        && (!source || source.nativeKey === operation.nativeKey && source.connectionGeneration === operation.connectionGeneration)
        && (message.operationId ? message.operationId === operation.id && (!message.runId || message.runId === operation.nativeRunId)
          : !!message.runId && message.runId === operation.nativeRunId);
    };
    const owned = rows.flatMap((row, index) => (row.workOperation?.id === operation.id || transcriptParts(row).some(matches)) ? [{ row, index }] : []);
    const whole = owned.filter(({ row }) => row.workOperation?.id === operation.id);
    // Prefer the complete turn, before its proven final answer. Split turns can
    // use a dated following assistant message, never a nearby unrelated reply.
    const target = whole.length === 1 ? whole[0] : owned.find(({ row }) => !row.workParts && row.role === 'assistant' && row.createdAt && Date.parse(row.createdAt) >= time);
    if (!target) continue; // Existing conversation history remains the fallback.
    additions.set(target.index, [...(additions.get(target.index) ?? []), question]);
  }
  return rows.map((row, index) => additions.has(index) ? { ...row, questionReceipts: additions.get(index)!.sort((a, b) => a.snapshot.createdAtMs - b.snapshot.createdAtMs || a.id.localeCompare(b.id)) } : row);
}
