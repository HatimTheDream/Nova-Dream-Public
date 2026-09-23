import type { AssistantModel, ContextManifest } from './assistant.js';

export type EffortDemand = 'low' | 'medium' | 'high';
export type AutoEffortDecision = {
  policy: 'task-v1'; demand: EffortDemand; level: string | null; model: string | null;
  reason: 'task' | 'capability-unavailable' | 'session-managed' | 'steering';
};

const ranks = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/** Auto is a Nova preference, never a native session setting. */
export const nativeThinking = (preference: string | null | undefined) => preference === 'auto' ? null : preference;
export const autoEffortAvailable = (levels: string[] | undefined) => !!levels?.some(level => ranks.includes(level));
export function responseEffortLevels(levels: string[] | undefined): (string | null)[] {
  const manual = [...new Set(levels ?? [])].filter(level => level !== 'auto' && level !== 'default');
  return [null, ...(autoEffortAvailable(manual) ? ['auto'] : []), ...manual];
}

/** A bounded, local task policy: no model switch or classification request. */
export function taskEffortDemand(input: string, context: Pick<ContextManifest, 'attachments' | 'project' | 'workMode'>, previous?: EffortDemand): EffortDemand {
  const text = input.trim(), files = context.attachments;
  const projectText = [context.project?.purpose, context.project?.instructions].filter(Boolean).join('\n');
  const substantialSources = files.length > 1 || files.some(file => file.size > 16_000) || projectText.length > 1500;
  const demanding = /\b(audit|debug|diagnos\w*|root cause|refactor|architect\w*|migration|migrate|prove|proof|derive|comprehensive|exhaustive|trade[ -]?offs?|security review|race condition)\b/i.test(text);
  const compound = (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm)?.length ?? 0) >= 3;
  if (substantialSources || demanding || compound || text.length > 1200 || context.workMode === 'research') return 'high';
  const continuation = /^(?:(?:yes|okay|ok|please|sure)[,.! ]+)*(?:continue|go ahead|proceed|keep going|do it|finish(?: it)?|implement(?: it| the plan)?|approved?)(?:[.! ]|\bwith\b|\bplease\b|\bthe\b|\bfrom\b|\band\b|$)/i.test(text);
  if (continuation) return previous ?? 'medium';
  if (files.length || projectText.length > 300 || context.workMode === 'plan' || context.workMode === 'goal') return 'medium';
  if (text.length <= 400 && /\b(rewrite|rephrase|translate|shorten|fix (?:the )?(?:typos?|spelling)|capitalize|convert|define|what (?:is|does)|summari[sz]e)\b/i.test(text)) return 'low';
  return 'medium';
}

export function resolveAutoEffort(demand: EffortDemand, modelId: string | null, models: AssistantModel[], effectiveModel?: string): AutoEffortDecision {
  const defaults = models.filter(model => model.isDefault);
  const model = modelId ? models.find(model => model.id === modelId) : effectiveModel ? models.find(model => model.id === effectiveModel) : defaults.length === 1 ? defaults[0] : undefined;
  const levels = model?.available ? [...new Set(model.reasoning ?? [])].filter(level => ranks.includes(level)).sort((a, b) => ranks.indexOf(a) - ranks.indexOf(b)) : [];
  if (!levels.length) return { policy: 'task-v1', demand, level: null, model: model?.id ?? modelId ?? effectiveModel ?? null, reason: 'capability-unavailable' };
  // Prefer the requested level or the next stronger supported level. A model
  // with a smaller ceiling uses its strongest advertised level, never a guess.
  const level = levels.find(value => ranks.indexOf(value) >= ranks.indexOf(demand)) ?? levels.at(-1)!;
  return { policy: 'task-v1', demand, level, model: model!.id, reason: 'task' };
}
