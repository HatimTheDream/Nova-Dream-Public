import { z } from 'zod';

const id = z.string().min(1).max(500);
const scopeSchema = z.object({
  epoch: id, deviceId: id, windowId: id, draftId: id,
  conversationId: id.nullable(), space: z.enum(['chat', 'work']),
}).strict();
export type ProjectManagerScope = z.infer<typeof scopeSchema>;
export const projectManagerRequestSchema = z.object({
  requestId: z.string().uuid(),
  target: z.union([
    z.object({ kind: z.literal('list') }).strict(),
    z.object({ kind: z.literal('project'), id, tab: z.enum(['overview', 'sources', 'settings']).optional() }).strict(),
    z.object({ kind: z.literal('create'), space: z.enum(['chat', 'work']) }).strict(),
  ]),
}).strict();
export type ProjectManagerRequest = z.infer<typeof projectManagerRequestSchema>;
const viewSchema = z.object({
  format: z.literal(1), scope: scopeSchema, revision: z.number().int().nonnegative(),
  requestId: z.string().uuid().optional(),
  filter: z.enum(['all', 'chat', 'work', 'deleted']),
  selected: z.union([
    z.object({ kind: z.literal('list') }).strict(),
    z.object({ kind: z.literal('project'), id, tab: z.enum(['overview', 'sources', 'settings']) }).strict(),
    z.object({ kind: z.literal('create'), space: z.enum(['chat', 'work']), stage: z.enum(['details', 'instructions', 'review']) }).strict(),
  ]),
}).strict();
export type ProjectManagerView = z.infer<typeof viewSchema>;
export type ProjectManagerSelection = ProjectManagerView['selected'];
export type ProjectSetupStage = Extract<ProjectManagerSelection, { kind: 'create' }>['stage'];
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export type ProjectManagerOwner = { key: string; raw: string | null; view: ProjectManagerView };
const sameScope = (a: ProjectManagerScope, b: ProjectManagerScope) => Object.keys(a).every(k => a[k as keyof ProjectManagerScope] === b[k as keyof ProjectManagerScope]);

export function readProjectManager(scope: ProjectManagerScope, io: Storage = localStorage): ProjectManagerOwner {
  scopeSchema.parse(scope);
  const key = `e3:project-manager:${scope.deviceId}:${scope.windowId}:${scope.space}:${scope.draftId}`;
  const raw = io.getItem(key);
  if (raw === null) return { key, raw, view: { format: 1, scope, revision: 0, filter: 'all', selected: { kind: 'list' } } };
  if (raw.length > 16_384) throw Error('The kept Projects view needs recovery. Its original reference is unchanged.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw Error('The kept Projects view could not be read. Its original reference is unchanged.'); }
  const result = viewSchema.safeParse(parsed);
  if (!result.success || !sameScope(result.data.scope, scope)) throw Error('The kept Projects view belongs to another workspace or could not be verified. Its original reference is unchanged.');
  return { key, raw, view: result.data };
}

/** Only view identity lives here. Project writing stays in its existing journal. */
export function keepProjectManager(owner: ProjectManagerOwner, next: Pick<ProjectManagerView, 'selected' | 'filter'> & { requestId?: string }, io: Storage = localStorage): ProjectManagerOwner {
  if (io.getItem(owner.key) !== owner.raw) throw Error('This Projects view changed in another window. Reopen it before continuing; your writing is kept.');
  const view = viewSchema.parse({ ...owner.view, ...next, revision: owner.view.revision + 1 });
  const raw = JSON.stringify(view);
  if (raw.length > 16_384) throw Error('The Projects view is too large to keep.');
  io.setItem(owner.key, raw);
  if (io.getItem(owner.key) !== raw) throw Error('The Projects view could not be kept. Free browser storage before leaving this view.');
  return { key: owner.key, raw, view };
}

export function requestProjectManager(owner: ProjectManagerOwner, request: ProjectManagerRequest, io: Storage = localStorage) {
  const checked = projectManagerRequestSchema.parse(request);
  if (owner.view.requestId === checked.requestId) return owner;
  const selected: ProjectManagerSelection = checked.target.kind === 'create'
    ? { ...checked.target, stage: 'details' }
    : checked.target.kind === 'project' ? { ...checked.target, tab: checked.target.tab ?? 'overview' } : checked.target;
  return keepProjectManager(owner, { selected, filter: owner.view.filter, requestId: checked.requestId }, io);
}
