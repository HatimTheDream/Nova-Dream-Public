import { z } from 'zod';
import { mailCalendarSourceSchema } from '../../../packages/domain/calendar-followups';
import { readLocal, saveLocal } from './api';
export const inboxTargetSchema = z.object({ nonce: z.uuid(), epoch: z.uuid(), eventId: z.uuid().optional(), messageId: z.string().min(1).max(2048).optional(), source: mailCalendarSourceSchema }).strict();
export type InboxTarget = z.infer<typeof inboxTargetSchema>;
export const inboxTargetKey = (deviceId: string, windowId: string) => `e3:inbox-target:${deviceId}:${windowId}`;
export function keepInboxTarget(deviceId: string, windowId: string, value: Omit<InboxTarget, 'nonce'>) {
  const target = inboxTargetSchema.parse({ ...value, nonce: crypto.randomUUID() });
  if (!saveLocal(inboxTargetKey(deviceId, windowId), target)) throw new Error('Free browser storage before opening this email. Your saved source and writing are kept.');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('e3:inbox-target'));
  return target;
}
export function readInboxTarget(deviceId: string, windowId: string, previousWindowId?: string): InboxTarget | undefined {
  const key = inboxTargetKey(deviceId, windowId);
  let previous = false; try { previous = localStorage.getItem(key) === null; } catch { /* Current in-memory work remains available. */ }
  const value = readLocal(key) ?? (previous && previousWindowId ? readLocal(inboxTargetKey(deviceId, previousWindowId)) : undefined);
  const result = inboxTargetSchema.safeParse(value); return result.success ? result.data : undefined;
}
