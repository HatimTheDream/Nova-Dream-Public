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
  const additions = new Map<TranscriptMessage, AssistantQuestion[]>();
  const after = new Map<TranscriptMessage, AssistantQuestion[]>();
  const trailing = new Map<TranscriptMessage, AssistantQuestion[]>();
  const seen = new Set<string>();
  for (const question of options.questions ?? []) {
    if (seen.has(question.id) || !confirmedQuestion(question) || question.epoch !== epoch || question.conversationId !== conversationId) continue;
    seen.add(question.id);
    const time = question.resolvedAtMs ?? question.snapshot.createdAtMs;
    // A partial history page must not acquire answers from outside its window.
    if ((history.hasMore && (!times.length || time < Math.min(...times))) || (history.hasNewer && (!times.length || time > Math.max(...times)))) continue;
    const linked = new Set((options.plans ?? []).filter(plan => plan.epoch === epoch && plan.conversationId === conversationId)
      .flatMap(plan => plan.versions.filter(version => version.questionIds?.includes(question.id)).map(version => version.operationId)));
    const candidates = options.operations.filter(operation => operation.epoch === epoch && operation.conversationId === conversationId && !operation.steerTarget
      && operation.nativeId === question.nativeId && operation.nativeKey === question.nativeKey && operation.connectionGeneration === question.connectionGeneration
      && (question.snapshot.runId ? operation.nativeRunId === question.snapshot.runId
        : linked.size ? linked.has(operation.id)
          : question.snapshot.createdAtMs >= Date.parse(operation.createdAt) && question.snapshot.createdAtMs <= Date.parse(operation.settledAt ?? operation.updatedAt)));
    if (candidates.length !== 1) continue;
    const operation = candidates[0];
    const matches = (message: TranscriptMessage) => {
      const source = message.source;
      return (source?.nativeId ?? history.nativeId) === operation.nativeId
        && (!source || source.nativeKey === operation.nativeKey && source.connectionGeneration === operation.connectionGeneration)
        && (message.operationId ? message.operationId === operation.id && (!message.runId || message.runId === operation.nativeRunId)
          : !!message.runId && message.runId === operation.nativeRunId);
    };
    const owned = rows.filter(row => row.workOperation?.id === operation.id || transcriptParts(row).some(matches));
    const whole = owned.filter(row => row.workOperation?.id === operation.id);
    const following = question.resolvedAtMs === undefined ? undefined : owned.flatMap(transcriptParts).find(part => matches(part)
      && part.role === 'assistant' && !part.toolInfo && part.createdAt && Date.parse(part.createdAt) >= time);
    // New receipts use the first observation of resolution, not the time the
    // question was asked. Legacy records have no answer-time evidence: retain
    // them before the proven final answer instead of inventing interleaving.
    const final = question.resolvedAtMs !== undefined ? undefined : whole.length === 1 ? whole[0].workFinal : owned.find(row => !row.workParts && matches(row)
      && row.role === 'assistant' && row.text === operation.text && !!row.text.trim() && row.createdAt && Date.parse(row.createdAt) >= time);
    const target = following ?? final;
    if (target) additions.set(target, [...(additions.get(target) ?? []), question]);
    else if (whole.length === 1 && !['completed', 'failed', 'cancelled'].includes(operation.state)) {
      trailing.set(whole[0], [...(trailing.get(whole[0]) ?? []), question]);
    } else if (question.resolvedAtMs !== undefined && ['completed', 'failed', 'cancelled'].includes(operation.state)) {
      const last = owned.flatMap(transcriptParts).findLast(part => matches(part) && part.role === 'assistant' && !part.toolInfo && part.createdAt && Date.parse(part.createdAt) < time);
      if (last) after.set(last, [...(after.get(last) ?? []), question]);
    }
  }
  const ordered = (items: AssistantQuestion[]) => items.sort((a, b) => (a.resolvedAtMs ?? a.snapshot.createdAtMs) - (b.resolvedAtMs ?? b.snapshot.createdAtMs) || a.id.localeCompare(b.id));
  const enrich = (part: TranscriptMessage): TranscriptMessage => additions.has(part) || after.has(part)
    ? { ...part, ...(additions.has(part) ? { questionReceipts: ordered(additions.get(part)!) } : {}), ...(after.has(part) ? { questionReceiptsAfter: ordered(after.get(part)!) } : {}) } : part;
  return rows.map(row => {
    if (!row.workParts) return enrich(row);
    const parts = row.workParts.map(enrich);
    if (!trailing.has(row) && parts.every((part, index) => part === row.workParts![index])) return row;
    return { ...row, workParts: parts, ...(row.workFinal ? { workFinal: parts[row.workParts.indexOf(row.workFinal)] ?? row.workFinal } : {}), ...(trailing.has(row) ? { questionReceipts: ordered(trailing.get(row)!) } : {}) };
  });
}
