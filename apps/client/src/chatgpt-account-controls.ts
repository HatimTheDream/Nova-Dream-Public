import type { ChatGptAccountStatus, ChatGptSignInMethod } from '../../../packages/domain/sign-in';

export type AccountSignInIntent = { requestId: string; epoch: string; method?: ChatGptSignInMethod; intent?: 'add' | 'reconnect'; profileId?: string };
export type AccountOrderIntent = { requestId: string; epoch: string; profileIds: string[] };
// These service rejections occur before admission. Timeouts and host/order uncertainty retain the exact request.
export const accountIntentWasNotAdmitted = (code: string) => ['validation', 'signin_closed', 'signin_active', 'signin_process_present', 'account_order_unavailable', 'account_order_busy', 'account_order_membership'].includes(code);
export function keepSignInIntent(kept: AccountSignInIntent | undefined, next: Omit<AccountSignInIntent, 'requestId'>, requestId: () => string): AccountSignInIntent {
  if (!kept) return { ...next, requestId: requestId() };
  if (kept.epoch !== next.epoch || (kept.intent ?? 'add') !== next.intent || kept.profileId !== next.profileId || (kept.method ?? 'device-code') !== next.method) throw new Error('Resume the earlier sign-in before starting another.');
  return kept;
}
export function accountOrder(status?: ChatGptAccountStatus): string[] {
  const accounts = status?.accounts ?? [], known = new Set(accounts.map(account => account.profileId));
  return [...new Set([...(status?.order ?? []), ...accounts.map(account => account.profileId)])].filter(id => known.has(id));
}
export function moveAccount(order: string[], profileId: string, destination: number): string[] {
  const source = order.indexOf(profileId);
  if (source < 0 || destination < 0 || destination >= order.length) return order;
  const next = order.filter(id => id !== profileId); next.splice(destination, 0, profileId); return next;
}
export function remainingAllowance(used: number | null | undefined): number | null {
  return typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null;
}
export const allowanceLabel = (label: string) => label === '5h' ? '5-Hour Allowance' : ['7d', '168h', 'Week'].includes(label) ? 'Weekly Allowance' : label === '24h' ? 'Daily Allowance' : label;
const healthLabels: Record<string, string> = { ready: 'Connected', cooldown: 'Temporarily Unavailable', reconnect: 'Reconnect Needed', unknown: 'Not Confirmed' };
export const accountHealth = (health: string) => healthLabels[health] ?? 'Not Confirmed';
export const accountTime = (time: number | null | undefined) => typeof time === 'number' && Number.isFinite(time) ? new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
