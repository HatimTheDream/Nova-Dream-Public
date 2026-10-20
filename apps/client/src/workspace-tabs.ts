import { z } from 'zod';
import { projectManagerRequestSchema } from './project-manager-view';
import { attachmentSchema } from '../../../packages/domain/attachments';
const viewSchema = z.union([
  z.object({ kind: z.literal('projects'), request: projectManagerRequestSchema.optional() }).strict(),
  z.object({ kind: z.enum(['home', 'files', 'changes', 'live', 'browser', 'team', 'history', 'cleanup']) }).strict(),
  z.object({ kind: z.literal('file'), file: attachmentSchema, outputId: z.string().optional(), outputVersion: z.number().int().positive().optional(), returnTabId: z.string().min(1).max(240).refine(id => id === 'projects' || id === 'files' || id === 'sources:next' || id.startsWith('sources:reply:') && id.length > 14).optional(), returnProjectId: z.string().min(1).max(200).optional() }).strict().refine(view => view.returnTabId === 'projects' ? !!view.returnProjectId : !view.returnProjectId),
  z.object({ kind: z.literal('sources'), operationId: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal('plan'), planId: z.string().min(1).max(200) }).strict(),
]);
export type WorkspaceView = z.infer<typeof viewSchema>;
export type WorkspaceTab = { id: string; view: WorkspaceView };
export type WorkspaceTabs = { tabs: WorkspaceTab[]; active: string; visible: boolean; expanded: boolean };
export const viewId = (view: WorkspaceView) => view.kind === 'file' ? `file:${view.file.id}:${view.file.sha256}` : view.kind === 'plan' ? `plan:${view.planId}` : view.kind === 'sources' ? view.operationId ? `sources:reply:${view.operationId}` : 'sources:next' : view.kind;
export const viewTitle = (view: WorkspaceView) => view.kind === 'file' ? view.file.name : view.kind === 'plan' ? 'Plan' : view.kind === 'sources' ? view.operationId ? 'Captured Sources' : 'Message Context' : ({ home: 'Workspace', files: 'Files', changes: 'Review', live: 'Live View', browser: 'Browser', team: 'Team Work', history: 'Run History', cleanup: 'Conversation Cleanup', projects: 'Projects' })[view.kind];
export const emptyWorkspace = (): WorkspaceTabs => ({ tabs: [{ id: 'home', view: { kind: 'home' } }], active: 'home', visible: false, expanded: false });
export function restoreWorkspace(value: unknown): WorkspaceTabs {
  const parsed = z.object({ tabs: z.array(z.object({ id: z.string(), view: viewSchema }).strict()).max(100), active: z.string(), visible: z.boolean(), expanded: z.boolean() }).strict().safeParse(value);
  if (!parsed.success || !parsed.data.tabs.length) return emptyWorkspace();
  const tabs = parsed.data.tabs;
  if (new Set(tabs.map(tab => tab.id)).size !== tabs.length || tabs.some(tab => tab.id !== viewId(tab.view)) || !tabs.some(tab => tab.id === parsed.data.active)) return emptyWorkspace();
  // Restore available tabs without covering a newly opened conversation automatically.
  return { ...parsed.data, visible: false };
}
export type WorkspaceAction = { type: 'open'; view: WorkspaceView } | { type: 'select' | 'close'; id: string } | { type: 'visibility'; visible: boolean } | { type: 'expand'; expanded: boolean };
export function workspaceTabs(state: WorkspaceTabs, action: WorkspaceAction): WorkspaceTabs {
  if (action.type === 'visibility') return { ...state, visible: action.visible };
  if (action.type === 'expand') return { ...state, expanded: action.expanded };
  if (action.type === 'select') return state.tabs.some(tab => tab.id === action.id) ? { ...state, active: action.id, visible: true } : state;
  if (action.type === 'open') {
    const id = viewId(action.view), existing = state.tabs.some(tab => tab.id === id);
    const tabs = existing ? state.tabs.map(tab => tab.id === id ? { id, view: action.view } : tab) : state.active === 'home' ? state.tabs.map(tab => tab.id === 'home' ? { id, view: action.view } : tab) : [...state.tabs, { id, view: action.view }];
    return { ...state, tabs, active: id, visible: true };
  }
  const index = state.tabs.findIndex(tab => tab.id === action.id); if (index < 0) return state;
  const tabs = state.tabs.filter(tab => tab.id !== action.id);
  if (!tabs.length) return { ...emptyWorkspace(), visible: state.visible, expanded: state.expanded };
  return { ...state, tabs, active: state.active === action.id ? tabs[Math.min(index, tabs.length - 1)].id : state.active };
}

/** A closed origin stays closed. Never substitute another capture or a new Project view. */
export function filePreviewReturn(state: WorkspaceTabs, view: Extract<WorkspaceView, { kind: 'file' }>): WorkspaceTab | undefined {
  return view.returnTabId ? state.tabs.find(tab => tab.id === view.returnTabId && (tab.view.kind === 'projects' || tab.view.kind === 'files' || tab.view.kind === 'sources')) : undefined;
}
