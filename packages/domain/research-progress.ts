import type { AssistantOperation } from './assistant.js';
import type { AssistantPlan } from './assistant-plan.js';
import type { AssistantQuestion } from './questions.js';
import type { RunStep } from './run-plan.js';
import { toolDisplayInput, type ToolActivity } from './tool-activity.js';

export type ResearchProgressState = 'idle' | 'live' | 'waiting' | 'paused' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type ResearchProgress = {
  steps: { id: string; label: string; status: RunStep['status']; reported: boolean }[];
  status: string; statusSource: 'lifecycle' | 'question' | 'detail' | 'tool' | 'milestone' | 'fallback';
  state: ResearchProgressState; live: boolean;
};
type Input = { item: AssistantPlan; operation?: AssistantOperation; connected: boolean; questions?: AssistantQuestion[]; now?: number };
const normalized = (label: string) => label.trim().replace(/\s+/g, ' ');
const terminal = new Set(['completed', 'failed', 'cancelled']);
const nativeName = (name: string) => name.split(/__|\./).at(-1) ?? name;
const progressTool = (name: string) => ['update_plan', 'progress_card'].includes(nativeName(name));
const shorten = (value: string, limit = 180) => value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
/** Public progress text only; never scrape tool results or assistant reasoning. */
function publicDetail(value?: string) {
  if (!value) return undefined;
  const text = normalized(value);
  return toolDisplayInput('web_search', { query: text }) ? shorten(text) : undefined;
}

export function matchingResearchOperation(item: AssistantPlan, operation?: AssistantOperation): AssistantOperation | undefined {
  if (!operation || !item.approval || item.kind !== 'research' || item.approval.version !== item.version
    || operation.id !== item.approval.operationId || operation.epoch !== item.epoch || operation.conversationId !== item.conversationId
    || operation.context.researchWorkflow !== 'chat-research-v1' || operation.context.workMode !== 'research' || operation.context.space === 'work'
    || operation.context.planReview || operation.steerTarget) return undefined;
  const version = item.versions.find(value => value.version === item.version), ref = operation.context.approvedPlan;
  if (!version?.proposal || version.digest !== undefined && version.digest !== item.approval.digest || ref && (ref.id !== item.id || ref.version !== item.version || ref.digest !== undefined && ref.digest !== item.approval.digest)) return undefined;
  // Legacy operations without a captured reference still need the exact saved
  // approval-operation binding above. Preparation can never supply activity.
  return operation;
}

function reportedSteps(labels: string[], plan: RunStep[] = []) {
  const matches = labels.map(() => [] as RunStep[]), labelsNormalized = labels.map(normalized);
  for (const step of plan) {
    const label = normalized(step.label), explicit = /^research-step-([1-9]\d*)$/.exec(step.sourceId ?? '');
    if (explicit) {
      const index = Number(explicit[1]) - 1;
      if (labelsNormalized[index] === label) matches[index].push(step);
      continue;
    }
    const index = labelsNormalized.indexOf(label);
    if (index >= 0 && labelsNormalized.lastIndexOf(label) === index) matches[index].push(step);
  }
  return matches.map(values => values.length === 1 ? values[0] : undefined);
}

function toolStatus(tool: ToolActivity): string | undefined {
  const name = nativeName(tool.name);
  const title = publicDetail(tool.title);
  const specificTitle = title && !/^(?:reading (?:a (?:page|source|file)|your workspace|supplied context)|searching(?: the web)?|web[_ -](?:search|fetch)|read(?:[_ -]file)?)[.!…]*$/i.test(title) ? title : undefined;
  if (name === 'web_search') {
    const query = tool.input && toolDisplayInput('web_search', { query: tool.input });
    return query ? `Searching for ${shorten(query, 150)}` : specificTitle ?? 'Searching the web…';
  }
  if (name === 'web_fetch') {
    if (specificTitle) return specificTitle;
    const safe = tool.input && toolDisplayInput('web_fetch', { url: tool.input });
    if (safe) { try { return `Reading ${new URL(safe).hostname.replace(/^www\./, '')}…`; } catch { /* Keep the neutral public label. */ } }
    return 'Reading a source…';
  }
  if (['read', 'read_file'].includes(name)) return specificTitle ?? 'Reading a file…';
  if (name === 'nova_read') return specificTitle ?? 'Reading your workspace…';
  return undefined;
}

/** Stable approved rows plus one observed activity; deliberately no percentage or ETA. */
export function researchProgress({ item, operation: supplied, connected, questions = [], now = Date.now() }: Input): ResearchProgress {
  const proposal = item.versions.find(value => value.version === item.version)?.proposal;
  const operation = matchingResearchOperation(item, supplied), reported = reportedSteps(proposal?.steps ?? [], operation?.plan);
  const steps: ResearchProgress['steps'] = (proposal?.steps ?? []).map((label, index) => ({ id: `${item.id}:${item.version}:research-step-${index + 1}`, label, status: reported[index]?.status ?? 'waiting', reported: !!reported[index] }));
  const result = (state: ResearchProgressState, status: string, statusSource: ResearchProgress['statusSource'] = 'lifecycle'): ResearchProgress => ({ steps, state, status, statusSource, live: state === 'live' });
  if (!item.approval) return result(item.state === 'failed' ? 'failed' : item.state === 'cancelled' ? 'cancelled' : item.state === 'unknown' ? 'unknown' : 'idle', item.state === 'ready' ? 'Ready to research' : item.state === 'failed' ? 'Research needs attention' : item.state === 'cancelled' ? 'Research cancelled' : item.state === 'unknown' ? 'Progress unconfirmed' : 'Preparing your research plan');
  const outcome = operation && terminal.has(operation.state) ? operation.state : terminal.has(item.state) ? item.state : undefined;
  if (outcome === 'completed') return result('completed', 'Research complete');
  if (outcome === 'failed') return result('failed', 'Research interrupted');
  if (outcome === 'cancelled') return result('cancelled', 'Research stopped');
  if (!operation || operation.state === 'unknown' || item.state === 'unknown') return result('unknown', 'Progress unconfirmed');
  if (operation.cancelRequested) return result('stopping', 'Stopping…');
  if (!connected) return result('paused', 'Updates paused');
  const question = questions.find(value => value.epoch === operation.epoch && value.conversationId === operation.conversationId
    && value.nativeKey === operation.nativeKey && value.nativeId === operation.nativeId && value.connectionGeneration === operation.connectionGeneration
    && value.snapshot.sessionKey === operation.nativeKey && !!operation.nativeRunId && value.snapshot.runId === operation.nativeRunId
    && value.snapshot.status === 'pending' && value.availability === 'live' && !value.dismissed && value.snapshot.expiresAtMs > now
    && value.action?.state !== 'confirmed');
  if (question) return result('waiting', question.action?.kind === 'answer' ? question.action.state === 'unknown' ? 'Checking your answer…' : 'Confirming your answer…' : question.action?.kind === 'cancel' ? 'Confirming the question was cancelled…' : 'Waiting for your answer', 'question');
  if (!['prepared', 'dispatching', 'accepted', 'running'].includes(operation.state) || item.state !== 'implementing') return result('unknown', 'Progress unconfirmed');
  const tools = (operation.tools ?? []).filter(tool => !progressTool(tool.name)), newestToolSequence = Math.max(-1, ...tools.map(tool => tool.sequence));
  const running = tools.filter(tool => tool.state === 'running').sort((a, b) => b.sequence - a.sequence);
  for (const tool of running) { const status = toolStatus(tool); if (status) return result('live', status, 'tool'); }
  // An older plan explanation must not return as "current" after a newer tool
  // completed. There is no trustworthy private reasoning/activity fallback.
  const active = reported.filter((step): step is RunStep => step?.status === 'active');
  if (active.length === 1 && (operation.planSequence ?? -1) >= newestToolSequence) {
    const detail = publicDetail(active[0].detail) ?? publicDetail(active[0].explanation);
    if (detail) return result('live', detail, 'detail');
  }
  if (active.length === 1) return result('live', publicDetail(active[0].label) ?? 'Researching…', 'milestone');
  return result('live', operation.state === 'prepared' || operation.state === 'dispatching' ? 'Starting research…' : 'Researching…', 'fallback');
}
