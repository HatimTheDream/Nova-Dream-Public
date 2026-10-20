import { z } from 'zod';
import { canonical } from '../../../packages/domain/contracts';

const uuid = z.string().uuid();
const scopeSchema = z.object({ epoch: uuid, deviceId: uuid, windowId: uuid, originDraftId: z.string().min(1).max(500) }).strict();
const targetSchema = z.object({ groupId: uuid, kind: z.enum(['create', 'group']) }).strict().nullable();
const viewSchema = z.object({ format: z.literal(1), scope: scopeSchema, target: targetSchema }).strict();
export type GroupViewScope = z.infer<typeof scopeSchema>;
export type GroupViewTarget = z.infer<typeof targetSchema>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export type GroupViewOwner = { key: string; raw: string | null; view: z.infer<typeof viewSchema> };
export function readGroupView(scope: GroupViewScope, storage: StoragePort): GroupViewOwner {
  scopeSchema.parse(scope);
  const key = `e3:group-view:${scope.deviceId}:${scope.epoch}:${scope.windowId}:${scope.originDraftId}`;
  const raw = storage.getItem(key);
  if (raw === null) return { key, raw, view: { format: 1, scope, target: null } };
  if (raw.length > 4096) throw Error('The kept Group view could not be read. Its original reference is unchanged.');
  const view = viewSchema.parse(JSON.parse(raw));
  if (canonical(view.scope) !== canonical(scope)) throw Error('The kept Group view belongs to another conversation.');
  return { key, raw, view };
}
export function keepGroupView(owner: GroupViewOwner, target: GroupViewTarget, storage: StoragePort): GroupViewOwner {
  if (storage.getItem(owner.key) !== owner.raw) throw Error('The Group view changed elsewhere. Keep this window open.');
  const view = viewSchema.parse({ ...owner.view, target }), raw = JSON.stringify(view);
  storage.setItem(owner.key, raw);
  if (storage.getItem(owner.key) !== raw) throw Error('The Group view could not be kept. Your conversation is unchanged.');
  return { key: owner.key, raw, view };
}
