import type { AssistantOperation } from './assistant.js';
import type { AssistantPlan, PlanProposal } from './assistant-plan.js';
import type { AssistantQuestion } from './questions.js';
import type { RunStep } from './run-plan.js';
import { toolDisplayInput, type ToolActivity } from './tool-activity.js';
import { researchEstimateFraction, researchEstimateSchema, type ResearchEstimate } from './research-estimate.js';

export type ResearchProgressState = 'idle' | 'live' | 'waiting' | 'paused' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type ResearchProgress = {
  steps: { id: string; label: string; detail: string; status: RunStep['status']; reported: boolean }[];
  /** Broad milestone rows are independent from the task-specific effort estimate. */
  completedMilestones: number; totalMilestones: number; fraction: number | null; estimateBasis?: string;
  status: string; statusSource: 'lifecycle' | 'question' | 'detail' | 'tool' | 'estimate' | 'milestone' | 'fallback';
  state: ResearchProgressState; live: boolean;
};
type Input = { item: AssistantPlan; operation?: AssistantOperation; connected: boolean; questions?: AssistantQuestion[]; now?: number };
const normalized = (label: string) => label.trim().replace(/\s+/g, ' ');
const terminal = new Set(['completed', 'failed', 'cancelled']);
const nativeName = (name: string) => name.split(/__|\./).at(-1) ?? name;
const progressTool = (name: string) => ['update_plan', 'progress_card', 'nova_research_progress'].includes(nativeName(name));
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

function matchingEstimate(operation?: AssistantOperation): ResearchEstimate | undefined {
  const parsed = researchEstimateSchema.safeParse(operation?.researchEstimate), ref = operation?.context.approvedPlan;
  if (!operation || !ref || !operation.nativeRunId || !parsed.success) return;
  const binding = parsed.data.binding;
  if (binding.operationId !== operation.id || binding.epoch !== operation.epoch || binding.nativeRunId !== operation.nativeRunId
    || binding.planId !== ref.id || binding.planVersion !== ref.version || binding.planDigest !== ref.digest) return;
  return parsed.data;
}

const stepAliases = (proposal: PlanProposal) => proposal.steps.map((label, index) => [normalized(label), ...(proposal.stepTitles?.[index] ? [normalized(proposal.stepTitles[index])] : [])]);
function matchedIndex(aliases: string[][], step: RunStep) {
  const label = normalized(step.label), explicit = /^research-step-([1-9]\d*)$/.exec(step.sourceId ?? '');
  if (explicit) { const index = Number(explicit[1]) - 1; return aliases[index]?.includes(label) ? index : -1; }
  const indexes = aliases.flatMap((values, index) => values.includes(label) ? [index] : []);
  return indexes.length === 1 ? indexes[0] : -1;
}
function reportedSteps(proposal?: PlanProposal, plan: RunStep[] = []) {
  if (!proposal) return [];
  const aliases = stepAliases(proposal), matches = aliases.map(() => [] as RunStep[]);
  for (const step of plan) {
    const index = matchedIndex(aliases, step);
    if (index >= 0) matches[index].push(step);
  }
  return matches.map(values => values.length === 1 ? values[0] : undefined);
}

/** A granular runtime update cannot erase already reported approved milestones.
 * Explicit reopened or conflicting rows still supersede earlier completion. */
export function retainResearchMilestones(operation: AssistantOperation, incoming: RunStep[]): RunStep[] {
  const proposal = operation.context.approvedPlan?.proposal;
  if (!proposal || operation.context.researchWorkflow !== 'chat-research-v1' || operation.context.workMode !== 'research' || operation.context.space === 'work' || operation.context.planReview || operation.steerTarget) return incoming;
  const aliases = stepAliases(proposal), prior = reportedSteps(proposal, operation.plan);
  const retained = prior.flatMap((step, index) => step?.status === 'complete' && !incoming.some(next => aliases[index].includes(normalized(next.label)) || matchedIndex(aliases, next) === index) ? [{ ...step, id: `research-retained-${index + 1}` }] : []);
  return retained.length ? [...incoming, ...retained] : incoming;
}

/** Old proposals remain intact; prefer a complete action phrase before falling
 * back to a bounded, explicitly abbreviated label with the full text in details. */
export function researchStepTitle(detail: string, title?: string): string {
  if (title?.trim()) return normalized(title);
  const full = normalized(detail).replace(/^[-*]\s+|^\d+[.)]\s+/, '');
  if (full.length <= 80 && full.split(' ').length <= 10) return full;
  const clause = full.split(/(?:[.!?;](?:\s|$)|\s[—–]\s|:\s)/, 1)[0];
  const action = clause.split(/\s(?:including|covering|focusing on|so that|in order to|with attention to)\s/i, 1)[0].trim();
  if (action.length <= 80 && action.split(' ').length <= 10) return action;
  const words = action.split(' '); let short = '';
  for (const word of words.slice(0, 8)) { if (short.length + word.length + 1 > 76) break; short += `${short ? ' ' : ''}${word}`; }
  return short ? `${short}…` : 'Review research requirements';
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

/** Approved milestone rows plus a separately admitted task-specific effort estimate. */
export function researchProgress({ item, operation: supplied, connected, questions = [], now = Date.now() }: Input): ResearchProgress {
  const proposal = item.versions.find(value => value.version === item.version)?.proposal;
  const operation = matchingResearchOperation(item, supplied), reported = reportedSteps(proposal, operation?.plan);
  const steps: ResearchProgress['steps'] = (proposal?.steps ?? []).map((detail, index) => ({ id: `${item.id}:${item.version}:research-step-${index + 1}`, label: researchStepTitle(detail, proposal?.stepTitles?.[index]), detail, status: reported[index]?.status ?? 'waiting', reported: !!reported[index] }));
  const completedMilestones = steps.filter(step => step.status === 'complete').length, totalMilestones = steps.length;
  const estimate = matchingEstimate(operation), estimateBasis = publicDetail(estimate?.basis);
  const result = (state: ResearchProgressState, status: string, statusSource: ResearchProgress['statusSource'] = 'lifecycle'): ResearchProgress => ({ steps, state, status, statusSource, live: state === 'live', completedMilestones, totalMilestones, fraction: state === 'completed' ? 1 : researchEstimateFraction(estimate), ...(estimateBasis ? { estimateBasis } : {}) });
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
  const estimateActivity = publicDetail(estimate?.activity);
  if (estimateActivity && estimate!.observedSequence >= newestToolSequence && estimate!.observedSequence >= (operation.planSequence ?? -1)) return result('live', estimateActivity, 'estimate');
  // An older plan explanation must not return as "current" after a newer tool
  // completed. There is no trustworthy private reasoning/activity fallback.
  // Current public activity can be finer grained than the approved milestones.
  // Its detail does not establish or change milestone completion.
  const currentActive = (operation.plan ?? []).filter(step => step.status === 'active');
  if (currentActive.length === 1 && (operation.planSequence ?? -1) >= newestToolSequence) {
    const detail = publicDetail(currentActive[0].detail) ?? publicDetail(currentActive[0].explanation);
    if (detail) return result('live', detail, 'detail');
  }
  const active = reported.filter((step): step is RunStep => step?.status === 'active');
  if (active.length === 1) return result('live', publicDetail(active[0].label) ?? 'Researching…', 'milestone');
  return result('live', operation.state === 'prepared' || operation.state === 'dispatching' ? 'Starting research…' : totalMilestones > 0 && completedMilestones === totalMilestones ? 'Waiting for the finished report…' : 'Researching…', 'fallback');
}
