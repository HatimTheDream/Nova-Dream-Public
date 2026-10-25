import { homeReferenceSchema, type HomeReference } from '../../../packages/domain/home-library';
import { homeReferenceKey } from '../../../packages/domain/home-library-view';
import type { Draft, Entity } from '../../../packages/domain/contracts';
import { isSourcePickerView, type SourcePickerView } from './home-source-picker-view';
export { emptySourcePickerView, isSourcePickerView, type SourcePickerView } from './home-source-picker-view';

export const homeIdeas = [
 { id: 'plan-week' as const, category: 'Planning', symbol: '📋', title: 'Plan My Week', summary: 'Turn selected open Tasks and references into a realistic weekly proposal.', explanation: 'Choose a Project, open Tasks and planning hours. Nova prepares a plan in the existing Assistant workflow. It identifies work that may not fit and asks about missing commitments. Calendar changes remain subject to the existing review flow.', outputs: [{ id: 'weekly-plan', title: 'Weekly Plan', detail: 'Priorities and proposed Task times for your review.' }, { id: 'unfinished', title: 'Work That Does Not Fit', detail: 'Unschedulable work, conflicts and questions kept separate.' }], needsTasks: true, needsSources: false, mode: 'plan' as const },
 { id: 'daily-focus' as const, category: 'Planning', symbol: '☀️', title: 'Choose Today’s Focus', summary: 'Find a manageable next step from the Tasks you choose.', explanation: 'Nova compares your selected open Tasks, their deadlines and your directions. The result is a short proposal in Assistant. It does not mark Tasks completed or change your calendar.', outputs: [{ id: 'daily-focus', title: 'Focus List', detail: 'A small, ordered list of selected Tasks.' }, { id: 'questions', title: 'Decisions And Questions', detail: 'Missing context and tradeoffs before committing.' }], needsTasks: true, needsSources: false, mode: 'plan' as const },
 { id: 'research-sources' as const, category: 'Research', symbol: '🔎', title: 'Research My Selected Sources', summary: 'Build a sourced brief around the notes and results you select.', explanation: 'Select the exact Library sources and describe your question. Nova uses the existing Research workflow to prepare a brief with evidence, uncertainty and source links. Review and save the returned result through Assistant.', outputs: [{ id: 'research-brief', title: 'Research Brief', detail: 'A sourced report tied to your selected context.' }, { id: 'open-questions', title: 'Open Questions', detail: 'Uncertainty and useful next investigations.' }], needsTasks: false, needsSources: true, mode: 'research' as const },
 { id: 'draft-notes' as const, category: 'Writing', symbol: '✍️', title: 'Turn My Notes Into A Draft', summary: 'Shape selected notes into a clear draft while keeping their source context.', explanation: 'Choose Library sources and describe the audience or format. Nova prepares a draft in Assistant. The original sources stay intact; you decide what to save or revise.', outputs: [{ id: 'draft', title: 'Complete Draft', detail: 'A proposed text you can review and save.' }, { id: 'editorial-notes', title: 'Editorial Notes', detail: 'Assumptions and suggested revisions.' }], needsTasks: false, needsSources: true, mode: 'chat' as const },
];

export const ideaCategories = ['All Categories', 'Planning', 'Research', 'Writing'] as const;
export type IdeaCategory = typeof ideaCategories[number];
export type IdeasView = 'explore' | 'saved' | 'drafts';
export type IdeaScope = { outputs: string[]; project: string; tasks: string[]; sources: HomeReference[]; instructions: string; from: string; to: string; picker?: SourcePickerView };
export type IdeasViewState = { view: IdeasView; category: IdeaCategory; selected?: string };
export type KeptIdeaScope = { key: string; raw: string | null; value: IdeaScope; invalid: boolean; problem?: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown, limit: number, length: number): value is string[] => Array.isArray(value) && value.length <= limit && value.every(v => typeof v === 'string' && v.length <= length) && new Set(value).size === value.length;
const text = (value: unknown, length: number): value is string => typeof value === 'string' && value.length <= length;
export function isIdeaScope(value: unknown, ideaId: string): value is IdeaScope {
 const idea = homeIdeas.find(i => i.id === ideaId);
 return !!idea && object(value) && strings(value.outputs, 10, 100) && value.outputs.every(id => idea.outputs.some(o => o.id === id)) && text(value.project, 200) && strings(value.tasks, 18, 200) && Array.isArray(value.sources) && value.sources.length + value.tasks.length <= 18 && value.sources.every(r => homeReferenceSchema.safeParse(r).success) && new Set(value.sources.map(r => homeReferenceKey(r as HomeReference))).size === value.sources.length && text(value.instructions, 4000) && text(value.from, 20) && text(value.to, 20) && (value.picker === undefined || isSourcePickerView(value.picker));
}
export function emptyIdeaScope(ideaId: string): IdeaScope {
 const idea = homeIdeas.find(i => i.id === ideaId);
 if (!idea) throw Error('This starter is unavailable.');
 return { outputs: idea.outputs.map(o => o.id), project: '', tasks: [], sources: [], instructions: '', from: '09:00', to: '17:00' };
}
export const ideaScopeKey = (deviceId: string, epoch: string, ideaId: string) => `e3:home-idea-scope:${deviceId}:${epoch}:${ideaId}`;
export function readIdeaScope(storage: Storage, key: string, ideaId: string): KeptIdeaScope {
 const fallback = emptyIdeaScope(ideaId);
 let raw: string | null = null;
 try {
  raw = storage.getItem(key);
  if (raw === null || raw === 'null') return { key, raw, value: fallback, invalid: false };
  const value: unknown = raw.length <= 128000 ? JSON.parse(raw) : undefined;
  if (isIdeaScope(value, ideaId)) return { key, raw, value, invalid: false };
 } catch { /* Keep unknown or unreadable source bytes. */ }
 return { key, raw, value: fallback, invalid: true, problem: 'This kept Idea scope cannot be verified. Its original browser record is preserved. Review the original below before continuing.' };
}
/** Compare before writing: another window's changed scope must never be replaced. */
export function retainIdeaScope(storage: Storage, kept: KeptIdeaScope, value: IdeaScope, ideaId: string): KeptIdeaScope {
 if (kept.invalid || !isIdeaScope(value, ideaId)) throw Error('The Idea scope cannot be kept safely. Its original writing remains unchanged.');
 const raw = JSON.stringify(value);
 const actual = storage.getItem(kept.key);
 // A previous write may have succeeded even when its readback failed. Acknowledge
 // only these exact desired bytes; a different current value is still protected.
 if (actual === raw) return { ...kept, raw, value };
 if (actual !== kept.raw) throw Error('This Idea scope changed in another window. Keep this window open to preserve your newer writing.');
 storage.setItem(kept.key, raw);
 if (storage.getItem(kept.key) !== raw) throw Error('The kept Idea scope changed before confirmation. Keep this window open.');
 return { ...kept, raw, value };
}
export function readIdeasView(storage: Storage, key: string): { value: IdeasViewState; invalid: boolean } {
 const fallback: IdeasViewState = { view: 'explore', category: 'All Categories' };
 try {
  const raw = storage.getItem(key);
  if (raw === null || raw === 'null') return { value: fallback, invalid: false };
  const value: unknown = JSON.parse(raw);
  if (object(value) && ['explore', 'saved', 'drafts'].includes(String(value.view)) && ideaCategories.includes(value.category as IdeaCategory) && (value.selected === undefined || homeIdeas.some(i => i.id === value.selected))) return { value: value as IdeasViewState, invalid: false };
 } catch { /* Preserve an unreadable view without replacing it. */ }
 return { value: fallback, invalid: true };
}
export function savedAssistantDrafts(drafts: Entity<Draft>[]) {
 return drafts.filter(d => !!d.value.text.trim() || d.value.attachments.length > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
