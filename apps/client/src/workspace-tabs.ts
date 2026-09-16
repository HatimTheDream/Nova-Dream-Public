import { z } from 'zod';
import { attachmentSchema } from '../../../packages/domain/attachments';
const viewSchema = z.union([
  z.object({ kind: z.enum(['home', 'files', 'changes', 'live', 'browser', 'team']) }).strict(),
  z.object({ kind: z.literal('file'), file: attachmentSchema, outputId: z.string().optional(), outputVersion: z.number().int().positive().optional() }).strict(),
]);
export type WorkspaceView = z.infer<typeof viewSchema>;
export type WorkspaceTab = { id: string; view: WorkspaceView };
export type WorkspaceTabs = { tabs: WorkspaceTab[]; active: string; visible: boolean; expanded: boolean };
export const viewId = (view: WorkspaceView) => view.kind === 'file' ? `file:${view.file.id}:${view.file.sha256}` : view.kind;
export const viewTitle = (view: WorkspaceView) => view.kind === 'file' ? view.file.name : ({ home: 'New tab', files: 'Files', changes: 'Review', live: 'Live view', browser: 'Browser', team: 'Team work' })[view.kind];
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
